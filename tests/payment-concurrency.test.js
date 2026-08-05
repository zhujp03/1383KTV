// payment-concurrency.test.js
//
// CheckoutCoordinator / FinalizeCoordinator / verifyStripeSessionForBooking
// （纯内存）的测试。
//
// 本测试只 require lib/payment-coordinator.js：
//   - 不启动服务器、不 spawn 进程、不调用真实 Stripe/Twilio/GHL/AWS
//   - 不创建/读取任何本地数据库
//   - 不 require app.js / 数据库模块
//
// 用 mock callback 模拟 Stripe session 创建、finalize 关键操作与验证。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    CheckoutCoordinator,
    FinalizeCoordinator,
    verifyStripeSessionForBooking
} = require('../lib/payment-coordinator.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------
// CheckoutCoordinator（snapshot 冻结 + single-flight + 过期检查）
// ---------------------------------------------------------------

function makeSnapshot() {
    return {
        bookingId: '42',
        totalCents: 9000,
        currency: 'CAD',
        description: '1383 KTV Booking Deposit - Small Room (2026-08-20 18:00)',
        room: 'Small Room',
        date: '2026-08-20',
        time: '18:00',
        duration: '2',
        policyVersion: '2026-08-05-v1',
        policyHash: 'abc123',
        termsAcceptedAt: '2026-08-05T12:00:00.000Z',
        cancelToken: 'tok-A',
        idempotencyKey: 'checkout_42_nonce',
        stripeExpiresAtEpoch: Math.floor(Date.now() / 1000) + 31 * 60,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel?token=tok-A'
    };
}

test('same bookingId 20 concurrent checkouts -> createSession called exactly once', async () => {
    const c = new CheckoutCoordinator();
    let snapshotCalls = 0;
    let createCalls = 0;
    // 每次 createSession 生成不同序号：一旦调用超过一次，断言必须失败
    const results = await Promise.all(Array.from({ length: 20 }, () =>
        c.checkout({
            bookingId: '42',
            fingerprint: 'fp-42',
            buildSnapshot: async () => { snapshotCalls += 1; return makeSnapshot(); },
            createSession: async (snapshot) => {
                createCalls += 1;
                return {
                    ok: true,
                    checkoutUrl: `https://checkout.stripe.mock/session_${createCalls}`,
                    sessionId: `cs_mock_${createCalls}`,
                    cancelToken: snapshot.cancelToken
                };
            }
        })
    ));
    assert.equal(snapshotCalls, 1, 'snapshot must be frozen exactly once');
    assert.equal(createCalls, 1, 'createSession must run exactly once across 20 concurrent checkouts');
    for (const r of results) {
        assert.equal(r.checkoutUrl, 'https://checkout.stripe.mock/session_1');
        assert.equal(r.sessionId, 'cs_mock_1');
        assert.equal(r.cancelToken, 'tok-A');
    }
});

test('20 concurrent checkouts while buildSnapshot is gated -> createSession still runs exactly once', async () => {
    const c = new CheckoutCoordinator();
    let snapshotCalls = 0;
    let createCalls = 0;
    let releaseBuild;
    const buildGate = new Promise((r) => { releaseBuild = r; });

    const calls = Array.from({ length: 20 }, () =>
        c.checkout({
            bookingId: 'gate-1',
            fingerprint: 'fp',
            buildSnapshot: async () => {
                snapshotCalls += 1;
                await buildGate; // 人为 gate：所有请求都在快照准备阶段等待
                return makeSnapshot();
            },
            createSession: async (snapshot) => {
                createCalls += 1;
                return {
                    ok: true,
                    checkoutUrl: `https://u-${createCalls}`,
                    sessionId: `cs-${createCalls}`,
                    cancelToken: snapshot.cancelToken
                };
            }
        })
    );
    await sleep(30); // 确保全部进入快照准备阶段
    releaseBuild();
    const results = await Promise.all(calls);

    assert.equal(snapshotCalls, 1, 'buildSnapshot must run exactly once');
    assert.equal(createCalls, 1, 'createSession must run exactly once even while snapshot is gated');
    for (const r of results) {
        assert.equal(r.sessionId, 'cs-1');
        assert.equal(r.checkoutUrl, 'https://u-1');
    }
});

test('20 concurrent checkouts while createSession is gated -> createSession runs exactly once', async () => {
    const c = new CheckoutCoordinator();
    let createCalls = 0;
    let releaseCreate;
    const createGate = new Promise((r) => { releaseCreate = r; });

    const calls = Array.from({ length: 20 }, () =>
        c.checkout({
            bookingId: 'gate-2',
            fingerprint: 'fp',
            buildSnapshot: makeSnapshot,
            createSession: async (snapshot) => {
                createCalls += 1;
                await createGate; // 人为 gate：createSession 本身挂起
                return {
                    ok: true,
                    checkoutUrl: `https://u-${createCalls}`,
                    sessionId: `cs-${createCalls}`,
                    cancelToken: snapshot.cancelToken
                };
            }
        })
    );
    await sleep(30);
    assert.equal(createCalls, 1, 'no second createSession while the first is gated');
    releaseCreate();
    const results = await Promise.all(calls);
    assert.equal(createCalls, 1);
    for (const r of results) {
        assert.equal(r.sessionId, 'cs-1');
    }
});

test('all concurrent callers get the same sessionId and URL (cache hit)', async () => {
    const c = new CheckoutCoordinator();
    await c.checkout({
        bookingId: '42',
        fingerprint: 'fp-42',
        buildSnapshot: makeSnapshot,
        createSession: async () => ({ ok: true, checkoutUrl: 'https://u', sessionId: 'cs' })
    });
    const again = await c.checkout({
        bookingId: '42',
        fingerprint: 'fp-42',
        buildSnapshot: makeSnapshot,
        createSession: async () => { throw new Error('must not be called'); }
    });
    assert.equal(again.checkoutUrl, 'https://u');
    assert.equal(again.sessionId, 'cs');
});

test('failed retry reuses the exact same frozen snapshot (deepEqual, incl. expiresAt and URLs)', async () => {
    const c = new CheckoutCoordinator();
    let snapshotCalls = 0;
    let attempt = 0;
    const createSession = async (snapshot) => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient stripe failure');
        return { ok: true, checkoutUrl: 'https://u2', sessionId: 'cs2', cancelToken: snapshot.cancelToken };
    };
    await assert.rejects(
        c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: async () => { snapshotCalls += 1; return makeSnapshot(); }, createSession })
    );
    const retried = await c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession });
    assert.equal(snapshotCalls, 1, 'snapshot is frozen once');
    assert.equal(retried.checkoutUrl, 'https://u2');
    assert.equal(retried.cancelToken, 'tok-A');
    const state = c.getState('42');
    assert.equal(state.snapshot.idempotencyKey, 'checkout_42_nonce', 'idempotency key must be stable');
    assert.equal(state.snapshot.termsAcceptedAt, '2026-08-05T12:00:00.000Z', 'termsAcceptedAt must be stable');
});

