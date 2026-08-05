// booking-admission.js
//
// 单进程、纯内存 FIFO Booking Admission Coordinator。
//
// 设计前提（已确认 AWS 运行环境）：
//   Amazon Lightsail 单实例、单 Node 进程（PM2 fork, instances=1, ktv-server）。
//
// 如果未来出现：Lightsail Load Balancer、第二台官网服务器、PM2 cluster、
// instances > 1、第二个官网 Node 进程、或外部服务直接修改官网 booking 库存，
// 本纯内存方案将失去全局并发保证，必须替换为共享协调器。
//
// 本模块禁止：
//   - require app.js / sqlite3
//   - 读取 database/
//   - 启动 Express
//   - 调用真实 Stripe / Twilio / GHL / AWS
//
// 核心规则：
//   "First valid booking request received by the server wins."
//   - 服务器生成单调递增 arrivalSequence，客户端不能提交或指定。
//   - 逻辑 attempt（bookingAttemptId）的检查先于验证码/限流/INSERT。
//   - 关键区间（验证码 → 限流 → 读取库存 → 冲突计算 → INSERT）整体串行。
//   - 队列超时只能取消尚未开始的 queued 任务，绝不产生"幽灵"写入。
//   - 所有状态只存在 Node 进程内存，进程重启即丢失。

'use strict';

const crypto = require('crypto');

// 标准库存池容量（服务器是库存最终权威）
const ROOM_POOL_CAPACITY = Object.freeze({
    small: 2,
    medium: 1,
    vip: 2
});

// 把任意房间名归一到库存池（Large Room 是 VIP 池的 legacy 映射）
function normalizeRoomPool(room) {
    const name = String(room || '').trim().toLowerCase();
    if (name.includes('small')) return 'small';
    if (name.includes('medium')) return 'medium';
    return 'vip'; // vip / large / 未知房型 → VIP 池
}

// 与前端 parseTimeToNumber 保持一致：'18:00' → 18；'00:00' → 24；'01:30' → 25.5
function parseTimeToNumber(timeStr) {
    const text = String(timeStr || '').trim();
    if (!text) return Number.NaN;
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return Number.NaN;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return Number.NaN;
    }
    if (hours < 12) hours += 24; // 午夜后（00:00–11:59）按当天营业时间延伸
    return hours + (minutes / 60);
}

// 把 booking 行转成半开区间 [start, end)。无法解析或 N/A 时返回 null。
function toHalfOpenInterval(row) {
    const date = String(row && row.date ? row.date : '').trim();
    const time = String(row && row.time ? row.time : '').trim();
    const duration = Number(row && row.duration ? row.duration : 0);
    if (!date || date === 'N/A' || !time || !Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    const start = parseTimeToNumber(time);
    if (!Number.isFinite(start)) return null;
    return { date, start, end: start + duration };
}

// sweep-line 容量检查。
// existing: [{date, start, end}]（半开区间）。proposed: {date, start, end}。
// 返回 true 表示 proposed 覆盖的任一时间分段中，最大同时占用 < capacity。
function isSlotAvailable({ capacity, existing, proposed }) {
    const cap = Number(capacity || 0);
    const start = Number(proposed && proposed.start);
    const end = Number(proposed && proposed.end);
    if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return false;
    }

    const events = [];
    for (const row of existing || []) {
        const s = Number(row.start);
        const e = Number(row.end);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (row.date !== proposed.date) continue; // 只考虑同一日期
        if (e <= start || s >= end) continue; // 半开区间：端点相接不冲突
        events.push({ t: s, delta: 1 });
        events.push({ t: e, delta: -1 });
    }
    events.push({ t: start, delta: 1 }); // 新订单自身占用

    events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta)); // 同刻先处理结束(-1)

    let level = 0;
    for (const ev of events) {
        level += ev.delta;
        if (ev.t >= start && ev.t < end && level > cap) {
            return false;
        }
    }
    return true;
}

// 生成确定性 payload fingerprint（用于 attemptId 幂等校验）
function buildPayloadFingerprint(fields) {
    const parts = (fields || []).map((v) => String(v ?? '').trim());
    return parts.join('|');
}

