// payment-coordinator.js
//
// 单进程、纯内存 Stripe Checkout 与付款 finalization 协调器。
//
// 与 booking-admission.js 相同的部署前提：Lightsail 单实例、单 Node 进程。
// 未来若出现多实例 / cluster / Load Balancer，本方案失效，必须改用共享协调器。
//
// 本模块禁止：
//   - require app.js / sqlite3
//   - 读取 database/
//   - 启动 Express
//   - 调用真实 Stripe / Twilio / GHL / AWS
//
// 所有状态只存在 Node 进程内存，进程重启即丢失（已知限制）。

'use strict';

const crypto = require('crypto');

const CHECKOUT_CACHE_TTL_MS = 55 * 60 * 1000; // 缓存到 booking hold 结束后（默认约 50 分钟）
const CHECKOUT_MAX_STATES = 500;
const FINALIZE_MAX_INFLIGHT = 200;
const EVENT_DEDUP_TTL_MS = 30 * 60 * 1000;
// 终态保留 TTL：Session 过期或明确终态后，保护状态必须保留至少一个正常
// 付款/预订窗口（约 45 分钟 hold），绝不删除后允许重建第二个 Session。
// 24 小时是有界的保守保留期，超过后才允许回收（此时旧 Session 早已失效）。
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
// 失败态（无成功结果）的回收 TTL
const FAILURE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------
// CheckoutCoordinator：按 bookingId 分组的 Stripe Checkout single-flight
// ---------------------------------------------------------------
// 保证：
//   - 同一 bookingId 的"准备快照 → 创建 Session"整体只有一个 owner Promise；
//     并发调用共享它，任何时刻都不会出现第二个 buildSnapshot/createSession。
//   - 第一次 attempt 一次性冻结完整 Stripe request snapshot（含 expires_at、
//     success_url/cancel_url、cancelToken、termsAcceptedAt、idempotencyKey）；
//     失败重试复用同一份 snapshot（Stripe 幂等参数完全一致）。
//   - Session 过期是明确终态（PAYMENT_SESSION_EXPIRED）：进程生命周期内，
//     后续任何请求都返回同一终态，绝不创建第二个 Session。
//   - 没有本地 Promise.race 超时：底层 Stripe operation 在真正失败前保持
//     in-flight，调用方不会因本地超时而启动第二个 createSession。
class CheckoutCoordinator {
    constructor(options = {}) {
        this.states = new Map(); // bookingId -> state
        this.cacheTtlMs = Number(options.cacheTtlMs || CHECKOUT_CACHE_TTL_MS);
        this.maxStates = Number(options.maxStates || CHECKOUT_MAX_STATES);
        this.terminalTtlMs = Number(options.terminalTtlMs || TERMINAL_TTL_MS);
        this.failureTtlMs = Number(options.failureTtlMs || FAILURE_TTL_MS);
    }

    _prune() {
        const now = Date.now();
        // 只回收同时满足以下条件的状态：
        //   !inFlightPromise && hardExpiry > 0 && hardExpiry <= now
        //  - 成功缓存 / 过期终态：保留至少一个终态窗口（TERMINAL_TTL），
        //    禁止提前删除后允许重建第二个 Session
        //  - buildSnapshot 失败态：保留 FAILURE_TTL
        //  - createSession 不确定失败态：保留终态窗口（可能已到达 Stripe）
        // maxStates 是安全容量上限，绝不是淘汰幂等保护的理由：
        // 永远不为了腾位置删除仍在保护期内的状态。
        for (const [key, state] of this.states) {
            if (state.inFlightPromise) continue;
            if (state.hardExpiry > 0 && state.hardExpiry <= now) {
                this.states.delete(key);
            }
        }
    }

    getState(bookingId) {
        return this.states.get(String(bookingId || ''));
    }

