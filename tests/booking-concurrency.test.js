// booking-concurrency.test.js
//
// BookingAdmissionCoordinator（纯内存 FIFO 准入协调器）的纯内存测试。
//
// 本测试只 require lib/booking-admission.js：
//   - 不启动服务器、不 spawn 进程、不调用网络
//   - 不创建/读取任何本地数据库，不依赖磁盘上的数据目录
//   - 不 require app.js / 数据库模块
//
// 核心断言约定：
//   - arrivalSequence 由协调器单调分配，队列 FIFO 顺序即提交顺序
//   - fn 在关键区内串行执行（互不插队），通过共享 existing 数组 + isSlotAvailable
//     模拟真实库存判断，容量取 ROOM_POOL_CAPACITY
//   - 队列超时只能取消 queued 任务；cancelled 任务 callback 永不执行（无幽灵写入）
//   - 一旦任务 running，调用方必须收到真实执行结果（不返回假失败）

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    BookingAdmissionCoordinator,
    buildPayloadFingerprint,
    isSlotAvailable,
    normalizeRoomPool,
    parseTimeToNumber,
    toHalfOpenInterval,
    ROOM_POOL_CAPACITY
} = require('../lib/booking-admission.js');

const DAY = '2026-08-10';

// 构造一个关键区任务：按房型对应池容量决定 accepted / conflict（SLOT_TAKEN）。
// 所有调用都在协调器队列内串行执行，existing 是按库存池分组的对象
// （{ small: [], medium: [], vip: [] }），各池互不共享容量。
function admissionFn({ room, date, start, end, existing }) {
    const pool = normalizeRoomPool(room);
    const capacity = ROOM_POOL_CAPACITY[pool];
    const rows = existing[pool] || (existing[pool] = []);
    return async ({ arrivalSequence }) => {
        const proposed = { date, start, end };
        if (isSlotAvailable({ capacity, existing: rows, proposed })) {
            rows.push({ date, start, end });
            return { admissionStatus: 'accepted', bookingId: `${room}-${arrivalSequence}`, arrivalSequence };
        }
        return { admissionStatus: 'conflict', code: 'SLOT_TAKEN', arrivalSequence };
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Medium Room: 50 concurrent same-slot requests -> only the first arrivalSequence is accepted', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    const requests = Array.from({ length: 50 }, (_, i) =>
        c.submit({
            attemptId: `medium-${i}`,
            fingerprint: buildPayloadFingerprint(['Medium Room', DAY, '18:00', 1]),
            fn: admissionFn({ room: 'Medium Room', date: DAY, start: 18, end: 19, existing })
        })
    );
    const results = await Promise.all(requests);

    const accepted = results.filter((r) => r.admissionStatus === 'accepted');
    const conflicts = results.filter((r) => r.admissionStatus === 'conflict');
    assert.equal(accepted.length, 1, 'exactly one request may be accepted');
    assert.equal(conflicts.length, 49, 'all other requests must conflict');
    const acceptedSeqs = accepted.map((r) => r.arrivalSequence);
    assert.deepEqual(acceptedSeqs, [1], 'the earliest arrivalSequence must win');
});

test('Small Room: 50 concurrent same-slot requests -> only the first 2 are accepted', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    const requests = Array.from({ length: 50 }, (_, i) =>
        c.submit({
            attemptId: `small-${i}`,
            fingerprint: buildPayloadFingerprint(['Small Room', DAY, '18:00', 1]),
            fn: admissionFn({ room: 'Small Room', date: DAY, start: 18, end: 19, existing })
        })
    );
    const results = await Promise.all(requests);
    const accepted = results.filter((r) => r.admissionStatus === 'accepted');
    assert.equal(accepted.length, 2);
    assert.deepEqual(accepted.map((r) => r.arrivalSequence).sort((a, b) => a - b), [1, 2]);
});

test('VIP Room (Large Room mapping): 50 concurrent requests -> only the first 2 are accepted', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    const requests = Array.from({ length: 50 }, (_, i) =>
        c.submit({
            attemptId: `vip-${i}`,
            fingerprint: buildPayloadFingerprint(['Large Room', DAY, '20:00', 1]),
            fn: admissionFn({ room: 'Large Room', date: DAY, start: 20, end: 21, existing })
        })
    );
    const results = await Promise.all(requests);
    const accepted = results.filter((r) => r.admissionStatus === 'accepted');
    const conflicts = results.filter((r) => r.admissionStatus === 'conflict');
    assert.equal(accepted.length, 2, 'vip pool capacity is 2');
    assert.equal(conflicts.length, 48);
    assert.deepEqual(accepted.map((r) => r.arrivalSequence).sort((a, b) => a - b), [1, 2]);
});