const RESULT_TTL_MS = 60 * 60 * 1000; // 成功/冲突结果缓存 1 小时
const CACHE_MAX_SIZE = 500;
const QUEUE_WAIT_TIMEOUT_MS = 15 * 1000;

// Queue item 状态机：
//   queued    – 等待执行；可以被 timeout 取消（永不执行 callback）
//   running   – 正在执行；不可取消，调用方必须等待真实结果
//   completed – 执行已结束（成功或失败），不再重跑
//   cancelled – 已被 timeout 取消，_drain 跳过，callback 永不执行
const ITEM_QUEUED = 'queued';
const ITEM_RUNNING = 'running';
const ITEM_COMPLETED = 'completed';
const ITEM_CANCELLED = 'cancelled';

class BookingAdmissionCoordinator {
    constructor(options = {}) {
        this.arrivalSequence = 0;
        this.queue = []; // items: { status, attemptId, task, resolve, reject }
        this.processing = false;
        this.attemptCache = new Map(); // attemptId -> { fingerprint, result, expiresAt }
        this.pendingAttempts = new Map(); // attemptId -> { fingerprint, promise }（执行中 single-flight）
        this.cacheMax = Number(options.cacheMax || CACHE_MAX_SIZE);
        this.resultTtlMs = Number(options.resultTtlMs || RESULT_TTL_MS);
        this.queueWaitTimeoutMs = Number(options.queueWaitTimeoutMs || QUEUE_WAIT_TIMEOUT_MS);
        this.waiters = 0;
    }

    _prune() {
        const now = Date.now();
        // 每次访问都清理已过期条目（不只在超限时清理）
        if (this.attemptCache.size > 0) {
            for (const [key, entry] of this.attemptCache) {
                if (entry.expiresAt <= now) this.attemptCache.delete(key);
            }
        }
        if (this.attemptCache.size > this.cacheMax) {
            // 超限时删除最早的条目（Map 迭代顺序 = 插入顺序）
            let overflow = this.attemptCache.size - this.cacheMax;
            for (const key of this.attemptCache.keys()) {
                if (overflow <= 0) break;
                this.attemptCache.delete(key);
                overflow -= 1;
            }
        }
    }

    _setCache(attemptId, fingerprint, result) {
        if (!attemptId) return;
        this.attemptCache.set(attemptId, {
            fingerprint,
            result: { ...result }, // 浅拷贝，防止调用方修改缓存对象
            expiresAt: Date.now() + this.resultTtlMs
        });
        this._prune();
    }