    // checkout({ bookingId, fingerprint, buildSnapshot, createSession })
    //   fingerprint     – 覆盖所有影响 Stripe 请求参数的字段（金额/币种/房型/时段/政策版本/URL 等）
    //   buildSnapshot() – 仅在第一次 attempt 调用一次，返回冻结的完整 request snapshot
    //   createSession(snapshot) – 只在 owner 流程中调用一次；重试（真正失败后）复用同一 snapshot
    //
    // 返回：
    //   - 成功：{ ok: true, checkoutUrl, sessionId, cancelToken, ... }（缓存命中时相同）
    //   - 已过期：抛 code='PAYMENT_SESSION_EXPIRED' 的 Error；同 bookingId 后续所有
    //     请求都返回同一终态，绝不创建第二个 Session
    //   - 失败：createSession reject 原样传播（in-flight 释放，下次调用复用同一 snapshot 重试）
    async checkout({ bookingId, fingerprint, buildSnapshot, createSession }) {
        const id = String(bookingId || '').trim();
        if (!id) {
            const err = new Error('Missing booking id for checkout.');
            err.code = 'CHECKOUT_INVALID_BOOKING';
            throw err;
        }
        this._prune();

        let state = this.states.get(id);
        if (!state) {
            // 已有 bookingId 永远优先命中其既有状态（成功缓存 / in-flight / 终态）；
            // 只有"新 bookingId + 容量已满 + 没有可安全清理的状态"才拒绝。
            if (this.states.size >= this.maxStates) {
                const err = new Error('Payment checkout capacity is temporarily full.');
                err.code = 'CHECKOUT_CAPACITY_EXCEEDED';
                throw err;
            }
            state = {
                bookingId: id,
                fingerprint,
                snapshot: null,
                inFlightPromise: null,
                successResult: null,
                expiresAt: 0,
                terminalError: null, // { code, message }
                hardExpiry: 0 // settle 后必有正数（成功/终态/失败阶段分别设置）
            };
            this.states.set(id, state);
            // 第一个请求是 owner：prepare + createSession 整体由一个共享 Promise 完成，
            // 并发请求在 inFlightPromise 上等待，绝不会各自执行 createSession。
            state.inFlightPromise = this._runCheckout(state, buildSnapshot, createSession);
            return state.inFlightPromise;
        }

        if (state.fingerprint !== fingerprint) {
            const err = new Error('Checkout payload changed for the same booking.');
            err.code = 'CHECKOUT_PAYLOAD_MISMATCH';
            throw err;
        }

        // 终态：过期后任何请求都返回同一明确终态，不重建、不删除保护状态
        if (state.terminalError) {
            const err = new Error(state.terminalError.message);
            err.code = state.terminalError.code;
            throw err;
        }

        if (state.successResult) {
            if (state.expiresAt > Date.now()) {
                return state.successResult; // 缓存命中
            }
            // 首次发现过期：转为明确终态（此后同 bookingId 不再创建第二个 Session）
            state.successResult = null;
            state.terminalError = { code: 'PAYMENT_SESSION_EXPIRED', message: 'The payment session has expired. Please release the booking and start again.' };
            state.hardExpiry = Date.now() + this.terminalTtlMs;
            const err = new Error(state.terminalError.message);
            err.code = state.terminalError.code;
            throw err;
        }

        if (state.inFlightPromise) {
            return state.inFlightPromise; // 并发共享 owner，绝不启动第二个 create
        }

        // 上次 owner 真正失败：复用已冻结的 snapshot 重新成为 owner 重试
        state.inFlightPromise = this._runCheckout(state, buildSnapshot, createSession);
        return state.inFlightPromise;
    }