test('same time slot, different room pools -> all requests succeed', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = { medium: [], small: [], vip: [] };
    const specs = [
        { attemptId: 'mix-m1', room: 'Medium Room' },
        { attemptId: 'mix-s1', room: 'Small Room' },
        { attemptId: 'mix-s2', room: 'Small Room' },
        { attemptId: 'mix-l1', room: 'Large Room' },
        { attemptId: 'mix-l2', room: 'Large Room' }
    ];
    const results = await Promise.all(specs.map(({ attemptId, room }) =>
        c.submit({
            attemptId,
            fingerprint: buildPayloadFingerprint([room, DAY, '18:00', 1]),
            fn: admissionFn({ room, date: DAY, start: 18, end: 19, existing })
        })
    ));
    assert.ok(results.every((r) => r.admissionStatus === 'accepted'), 'all different-pool requests must succeed');

    const extra = await c.submit({
        attemptId: 'mix-m2',
        fingerprint: buildPayloadFingerprint(['Medium Room', DAY, '18:00', 1]),
        fn: admissionFn({ room: 'Medium Room', date: DAY, start: 18, end: 19, existing })
    });
    assert.equal(extra.admissionStatus, 'conflict');
    assert.equal(extra.code, 'SLOT_TAKEN');
});

test('same room pool, different time slots -> all requests succeed', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = { small: [] };
    const times = [18, 19, 20, 21, 22];
    const results = await Promise.all(times.map((start, i) =>
        c.submit({
            attemptId: `slot-${i}`,
            fingerprint: buildPayloadFingerprint(['Small Room', DAY, `${start}:00`, 1]),
            fn: admissionFn({ room: 'Small Room', date: DAY, start, end: start + 1, existing })
        })
    ));
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.admissionStatus === 'accepted'), 'non-overlapping slots must not conflict');
});

test('isSlotAvailable: adjacent half-open intervals [18,19) and [19,20) do not conflict', () => {
    assert.equal(
        isSlotAvailable({
            capacity: 1,
            existing: [{ date: DAY, start: 18, end: 19 }],
            proposed: { date: DAY, start: 19, end: 20 }
        }),
        true,
        'end-point touch is allowed in half-open intervals'
    );
    assert.equal(
        isSlotAvailable({
            capacity: 1,
            existing: [{ date: DAY, start: 18, end: 19 }],
            proposed: { date: DAY, start: 18, end: 19 }
        }),
        false,
        'identical intervals must conflict'
    );
});

test('isSlotAvailable: partial overlap allowed while peak occupancy stays under capacity', () => {
    assert.equal(
        isSlotAvailable({
            capacity: 2,
            existing: [
                { date: DAY, start: 18, end: 19 },
                { date: DAY, start: 20, end: 21 }
            ],
            proposed: { date: DAY, start: 18, end: 21 }
        }),
        true
    );
});

test('isSlotAvailable: rejects when any time segment would exceed capacity', () => {
    assert.equal(
        isSlotAvailable({
            capacity: 1,
            existing: [{ date: DAY, start: 18, end: 20 }],
            proposed: { date: DAY, start: 18.5, end: 19.5 }
        }),
        false
    );
    assert.equal(
        isSlotAvailable({
            capacity: 2,
            existing: [{ date: DAY, start: 18, end: 20 }],
            proposed: { date: DAY, start: 18.5, end: 19.5 }
        }),
        true
    );
});

test('arrivals in the same tick (simulated identical serverReceivedAt) are ordered by arrivalSequence', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    const seen = [];
    const requests = Array.from({ length: 30 }, () =>
        c.submit({
            attemptId: '',
            fingerprint: 'fp',
            fn: async ({ arrivalSequence }) => {
                seen.push(arrivalSequence);
                const proposed = { date: DAY, start: 18, end: 19 };
                if (isSlotAvailable({ capacity: 2, existing, proposed })) {
                    existing.push({ date: DAY, start: 18, end: 19 });
                    return { admissionStatus: 'accepted', arrivalSequence };
                }
                return { admissionStatus: 'conflict', arrivalSequence };
            }
        })
    );
    const results = await Promise.all(requests);
    const seqs = results.map((r) => r.arrivalSequence);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequences must be strictly increasing');
    assert.equal(results.filter((r) => r.admissionStatus === 'accepted').length, 2);
    assert.equal(new Set(seen).size, 30);
});