    // 单例执行一个任务：等待前面所有任务完成后运行，避免相互插队。
    // 只用于"必须串行但不参与 attempt 幂等"的写入入口（gcal/admin）。
    runExclusive(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                status: ITEM_QUEUED,
                attemptId: '',
                task,
                resolve,
                reject
            });
            this._drain();
        });
    }

    async _drain() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                if (item.status === ITEM_CANCELLED) {
                    continue; // 已取消：callback 永不执行
                }
                item.status = ITEM_RUNNING;
                try {
                    item.resolve(await item.task());
                    item.status = ITEM_COMPLETED;
                } catch (err) {
                    item.reject(err);
                    item.status = ITEM_COMPLETED;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    // 幂等提交：
    //   attemptId   – 浏览器内存中的 bookingAttemptId（可为空，空则跳过幂等）
    //   fingerprint – 由调用方用 buildPayloadFingerprint 生成，覆盖所有影响 booking 的字段
    //   fn          – 关键区任务，接收 { arrivalSequence }，必须返回
    //                   { admissionStatus: 'accepted', bookingId, ... } 或
    //                   { admissionStatus: 'conflict', code: 'SLOT_TAKEN', ... }；
    //                 抛错视为内部失败（不缓存，允许重试）。
    //   返回        – fn 的结果；缓存命中时附带 fromCache: true，
    //                 首次执行时附带 fromCache: false（供调用方决定副作用）。
    //
    // 同一 attemptId 的去重覆盖两种竞态：
    //   1. 已完成：命中短期结果缓存，直接返回相同结果（fn 不重跑，不重复通知）。
    //   2. 执行中：同一 attemptId 并发提交共享同一个 pending promise，
    //      只让队列执行一次 fn；payload 不同则抛 ATTEMPT_PAYLOAD_MISMATCH。
    //
    // 队列超时语义：
    //   - 只取消尚未开始执行的 queued 任务；被取消的任务 callback 永不执行。
    //   - 一旦任务开始 running，调用方必须等待真实执行结果（不返回假失败）。
    async submit({ attemptId, fingerprint, fn }) {
        const id = String(attemptId || '').trim();

        if (id) {
            this._prune();
            const cached = this.attemptCache.get(id);
            if (cached) {
                if (cached.fingerprint !== fingerprint) {
                    const err = new Error('Booking payload changed for the same attempt id.');
                    err.code = 'ATTEMPT_PAYLOAD_MISMATCH';
                    throw err;
                }
                return { ...cached.result, fromCache: true };
            }

            // 执行中 single-flight：同一 attemptId 的并发请求共享同一个 owner promise。
            // 只有 owner（第一个请求）收到 fromCache:false；所有等待者改写为
            // fromCache:true，确保 syncValidCustomer / GHL 等后置副作用只执行一次。
            const pending = this.pendingAttempts.get(id);
            if (pending) {
                if (pending.fingerprint !== fingerprint) {
                    const err = new Error('Booking payload changed for the same attempt id.');
                    err.code = 'ATTEMPT_PAYLOAD_MISMATCH';
                    throw err;
                }
                return pending.promise.then((result) => ({ ...result, fromCache: true }));
            }
        }

        if (this.waiters >= 1000) {
            const err = new Error('Booking admission queue is overloaded.');
            err.code = 'ADMISSION_OVERLOADED';
            throw err;
        }

        let item = null;
        let timer = null;
        const promise = new Promise((resolve, reject) => {
            item = {
                status: ITEM_QUEUED,
                attemptId: id,
                task: null,
                resolve,
                reject
            };
            timer = setTimeout(() => {
                if (item.status === ITEM_QUEUED) {
                    // 只取消尚未开始的任务：callback 永不执行、不产生任何写入
                    item.status = ITEM_CANCELLED;
                    this.waiters -= 1;
                    if (id && this.pendingAttempts.get(id) && this.pendingAttempts.get(id).promise === promise) {
                        this.pendingAttempts.delete(id);
                    }
                    const err = new Error('Booking admission timed out while waiting for the queue.');
                    err.code = 'ADMISSION_TIMEOUT';
                    reject(err);
                } else if (item.status === ITEM_RUNNING) {
                    // 已在执行：不可取消，只记录 watchdog 日志；
                    // 调用方会收到真实执行结果，而不是假失败。
                    console.warn('[admission] watchdog: task is still running after queue wait timeout.');
                }
            }, this.queueWaitTimeoutMs);
        });

        item.task = async () => {
            try {
                this.arrivalSequence += 1;
                const result = await fn({ arrivalSequence: this.arrivalSequence });
                if (result && (result.admissionStatus === 'accepted' || result.admissionStatus === 'conflict')) {
                    this._setCache(id, fingerprint, result);
                }
                return { ...result, fromCache: false };
            } finally {
                clearTimeout(timer);
                this.waiters -= 1;
                if (id && this.pendingAttempts.get(id) && this.pendingAttempts.get(id).promise === promise) {
                    this.pendingAttempts.delete(id);
                }
            }
        };

        this.queue.push(item);
        this.waiters += 1;
        if (id) {
            this.pendingAttempts.set(id, { fingerprint, promise });
        }
        this._drain();
        return promise;
    }

    // 仅供测试/管理使用：当前排队的任务数
    get pendingCount() {
        return this.queue.length;
    }

    // 仅供测试/管理使用：当前 attempt 缓存大小
    get cacheSize() {
        return this.attemptCache.size;
    }

    // 仅供测试/管理使用：当前到达序号
    get currentArrivalSequence() {
        return this.arrivalSequence;
    }

    // 供 app.js 使用的全局随机 attemptId（仅服务端内部）
    static generateAttemptId() {
        return crypto.randomUUID();
    }
}

module.exports = {
    BookingAdmissionCoordinator,
    buildPayloadFingerprint,
    isSlotAvailable,
    normalizeRoomPool,
    parseTimeToNumber,
    toHalfOpenInterval,
    ROOM_POOL_CAPACITY
};