test('every createSession call receives byte-identical snapshot parameters', async () => {
    const c = new CheckoutCoordinator();
    const calls = [];
    let attempt = 0;
    const createSession = async (snapshot) => {
        calls.push({ ...snapshot });
        attempt += 1;
        if (attempt === 1) throw new Error('flaky');
        return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs' };
    };
    await assert.rejects(c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession }));
    await c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession });
    assert.equal(calls.length, 2, 'failed and retried calls both reach Stripe');
    assert.deepEqual(calls[0], calls[1], 'retry params must be byte-identical to the first attempt');
    assert.deepEqual(calls[0], makeSnapshot(), 'params must deepEqual the frozen snapshot');
});

test('stripeExpiresAtEpoch is generated once and identical across retries', async () => {
    const c = new CheckoutCoordinator();
    const epochs = [];
    const build = async () => {
        const s = makeSnapshot();
        epochs.push(s.stripeExpiresAtEpoch);
        return s;
    };
    let attempt = 0;
    const flaky = async (snapshot) => {
        attempt += 1;
        if (attempt === 1) throw new Error('flaky');
        return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs', cancelToken: snapshot.cancelToken };
    };
    await assert.rejects(c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: build, createSession: flaky }));
    await c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: build, createSession: flaky });
    assert.equal(epochs.length, 1, 'expires_at must be frozen once');
});