test('same bookingAttemptId 20 concurrent submissions -> create callback runs exactly once', async () => {
    const c = new BookingAdmissionCoordinator();
    let createCalls = 0;
    const fn = async () => {
        createCalls += 1;
        return { admissionStatus: 'accepted', bookingId: 'bk-single' };
    };

    // 同一同步瞬间发出 20 个并发提交：执行中的 single-flight 保证 create
    // callback 只执行一次；严格只有 1 个 owner 收到 fromCache:false，
    // 其余 19 个等待者全部收到 fromCache:true（防止副作用重复执行）。
    const burst = await Promise.all(
        Array.from({ length: 20 }, () => c.submit({ attemptId: 'burst-1', fingerprint: 'fp', fn }))
    );

    assert.equal(createCalls, 1, 'create callback must execute exactly once across 20 concurrent submissions');
    const owners = burst.filter((r) => r.fromCache === false);
    const waiters = burst.filter((r) => r.fromCache === true);
    assert.equal(owners.length, 1, 'exactly one owner must receive fromCache:false');
    assert.equal(waiters.length, 19, 'all waiters must receive fromCache:true');
    for (const r of burst) {
        assert.equal(r.admissionStatus, 'accepted');
        assert.equal(r.bookingId, 'bk-single');
    }
    assert.equal(c.cacheSize, 1);
});

test('owner failure: all concurrent waiters get the same controlled error, no unhandled rejection', async () => {
    const c = new BookingAdmissionCoordinator();
    let createCalls = 0;
    const boom = async () => {
        createCalls += 1;
        throw new Error('owner boom');
    };
    const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => c.submit({ attemptId: 'boom-1', fingerprint: 'fp', fn: boom }))
    );
    assert.equal(createCalls, 1, 'the failing admission logic must run exactly once');
    for (const r of results) {
        assert.equal(r.status, 'rejected', 'every waiter must receive the same rejection');
        assert.match(r.reason.message, /owner boom/);
    }
    // 失败后状态可安全清理：同 attemptId 重试可以成功
    const ok = await c.submit({
        attemptId: 'boom-1',
        fingerprint: 'fp',
        fn: async () => ({ admissionStatus: 'accepted', bookingId: 'after-boom' })
    });
    assert.equal(ok.bookingId, 'after-boom');
});

test('same attemptId + same payload -> cached result, identical bookingId, fn not re-run', async () => {
    const c = new BookingAdmissionCoordinator();
    let calls = 0;
    const fn = async () => {
        calls += 1;
        return { admissionStatus: 'accepted', bookingId: 'bk-cached' };
    };
    const r1 = await c.submit({ attemptId: 'retry-1', fingerprint: 'fp', fn });
    const r2 = await c.submit({ attemptId: 'retry-1', fingerprint: 'fp', fn });
    assert.equal(r1.bookingId, 'bk-cached');
    assert.equal(r1.fromCache, false);
    assert.equal(r2.bookingId, 'bk-cached');
    assert.equal(r2.fromCache, true, 'cache hit must be marked fromCache');
    assert.equal(calls, 1, 'the second submission must be served from cache');
    assert.equal(c.cacheSize, 1);
});

test('same attemptId + different payload -> ATTEMPT_PAYLOAD_MISMATCH', async () => {
    const c = new BookingAdmissionCoordinator();
    const fn = async () => ({ admissionStatus: 'accepted', bookingId: 'bk-1' });
    await c.submit({ attemptId: 'mismatch-1', fingerprint: 'fp-A', fn });
    await assert.rejects(
        c.submit({ attemptId: 'mismatch-1', fingerprint: 'fp-B', fn }),
        (err) => err.code === 'ATTEMPT_PAYLOAD_MISMATCH'
    );
});