    _runCheckout(state, buildSnapshot, createSession) {
        let run;
        run = (async () => {
            let createSessionStarted = false;
            try {
                if (!state.snapshot) {
                    state.snapshot = await buildSnapshot();
                }

                createSessionStarted = true;
                const result = await createSession(state.snapshot);
                if (result && result.ok !== false && result.checkoutUrl) {
                    state.successResult = {
                        ...result,
                        idempotencyKey: state.snapshot.idempotencyKey,
                        termsAcceptedAt: state.snapshot.termsAcceptedAt,
                        cancelToken: state.snapshot.cancelToken
                    };
                    // 成功结果的有效期以冻结的 Stripe expires_at 为准（并叠加缓存缓冲）
                    const epochSeconds = Number(state.snapshot.stripeExpiresAtEpoch || 0);
                    const stripeExpiryMs = epochSeconds > 0 ? epochSeconds * 1000 : Date.now() + this.cacheTtlMs;
                    state.expiresAt = Math.min(stripeExpiryMs, Date.now() + this.cacheTtlMs);
                    // 成功/过期终态都至少保留一个终态窗口（从当前时刻起算），
                    // 防止删除后重建第二个 Session
                    state.hardExpiry = Math.max(state.expiresAt, Date.now()) + this.terminalTtlMs;
                } else {
                    // createSession 已返回但结果无效（如 {ok:false}）：Stripe 请求
                    // 可能已经到达，按不确定失败保守保留终态窗口
                    state.hardExpiry = Date.now() + this.terminalTtlMs;
                }
                return result;
            } catch (err) {
                // 失败阶段区分：
                //  - buildSnapshot 失败（createSession 尚未调用）：无 Stripe 风险，
                //    使用短失败 TTL，允许在 TTL 内重试。
                //  - createSession 已开始后失败：即使 throw 也可能已到达 Stripe，
                //    保留已冻结 snapshot 与原 idempotencyKey，使用终态窗口。
                state.hardExpiry = Date.now()
                    + (createSessionStarted ? this.terminalTtlMs : this.failureTtlMs);
                throw err;
            } finally {
                if (state.inFlightPromise === run) {
                    state.inFlightPromise = null;
                }
            }
        })();
        return run;
    }
}

// ---------------------------------------------------------------
// FinalizeCoordinator：按 bookingId 互斥 + 按 eventId 去重的付款 finalization
// ---------------------------------------------------------------
// 保证：
//   - 同一 bookingId 的 webhook 与 confirm 通过纯内存 mutex 串行；
//     等待者在锁释放后执行自己的 fn（每次进入锁都重新读取 booking），
//     各自返回自己的响应结构，不共享 HTTP response。
//   - 同一 eventId：并发时共享同一个 in-flight 执行（只处理一次）；
//     只有 fn 明确返回 terminal 终态（processed/alreadyPaid/终态拒绝/
//     missing booking 已处理）才写入 completedEvents。
//   - fn throw、返回 500 或 transient failure 时不写 completedEvents，
//     Stripe 可用同一 eventId 重新投递。
//   - Promise 异常在 finally 中释放锁，不会永久锁死后续请求。
class FinalizeCoordinator {
    constructor(options = {}) {
        this.bookingLocks = new Map(); // bookingId -> { tail, settled }
        this.eventInFlight = new Map(); // eventId -> Promise（并发共享）
        this.completedEvents = new Map(); // eventId -> expiresAt（终态去重）
        this.eventTtlMs = Number(options.eventTtlMs || EVENT_DEDUP_TTL_MS);
        this.maxInFlight = Number(options.maxInFlight || FINALIZE_MAX_INFLIGHT);
    }

    _pruneEvents() {
        const now = Date.now();
        if (this.completedEvents.size > this.maxInFlight * 4) {
            for (const [k, v] of this.completedEvents) {
                if (v <= now) this.completedEvents.delete(k);
            }
        }
        // 清理已结束的 booking 锁
        for (const [key, entry] of this.bookingLocks) {
            if (entry.settled) this.bookingLocks.delete(key);
        }
    }

    async _withBookingLock(bookingId, fn) {
        const prev = this.bookingLocks.get(bookingId);
        const prevTail = prev ? prev.tail : Promise.resolve();
        const entry = { tail: null, settled: false };
        let release;
        const gate = new Promise((resolveGate) => { release = resolveGate; });
        entry.tail = prevTail.catch(() => {}).then(() => gate);
        entry.tail.finally(() => { entry.settled = true; }).catch(() => {});
        this.bookingLocks.set(bookingId, entry);

        await prevTail.catch(() => {}); // 等待前一个任务结束（无论成败）
        try {
            return await fn();
        } finally {
            release(); // 释放锁给下一个等待者
        }
    }