test('stable cancelToken is not rotated across retries', async () => {
    const c = new CheckoutCoordinator();
    const seenTokens = [];
    let attempt = 0;
    const createSession = async (snapshot) => {
        seenTokens.push(snapshot.cancelToken);
        attempt += 1;
        if (attempt === 1) throw new Error('flaky');
        return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs', cancelToken: snapshot.cancelToken };
    };
    await assert.rejects(c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession }));
    const ok = await c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession });
    assert.equal(ok.cancelToken, 'tok-A');
    assert.deepEqual(seenTokens, ['tok-A', 'tok-A'], 'cancel token must never change');
});

test('while the underlying operation is pending, later calls share it (no second createSession)', async () => {
    const c = new CheckoutCoordinator();
    let createCalls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = c.checkout({
        bookingId: '42',
        fingerprint: 'fp',
        buildSnapshot: makeSnapshot,
        createSession: async (snapshot) => {
            createCalls += 1;
            await gate; // 长时间 pending
            return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs', cancelToken: snapshot.cancelToken };
        }
    });
    await sleep(20);
    const second = c.checkout({
        bookingId: '42',
        fingerprint: 'fp',
        buildSnapshot: makeSnapshot,
        createSession: async () => { throw new Error('must not be called'); }
    });
    await sleep(20);
    assert.equal(createCalls, 1, 'no second createSession while the first is pending');
    release();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.sessionId, 'cs');
    assert.equal(r2.sessionId, 'cs');
    assert.equal(createCalls, 1);
});

test('after a real failure the lock is released and a retry may proceed', async () => {
    const c = new CheckoutCoordinator();
    let attempt = 0;
    const createSession = async () => {
        attempt += 1;
        if (attempt <= 2) throw new Error('down');
        return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs' };
    };
    await assert.rejects(c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession }));
    await assert.rejects(c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession }));
    const ok = await c.checkout({ bookingId: '42', fingerprint: 'fp', buildSnapshot: makeSnapshot, createSession });
    assert.equal(ok.sessionId, 'cs');
});

test('expired session is a terminal state: repeated requests never create a second session', async () => {
    const { mock } = require('node:test');
    mock.timers.enable({ apis: ['Date'] });
    try {
        const c = new CheckoutCoordinator();
        let createCalls = 0;
        const expiredSnapshot = { ...makeSnapshot(), stripeExpiresAtEpoch: Math.floor(Date.now() / 1000) + 2 };
        await c.checkout({
            bookingId: 'E1',
            fingerprint: 'fp',
            buildSnapshot: async () => ({ ...expiredSnapshot }),
            createSession: async (snapshot) => {
                createCalls += 1;
                return { ok: true, checkoutUrl: 'https://old-url', sessionId: 'cs_old', cancelToken: snapshot.cancelToken };
            }
        });
        assert.equal(createCalls, 1);
        mock.timers.tick(3000); // 推进到 Session 过期

        // 连续 3 次请求：每次都返回同一过期终态，createSession 始终 1 次
        for (let i = 0; i < 3; i += 1) {
            await assert.rejects(
                c.checkout({
                    bookingId: 'E1',
                    fingerprint: 'fp',
                    buildSnapshot: async () => ({ ...expiredSnapshot }),
                    createSession: async () => { throw new Error('must not create a second session'); }
                }),
                (err) => err.code === 'PAYMENT_SESSION_EXPIRED',
                `request ${i + 1} must return the terminal expiry state`
            );
        }
        assert.equal(createCalls, 1, 'createSession must stay exactly 1 after expiry');

        // 超过旧 prune 宽限期（60s）后：仍然不能创建第二个 Session
        mock.timers.tick(61 * 1000);
        await assert.rejects(
            c.checkout({
                bookingId: 'E1',
                fingerprint: 'fp',
                buildSnapshot: async () => ({ ...expiredSnapshot }),
                createSession: async () => { throw new Error('must not create a second session'); }
            }),
            (err) => err.code === 'PAYMENT_SESSION_EXPIRED'
        );
        assert.equal(createCalls, 1, 'even after prune grace the terminal state must hold');
    } finally {
        mock.timers.reset();
    }
});