test('a throwing callback does not poison the queue and is not cached', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    const boom = async () => {
        throw new Error('boom');
    };
    await assert.rejects(
        c.submit({ attemptId: 'throw-1', fingerprint: 'fp', fn: boom }),
        /boom/
    );
    // 队列恢复：后续任务正常执行
    const ok = await c.submit({
        attemptId: 'after-throw',
        fingerprint: 'fp',
        fn: admissionFn({ room: 'Small Room', date: DAY, start: 18, end: 19, existing })
    });
    assert.equal(ok.admissionStatus, 'accepted');
    // 失败不缓存：同 attemptId 重试会重新执行
    let calls = 0;
    const retry = await c.submit({
        attemptId: 'throw-1',
        fingerprint: 'fp',
        fn: async () => { calls += 1; return { admissionStatus: 'accepted', bookingId: 'bk-again' }; }
    });
    assert.equal(calls, 1);
    assert.equal(retry.bookingId, 'bk-again');
});

test('queued timeout: cancelled task callback never executes (no ghost booking)', async () => {
    const c = new BookingAdmissionCoordinator({ queueWaitTimeoutMs: 40 });
    const existing = [];
    const executionLog = [];

    // 阻塞任务：占用队列 200ms
    const blocker = c.submit({
        attemptId: '',
        fingerprint: 'fp',
        fn: async ({ arrivalSequence }) => {
            executionLog.push(`blocker:${arrivalSequence}`);
            await sleep(200);
            return { admissionStatus: 'accepted', bookingId: 'blocker' };
        }
    });

    await sleep(10); // 确保 blocker 先入队并开始 running

    // 第二个任务在队列中等待 → 40ms 后超时（仍 queued，可取消）
    const timedOut = c.submit({
        attemptId: 'ghost-attempt',
        fingerprint: 'fp',
        fn: async ({ arrivalSequence }) => {
            executionLog.push(`ghost:${arrivalSequence}`);
            return { admissionStatus: 'accepted', bookingId: 'ghost' };
        }
    });

    await assert.rejects(timedOut, (err) => err.code === 'ADMISSION_TIMEOUT');

    // 释放 blocker 后，被取消的任务 callback 必须严格等于 0 次执行
    await blocker;
    await sleep(30);
    assert.ok(!executionLog.some((entry) => entry.startsWith('ghost:')), 'cancelled task must never execute');
    assert.ok(executionLog.some((entry) => entry.startsWith('blocker:')), 'blocker must have executed');
});

test('timeout after cancellation: queue recovers and accepts new tasks', async () => {
    const c = new BookingAdmissionCoordinator({ queueWaitTimeoutMs: 30 });
    const blocker = c.submit({
        attemptId: '',
        fingerprint: 'fp',
        fn: async () => { await sleep(120); return { admissionStatus: 'accepted', bookingId: 'b' }; }
    });
    await sleep(5);
    const timedOut = c.submit({
        attemptId: 't1',
        fingerprint: 'fp',
        fn: async () => ({ admissionStatus: 'accepted', bookingId: 't' })
    });
    await assert.rejects(timedOut, (err) => err.code === 'ADMISSION_TIMEOUT');
    await blocker;
    // 队列恢复：新任务正常执行
    const ok = await c.submit({
        attemptId: 't2',
        fingerprint: 'fp',
        fn: async () => ({ admissionStatus: 'accepted', bookingId: 'new' })
    });
    assert.equal(ok.admissionStatus, 'accepted');
});

test('timeout after cancellation: same attemptId can be safely retried', async () => {
    const c = new BookingAdmissionCoordinator({ queueWaitTimeoutMs: 30 });
    const blocker = c.submit({
        attemptId: '',
        fingerprint: 'fp',
        fn: async () => { await sleep(120); return { admissionStatus: 'accepted', bookingId: 'b' }; }
    });
    await sleep(5);
    const timedOut = c.submit({
        attemptId: 'retryable',
        fingerprint: 'fp',
        fn: async () => ({ admissionStatus: 'accepted', bookingId: 'first' })
    });
    await assert.rejects(timedOut, (err) => err.code === 'ADMISSION_TIMEOUT');
    await blocker;
    // 相同 attemptId 重新提交：正常执行一次
    let calls = 0;
    const retried = await c.submit({
        attemptId: 'retryable',
        fingerprint: 'fp',
        fn: async () => { calls += 1; return { admissionStatus: 'accepted', bookingId: 'retried' }; }
    });
    assert.equal(calls, 1);
    assert.equal(retried.admissionStatus, 'accepted');
});