    // finalize({ bookingId, eventId, fn })
    //   fn 必须返回 { terminal: true, ... } 表示明确终态；否则视为 transient，
    //   不写入 completedEvents，Stripe 可用同一 eventId 重新投递。
    async finalize({ bookingId, eventId, fn }) {
        const id = String(bookingId || '').trim();
        if (!id) {
            const err = new Error('Missing booking id for finalize.');
            err.code = 'FINALIZE_INVALID_BOOKING';
            throw err;
        }

        const evKey = String(eventId || '').trim();

        if (evKey) {
            const completedAt = this.completedEvents.get(evKey);
            if (completedAt && completedAt > Date.now()) {
                return { status: 200, received: true, ignored: true, reason: 'duplicate-event' };
            }
            const inFlight = this.eventInFlight.get(evKey);
            if (inFlight) {
                return inFlight; // 相同 eventId 并发：共享同一次执行
            }
        }

        this._pruneEvents();

        const run = async () => {
            try {
                const result = await this._withBookingLock(id, fn);
                if (evKey && result && result.terminal === true) {
                    this.completedEvents.set(evKey, Date.now() + this.eventTtlMs);
                }
                return result;
            } finally {
                if (evKey && this.eventInFlight.get(evKey) === promise) {
                    this.eventInFlight.delete(evKey);
                }
            }
        };
        let promise;
        promise = run();
        if (evKey) {
            this.eventInFlight.set(evKey, promise);
        }
        return promise;
    }

    get inFlightCount() {
        return this.eventInFlight.size;
    }
}

// ---------------------------------------------------------------
// Stripe Session fail-closed 验证（纯函数，webhook 与 confirm 共用）
// ---------------------------------------------------------------
// 任一条件不满足即拒绝：不标记 paid、不发送通知、不写历史订单。
function verifyStripeSessionForBooking({ session, booking, quote }) {
    if (!session) {
        return { ok: false, reason: 'missing-session', error: 'Missing Stripe session.' };
    }
    if (String(session.payment_status || '').trim().toLowerCase() !== 'paid') {
        return { ok: false, reason: 'not-paid', error: 'Stripe payment is not completed.' };
    }
    const sessionBookingId = Number(session.metadata?.bookingId || session.client_reference_id || 0);
    if (!Number.isFinite(sessionBookingId) || sessionBookingId <= 0) {
        return { ok: false, reason: 'missing-booking-id', error: 'Stripe session is missing a valid booking id.' };
    }
    if (sessionBookingId !== Number(booking.id)) {
        return { ok: false, reason: 'booking-id-mismatch', error: 'Stripe session does not match this booking.' };
    }
    const amountTotal = Number(session.amount_total);
    if (!Number.isFinite(amountTotal) || !Number.isSafeInteger(amountTotal) || amountTotal <= 0) {
        return { ok: false, reason: 'invalid-amount', error: 'Stripe session has an invalid amount.' };
    }
    if (amountTotal !== Number(quote.totalCents || 0)) {
        return { ok: false, reason: 'amount-mismatch', error: 'Stripe payment amount does not match the booking.' };
    }
    const currency = String(session.currency || '').trim().toUpperCase();
    if (!currency) {
        return { ok: false, reason: 'missing-currency', error: 'Stripe session is missing a currency.' };
    }
    if (currency !== String(quote.currency || '').trim().toUpperCase()) {
        return { ok: false, reason: 'currency-mismatch', error: 'Stripe payment currency does not match the booking.' };
    }
    return { ok: true };
}

module.exports = {
    CheckoutCoordinator,
    FinalizeCoordinator,
    verifyStripeSessionForBooking
};