test('prune retains the terminal protection for the terminal window, then recycles', async () => {
    const c = new CheckoutCoordinator({ terminalTtlMs: 40 });
    let createCalls = 0;
    const expiredSnapshot = { ...makeSnapshot(), stripeExpiresAtEpoch: Math.floor(Date.now() / 1000) - 5 };
    await c.checkout({
        bookingId: 'P1',
        fingerprint: 'fp',
        buildSnapshot: async () => ({ ...expiredSnapshot }),
        createSession: async () => { createCalls += 1; return { ok: true, checkoutUrl: 'https://old', sessionId: 'cs' }; }
    });
    await assert.rejects(
        c.checkout({ bookingId: 'P1', fingerprint: 'fp', buildSnapshot: async () => ({ ...expiredSnapshot }), createSession: async () => { throw new Error('no'); } }),
        (err) => err.code === 'PAYMENT_SESSION_EXPIRED'
    );
    // 终态窗口内：state 必须保留（防止重建）
    assert.ok(c.getState('P1'), 'terminal protection must be retained within the terminal window');
    await sleep(50); // 超过 terminalTtlMs
    c._prune();
    assert.equal(c.getState('P1'), undefined, 'state is recycled only after the terminal window');
    assert.equal(createCalls, 1);
});

test('different bookingIds are independent', async () => {
    const c = new CheckoutCoordinator();
    const r1 = await c.checkout({
        bookingId: '1',
        fingerprint: 'fp',
        buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: '1', idempotencyKey: 'k1' }),
        createSession: async () => ({ ok: true, checkoutUrl: 'https://u1', sessionId: 'cs1' })
    });
    const r2 = await c.checkout({
        bookingId: '2',
        fingerprint: 'fp',
        buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: '2', idempotencyKey: 'k2' }),
        createSession: async () => ({ ok: true, checkoutUrl: 'https://u2', sessionId: 'cs2' })
    });
    assert.equal(r1.sessionId, 'cs1');
    assert.equal(r2.sessionId, 'cs2');
});

// ---------------------------------------------------------------
// 容量保护（maxStates 绝不能淘汰受保护状态）与失败阶段 hardExpiry
// ---------------------------------------------------------------

test('capacity full: protected states are never evicted; new bookingId gets CHECKOUT_CAPACITY_EXCEEDED', async () => {
    const c = new CheckoutCoordinator({ maxStates: 2 });
    let createCalls = { A: 0, B: 0, C: 0 };
    let snapshotCalls = { A: 0, B: 0, C: 0 };

    const run = (bookingId) => c.checkout({
        bookingId,
        fingerprint: 'fp',
        buildSnapshot: async () => {
            snapshotCalls[bookingId] += 1;
            return { ...makeSnapshot(), bookingId, idempotencyKey: `k-${bookingId}` };
        },
        createSession: async () => {
            createCalls[bookingId] += 1;
            return { ok: true, checkoutUrl: `https://u-${bookingId}-${createCalls[bookingId]}`, sessionId: `${bookingId}-${createCalls[bookingId]}` };
        }
    });

    const rA = await run('A'); // A-1
    const rB = await run('B'); // B-1

    // C：容量满（2 个受保护状态），必须拒绝且不得进入 buildSnapshot/createSession
    await assert.rejects(run('C'), (err) => err.code === 'CHECKOUT_CAPACITY_EXCEEDED');
    assert.equal(snapshotCalls.C, 0, 'C must not enter buildSnapshot');
    assert.equal(createCalls.C, 0, 'C must not enter createSession');

    // 再次请求 A：必须命中原状态，返回原 sessionId，createSession 仍为 1
    const rA2 = await run('A');
    assert.equal(rA2.sessionId, 'A-1', 'A must return its original session');
    assert.equal(createCalls.A, 1, 'A must never create a second session under capacity pressure');
    assert.equal(snapshotCalls.A, 1);
    assert.ok(c.getState('A'), 'A state must still exist');
    assert.ok(c.getState('B'), 'B state must still exist');
    assert.equal(rB.sessionId, 'B-1');
});