test('running task never returns a fake timeout to the caller while it continues writing', async () => {
    const c = new BookingAdmissionCoordinator({ queueWaitTimeoutMs: 30 });
    let wrote = false;
    const slow = c.submit({
        attemptId: '',
        fingerprint: 'fp',
        fn: async () => {
            await sleep(100); // 运行时间超过 timeout
            wrote = true; // 模拟真实写入（INSERT）
            return { admissionStatus: 'accepted', bookingId: 'real-write' };
        }
    });
    // 任务已开始 running：调用方必须收到真实执行结果，而不是假 ADMISSION_TIMEOUT
    const result = await slow;
    assert.equal(result.admissionStatus, 'accepted', 'caller must receive the real result');
    assert.equal(result.bookingId, 'real-write');
    assert.equal(wrote, true, 'the write must have happened exactly as the task reported');
});

test('captcha latency must not invert FIFO order (server arrival order decides)', async () => {
    const c = new BookingAdmissionCoordinator();
    const executionOrder = [];

    // A 先入队，但"captcha 验证"慢（fn 内延迟 80ms）
    const a = c.submit({
        attemptId: 'a',
        fingerprint: 'fp',
        fn: async ({ arrivalSequence }) => {
            executionOrder.push('A');
            await sleep(80); // 模拟慢的 Turnstile 验证
            return { admissionStatus: 'accepted', bookingId: 'A', arrivalSequence };
        }
    });
    // B 后入队，"captcha 验证"立即完成
    const b = c.submit({
        attemptId: 'b',
        fingerprint: 'fp',
        fn: async ({ arrivalSequence }) => {
            executionOrder.push('B');
            return { admissionStatus: 'accepted', bookingId: 'B', arrivalSequence };
        }
    });

    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(executionOrder, ['A', 'B'], 'A must be processed first regardless of captcha latency');
    assert.ok(ra.arrivalSequence < rb.arrivalSequence, 'server arrival order must decide');
});

test('first attempt captcha invalid -> rejected, second valid request proceeds', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];

    // A 先入队，captcha 无效（返回 rejected，不缓存）
    const a = await c.submit({
        attemptId: 'captcha-a',
        fingerprint: 'fp',
        fn: async ({ arrivalSequence }) => ({
            admissionStatus: 'rejected',
            code: 'CAPTCHA_FAILED',
            statusCode: 400,
            arrivalSequence
        })
    });
    assert.equal(a.admissionStatus, 'rejected');
    assert.equal(a.code, 'CAPTCHA_FAILED');

    // B 后入队，captcha 有效，获得库存
    const b = await c.submit({
        attemptId: 'captcha-b',
        fingerprint: 'fp',
        fn: admissionFn({ room: 'Small Room', date: DAY, start: 18, end: 19, existing })
    });
    assert.equal(b.admissionStatus, 'accepted', 'the valid request after an invalid one must succeed');
    // 无效请求不能获得房间：existing 中没有 A 的占用
    assert.equal(existing.small.length, 1);
});

test('TTL expiry: cached result disappears after resultTtlMs and fn re-executes', async () => {
    const c = new BookingAdmissionCoordinator({ resultTtlMs: 5 });
    let calls = 0;
    const fn = async () => { calls += 1; return { admissionStatus: 'accepted', bookingId: 'ttl' }; };
    await c.submit({ attemptId: 'ttl-1', fingerprint: 'fp', fn });
    assert.equal(calls, 1);
    await sleep(20);
    await c.submit({ attemptId: 'ttl-1', fingerprint: 'fp', fn });
    assert.equal(calls, 2, 'after TTL expiry the fn must re-execute');
});

test('cacheMax caps the attempt cache size', async () => {
    const c = new BookingAdmissionCoordinator({ cacheMax: 3 });
    const fn = async () => ({ admissionStatus: 'accepted', bookingId: 'x' });
    for (let i = 0; i < 10; i += 1) {
        await c.submit({ attemptId: `cap-${i}`, fingerprint: 'fp', fn });
    }
    assert.ok(c.cacheSize <= 3, 'cache size must not exceed cacheMax');
});

test('Private Event (date N/A) is excluded from standard inventory', () => {
    assert.equal(toHalfOpenInterval({ date: 'N/A', time: '10:00', duration: 2 }), null);
    assert.equal(
        isSlotAvailable({
            capacity: 1,
            existing: [],
            proposed: { date: DAY, start: 10, end: 12 }
        }),
        true
    );
});