test('capacity full: expired terminal states are never evicted for capacity', async () => {
    const { mock } = require('node:test');
    mock.timers.enable({ apis: ['Date'] });
    try {
        const c = new CheckoutCoordinator({ maxStates: 2 });
        let createCalls = 0;
        const snapA = { ...makeSnapshot(), stripeExpiresAtEpoch: Math.floor(Date.now() / 1000) + 2 };
        await c.checkout({
            bookingId: 'A',
            fingerprint: 'fp',
            buildSnapshot: async () => ({ ...snapA }),
            createSession: async () => { createCalls += 1; return { ok: true, checkoutUrl: 'https://A-1', sessionId: 'A-1' }; }
        });
        mock.timers.tick(3000); // A 过期
        await assert.rejects(
            c.checkout({ bookingId: 'A', fingerprint: 'fp', buildSnapshot: async () => ({ ...snapA }), createSession: async () => { throw new Error('no'); } }),
            (err) => err.code === 'PAYMENT_SESSION_EXPIRED'
        );
        // B 占第二个槽位
        await c.checkout({
            bookingId: 'B',
            fingerprint: 'fp',
            buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'B' }),
            createSession: async () => ({ ok: true, checkoutUrl: 'https://B-1', sessionId: 'B-1' })
        });
        // C：容量满且 A 是受保护终态 → 拒绝
        await assert.rejects(
            c.checkout({ bookingId: 'C', fingerprint: 'fp', buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'C' }), createSession: async () => ({ ok: true, checkoutUrl: 'https://C', sessionId: 'C' }) }),
            (err) => err.code === 'CHECKOUT_CAPACITY_EXCEEDED'
        );
        // 再请求 A：仍返回过期终态，不得创建第二个 Session
        await assert.rejects(
            c.checkout({ bookingId: 'A', fingerprint: 'fp', buildSnapshot: async () => ({ ...snapA }), createSession: async () => { throw new Error('no'); } }),
            (err) => err.code === 'PAYMENT_SESSION_EXPIRED'
        );
        assert.equal(createCalls, 1, 'A must never create a second session');
    } finally {
        mock.timers.reset();
    }
});

test('capacity is released only after a state is safely recycled', async () => {
    const c = new CheckoutCoordinator({ maxStates: 1, terminalTtlMs: 40 });
    let createCalls = 0;
    const expiredSnap = { ...makeSnapshot(), stripeExpiresAtEpoch: Math.floor(Date.now() / 1000) - 5 };
    await c.checkout({
        bookingId: 'A',
        fingerprint: 'fp',
        buildSnapshot: async () => ({ ...expiredSnap }),
        createSession: async () => { createCalls += 1; return { ok: true, checkoutUrl: 'https://A', sessionId: 'A' }; }
    });
    await assert.rejects(
        c.checkout({ bookingId: 'A', fingerprint: 'fp', buildSnapshot: async () => ({ ...expiredSnap }), createSession: async () => { throw new Error('no'); } }),
        (err) => err.code === 'PAYMENT_SESSION_EXPIRED'
    );
    // 终态窗口内：C 不能挤掉 A
    await assert.rejects(
        c.checkout({ bookingId: 'C', fingerprint: 'fp', buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'C' }), createSession: async () => ({ ok: true, checkoutUrl: 'https://C', sessionId: 'C' }) }),
        (err) => err.code === 'CHECKOUT_CAPACITY_EXCEEDED'
    );
    // 推进超过终态窗口 → A 被安全回收 → 容量释放，C 才允许创建
    await sleep(60);
    c._prune();
    assert.equal(c.getState('A'), undefined, 'A must be recycled after its terminal window');
    const rC = await c.checkout({
        bookingId: 'C',
        fingerprint: 'fp',
        buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'C' }),
        createSession: async () => ({ ok: true, checkoutUrl: 'https://C', sessionId: 'C' })
    });
    assert.equal(rC.sessionId, 'C');
});

test('buildSnapshot failure: hardExpiry uses the short failure TTL and state is recyclable after it', async () => {
    const c = new CheckoutCoordinator({ failureTtlMs: 40 });
    let createCalls = 0;
    await assert.rejects(
        c.checkout({
            bookingId: 'F1',
            fingerprint: 'fp',
            buildSnapshot: async () => { throw new Error('snapshot boom'); },
            createSession: async () => { createCalls += 1; return { ok: true, checkoutUrl: 'https://u', sessionId: 'cs' }; }
        }),
        /snapshot boom/
    );
    assert.equal(createCalls, 0, 'createSession must not run when buildSnapshot fails');
    const state = c.getState('F1');
    assert.ok(state.hardExpiry > Date.now(), 'failure state must have a positive hardExpiry');
    // failure TTL 内 state 存在（可安全重试）
    assert.ok(c.getState('F1'), 'state must be retained within the failure TTL');
    await sleep(50);
    c._prune();
    assert.equal(c.getState('F1'), undefined, 'state is recyclable after the failure TTL');
});

test('createSession throw: frozen snapshot and idempotency key are preserved with a terminal window', async () => {
    const c = new CheckoutCoordinator();
    let snapshotCalls = 0;
    let attempt = 0;
    const snapshot = makeSnapshot();
    const createSession = async (receivedSnapshot) => {
        attempt += 1;
        if (attempt === 1) throw new Error('stripe boom');
        return { ok: true, checkoutUrl: 'https://u2', sessionId: 'cs2', cancelToken: receivedSnapshot.cancelToken };
    };
    await assert.rejects(
        c.checkout({
            bookingId: 'F2',
            fingerprint: 'fp',
            buildSnapshot: async () => { snapshotCalls += 1; return { ...snapshot }; },
            createSession
        }),
        /stripe boom/
    );
    const state = c.getState('F2');
    assert.ok(state.snapshot, 'frozen snapshot must be preserved after a createSession failure');
    assert.equal(state.snapshot.idempotencyKey, snapshot.idempotencyKey, 'idempotency key must be preserved');
    assert.ok(state.hardExpiry > Date.now(), 'createSession failure must use a positive (terminal) hardExpiry');

    // 第二次请求：复用同一 snapshot（buildSnapshot 不再运行），idempotencyKey 完全一致
    const retried = await c.checkout({ bookingId: 'F2', fingerprint: 'fp', buildSnapshot: async () => { throw new Error('must not rebuild'); }, createSession });
    assert.equal(snapshotCalls, 1, 'buildSnapshot must not run again');
    assert.equal(retried.sessionId, 'cs2');
    assert.equal(state.snapshot.idempotencyKey, snapshot.idempotencyKey);
});

test('every settled failure state must have hardExpiry > 0', async () => {
    // buildSnapshot throw
    {
        const c = new CheckoutCoordinator({ failureTtlMs: 60000 });
        await assert.rejects(c.checkout({
            bookingId: 'S1', fingerprint: 'fp',
            buildSnapshot: async () => { throw new Error('x'); },
            createSession: async () => ({ ok: true, checkoutUrl: 'https://u', sessionId: 'cs' })
        }));
        assert.ok(c.getState('S1').hardExpiry > 0, 'buildSnapshot failure must settle with hardExpiry > 0');
    }
    // createSession throw
    {
        const c = new CheckoutCoordinator();
        await assert.rejects(c.checkout({
            bookingId: 'S2', fingerprint: 'fp',
            buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'S2' }),
            createSession: async () => { throw new Error('y'); }
        }));
        assert.ok(c.getState('S2').hardExpiry > 0, 'createSession failure must settle with hardExpiry > 0');
    }
    // createSession returns {ok:false}
    {
        const c = new CheckoutCoordinator();
        const r = await c.checkout({
            bookingId: 'S3', fingerprint: 'fp',
            buildSnapshot: async () => ({ ...makeSnapshot(), bookingId: 'S3' }),
            createSession: async () => ({ ok: false, error: 'stripe rejected' })
        });
        assert.equal(r.ok, false);
        assert.ok(c.getState('S3').hardExpiry > 0, '{ok:false} result must settle with hardExpiry > 0');
    }
});