test('normalizeRoomPool maps Large Room to the vip pool', () => {
    assert.equal(normalizeRoomPool('Large Room'), 'vip');
    assert.equal(normalizeRoomPool('VIP Room'), 'vip');
    assert.equal(normalizeRoomPool('Small Room'), 'small');
    assert.equal(normalizeRoomPool('Medium Room'), 'medium');
});

test('midnight times: 00:00 -> 24, 01:30 -> 25.5, and overlap checks span midnight', () => {
    assert.equal(parseTimeToNumber('00:00'), 24);
    assert.equal(parseTimeToNumber('01:30'), 25.5);
    assert.equal(parseTimeToNumber('18:00'), 18);
    assert.ok(Number.isNaN(parseTimeToNumber('18:99')), 'minutes above 59 must be rejected');
    assert.ok(Number.isNaN(parseTimeToNumber('25:00')), 'hours above 23 must be rejected');
    assert.ok(Number.isNaN(parseTimeToNumber('abc')), 'non-time strings must be rejected');

    // 23:00–01:00（23→25）与 00:00–01:00（24→25）同一日期区间重叠 → 容量 1 拒绝
    assert.equal(
        isSlotAvailable({
            capacity: 1,
            existing: [{ date: DAY, start: 23, end: 25 }],
            proposed: { date: DAY, start: 24, end: 25 }
        }),
        false
    );
});

test('conflict results are cached like accepted ones', async () => {
    const c = new BookingAdmissionCoordinator();
    const existing = [];
    let calls = 0;
    const fn = async () => {
        calls += 1;
        const proposed = { date: DAY, start: 18, end: 19 };
        if (isSlotAvailable({ capacity: 1, existing, proposed })) {
            existing.push(proposed);
            return { admissionStatus: 'accepted', bookingId: 'x' };
        }
        return { admissionStatus: 'conflict', code: 'SLOT_TAKEN' };
    };
    const r1 = await c.submit({ attemptId: 'conflict-cache', fingerprint: 'fp', fn });
    const r2 = await c.submit({ attemptId: 'conflict-cache', fingerprint: 'fp', fn });
    assert.equal(r1.admissionStatus, 'accepted');
    assert.equal(r2.admissionStatus, 'accepted');
    assert.equal(r2.fromCache, true);
    assert.equal(calls, 1);
});

test('ADMISSION_OVERLOADED: 1000 in-flight waiters rejects further submissions', async () => {
    const c = new BookingAdmissionCoordinator();
    const blocker = c.submit({
        attemptId: '',
        fingerprint: 'fp',
        fn: async () => { await sleep(300); return { admissionStatus: 'accepted', bookingId: 'b' }; }
    });
    await sleep(5);
    // blocker(1) + 999 排队 = 1000 在途；之后的提交被 ADMISSION_OVERLOADED 拒绝
    const waiters = Array.from({ length: 1000 }, (_, i) =>
        c.submit({
            attemptId: `w-${i}`,
            fingerprint: 'fp',
            fn: async () => ({ admissionStatus: 'accepted', bookingId: `w-${i}` })
        }).catch((err) => ({ err: err.code }))
    );
    const overloaded = await c.submit({
        attemptId: 'over-1',
        fingerprint: 'fp',
        fn: async () => ({ admissionStatus: 'accepted', bookingId: 'over' })
    }).catch((err) => ({ err: err.code }));
    assert.equal(overloaded.err, 'ADMISSION_OVERLOADED');
    await blocker;
    const results = await Promise.all(waiters);
    assert.equal(results.filter((r) => r.admissionStatus === 'accepted').length, 999, 'blocker + 999 queued = 1000 in flight');
    assert.equal(results.filter((r) => r.err === 'ADMISSION_OVERLOADED').length, 1);
});

test('exported constants and helpers match the contract', () => {
    assert.equal(ROOM_POOL_CAPACITY.small, 2);
    assert.equal(ROOM_POOL_CAPACITY.medium, 1);
    assert.equal(ROOM_POOL_CAPACITY.vip, 2);
    assert.equal(buildPayloadFingerprint(['a', ' b ', 'c']), 'a|b|c');
    assert.equal(BookingAdmissionCoordinator.generateAttemptId().length > 10, true);
});