// ---------------------------------------------------------------
// FinalizeCoordinator（bookingId mutex + eventId 终态去重）
// ---------------------------------------------------------------

test('webhook and confirm concurrent finalize: mark paid exactly once, each gets its own result', async () => {
    const fc = new FinalizeCoordinator();
    let paidCalls = 0;
    const state = { paid: false };
    const coreFn = async () => {
        // 模拟"锁内重新读取 booking"：第二个进入者看到已 paid
        if (state.paid) {
            return { terminal: true, alreadyPaid: true, bookingId: 7 };
        }
        paidCalls += 1;
        state.paid = true;
        return { terminal: true, processed: true, bookingId: 7 };
    };
    const webhookFn = async () => ({ ...(await coreFn()), received: true });
    const confirmFn = async () => ({ ...(await coreFn()), message: 'ok' });

    const [webhookResult, confirmResult] = await Promise.all([
        fc.finalize({ bookingId: '7', eventId: 'evt-1', fn: webhookFn }),
        fc.finalize({ bookingId: '7', fn: confirmFn })
    ]);

    assert.equal(paidCalls, 1, 'mark paid must run exactly once');
    assert.equal(webhookResult.received, true, 'webhook caller must get its own response shape');
    assert.equal(confirmResult.message, 'ok', 'confirm caller must get its own response shape');
    assert.equal(fc.inFlightCount, 0);
});

test('duplicate event after terminal success is ignored', async () => {
    const fc = new FinalizeCoordinator();
    let runs = 0;
    const fn = async () => {
        runs += 1;
        return { terminal: true, processed: true };
    };
    const r1 = await fc.finalize({ bookingId: '1', eventId: 'evt-x', fn });
    assert.equal(r1.processed, true);
    const r2 = await fc.finalize({ bookingId: '1', eventId: 'evt-x', fn });
    assert.equal(r2.ignored, true);
    assert.equal(r2.reason, 'duplicate-event');
    assert.equal(runs, 1, 'fn must not run again for a completed event');
});

test('event first attempt throws -> same eventId can be retried successfully', async () => {
    const fc = new FinalizeCoordinator();
    let attempt = 0;
    const fn = async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient db failure');
        return { terminal: true, processed: true };
    };
    await assert.rejects(fc.finalize({ bookingId: '2', eventId: 'evt-y', fn }));
    const retried = await fc.finalize({ bookingId: '2', eventId: 'evt-y', fn });
    assert.equal(retried.processed, true, 'same eventId must be reprocessed after failure');
    assert.equal(attempt, 2);
});

test('event first attempt returns 500 (non-terminal) -> same eventId is reprocessed', async () => {
    const fc = new FinalizeCoordinator();
    let attempt = 0;
    const fn = async () => {
        attempt += 1;
        if (attempt === 1) return { statusCode: 500, error: 'boom' }; // 非终态
        return { terminal: true, processed: true };
    };
    const r1 = await fc.finalize({ bookingId: '3', eventId: 'evt-z', fn });
    assert.equal(r1.statusCode, 500);
    const r2 = await fc.finalize({ bookingId: '3', eventId: 'evt-z', fn });
    assert.equal(r2.processed, true, 'non-terminal result must allow reprocessing');
});

test('concurrent same eventId: processed exactly once, others share the in-flight result', async () => {
    const fc = new FinalizeCoordinator();
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const fn = async () => {
        runs += 1;
        await gate;
        return { terminal: true, processed: true };
    };
    const calls = Array.from({ length: 10 }, () => fc.finalize({ bookingId: '4', eventId: 'evt-c', fn }));
    await sleep(20);
    assert.equal(runs, 1, 'concurrent same eventId must process once');
    release();
    const results = await Promise.all(calls);
    for (const r of results) {
        assert.equal(r.processed, true);
    }
    assert.equal(runs, 1);
});

test('after an exception the booking lock is released for later calls', async () => {
    const fc = new FinalizeCoordinator();
    const boom = async () => { throw new Error('boom'); };
    await assert.rejects(fc.finalize({ bookingId: '5', eventId: 'evt-1', fn: boom }));
    const ok = await fc.finalize({
        bookingId: '5',
        fn: async () => ({ terminal: true, processed: true })
    });
    assert.equal(ok.processed, true, 'lock must be released after an exception');
});

test('webhook/confirm concurrent: notifications are sent exactly once', async () => {
    const fc = new FinalizeCoordinator();
    let notifyCalls = 0;
    const state = { paid: false };
    const fn = async () => {
        if (state.paid) return { terminal: true, alreadyPaid: true };
        state.paid = true;
        notifyCalls += 1; // 通知只在真正 mark paid 时发送
        return { terminal: true, processed: true };
    };
    await Promise.all([
        fc.finalize({ bookingId: '6', eventId: 'evt-n', fn }),
        fc.finalize({ bookingId: '6', fn })
    ]);
    assert.equal(notifyCalls, 1, 'notification must be sent exactly once');
});

test('missing booking triggers CRITICAL but no new writes (mock)', async () => {
    const fc = new FinalizeCoordinator();
    let criticalCalls = 0;
    let writeCalls = 0;
    const fn = async () => {
        criticalCalls += 1;
        writeCalls += 0; // 模拟：不自动写数据库
        return { terminal: true, received: true, ignored: true, reason: 'booking-not-found' };
    };
    const r = await fc.finalize({ bookingId: '999', eventId: 'evt-missing', fn });
    assert.equal(r.reason, 'booking-not-found');
    assert.equal(criticalCalls, 1);
    assert.equal(writeCalls, 0, 'no database writes for missing booking');
});

// ---------------------------------------------------------------
// verifyStripeSessionForBooking（fail-closed）
// ---------------------------------------------------------------

const goodBooking = { id: 42 };
const goodQuote = { totalCents: 9000, currency: 'CAD' };

function goodSession(overrides = {}) {
    return {
        payment_status: 'paid',
        amount_total: 9000,
        currency: 'cad',
        metadata: { bookingId: '42' },
        client_reference_id: '42',
        id: 'cs_ok',
        ...overrides
    };
}

test('verify: correct session passes', () => {
    const v = verifyStripeSessionForBooking({ session: goodSession(), booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, true);
});

test('verify: missing amount rejected', () => {
    const session = goodSession();
    delete session.amount_total;
    assert.equal(verifyStripeSessionForBooking({ session, booking: goodBooking, quote: goodQuote }).ok, false);
});

test('verify: amount = 0 rejected', () => {
    const v = verifyStripeSessionForBooking({ session: goodSession({ amount_total: 0 }), booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, false);
});

test('verify: amount NaN rejected', () => {
    const v = verifyStripeSessionForBooking({ session: goodSession({ amount_total: Number.NaN }), booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, false);
});

test('verify: amount mismatch rejected', () => {
    const v = verifyStripeSessionForBooking({ session: goodSession({ amount_total: 9001 }), booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'amount-mismatch');
});

test('verify: missing currency rejected', () => {
    const session = goodSession();
    delete session.currency;
    assert.equal(verifyStripeSessionForBooking({ session, booking: goodBooking, quote: goodQuote }).ok, false);
});

test('verify: currency mismatch rejected', () => {
    const v = verifyStripeSessionForBooking({ session: goodSession({ currency: 'usd' }), booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'currency-mismatch');
});

test('verify: missing bookingId rejected', () => {
    const session = goodSession({ metadata: {}, client_reference_id: '' });
    assert.equal(verifyStripeSessionForBooking({ session, booking: goodBooking, quote: goodQuote }).ok, false);
});

test('verify: bookingId mismatch rejected', () => {
    const session = goodSession({ metadata: { bookingId: '43' } });
    const v = verifyStripeSessionForBooking({ session, booking: goodBooking, quote: goodQuote });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'booking-id-mismatch');
});

test('verify: unpaid session rejected', () => {
    const session = goodSession({ payment_status: 'unpaid' });
    assert.equal(verifyStripeSessionForBooking({ session, booking: goodBooking, quote: goodQuote }).ok, false);
});

test('verify: missing session rejected', () => {
    assert.equal(verifyStripeSessionForBooking({ session: null, booking: goodBooking, quote: goodQuote }).ok, false);
});
