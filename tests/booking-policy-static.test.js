// Booking & Payment Policy 强化：纯静态源码测试。
//
// 本测试只读取项目源代码文件，不启动服务器、不连接数据库、
// 不创建临时数据库、不发起任何 API 请求。
//
// 覆盖：前端披露文案、强制 checkbox、后端无数据库政策门禁、
// Stripe Checkout metadata、静态政策版本与 hash。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readSource = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const appSource = readSource('app.js');
const bookingHtml = readSource('pages/booking.html');
const legalHtml = readSource('pages/legal.html');
const legalCss = readSource('styles/legal.css');

test('booking.html Step 1 has the Important Pricing & Deposit notice', () => {
    assert.match(bookingHtml, /class="booking-important-notice"/);
    assert.match(bookingHtml, /Important Pricing &amp; Deposit Notice/);
    assert.ok(
        bookingHtml.indexOf('booking-important-notice') < bookingHtml.indexOf('class="rooms-grid"'),
        'notice must be placed before the room cards'
    );
});

test('booking.html Step 1 discloses 18% Service Charge and HST', () => {
    assert.ok(
        (bookingHtml.match(/18% Service Charge/g) || []).length >= 3,
        '18% Service Charge should appear in the notice and room price notes'
    );
    assert.match(bookingHtml, /\+ 18% Service Charge \+ HST/);
    assert.match(bookingHtml, /HST is additional where applicable/);
});

test('booking.html links to the Booking & Payment Policy page', () => {
    assert.match(bookingHtml, /Review the Booking &amp; Payment Policy/);
    assert.match(bookingHtml, /legal\.html#booking-payment-policy/);
    assert.match(bookingHtml, /target="_blank"/);
    assert.match(bookingHtml, /rel="noopener noreferrer"/);
});

test('payment checkbox is not pre-checked', () => {
    const checkbox = bookingHtml.match(/<input[^>]*id="payment-policy-checkbox"[^>]*>/);
    assert.ok(checkbox, 'payment-policy-checkbox input must exist');
    assert.ok(!/\schecked/.test(checkbox[0]), 'checkbox must not have a checked attribute');
    assert.ok(!/checked/.test(bookingHtml.match(/<input[^>]*id="payment-policy-checkbox"[\s\S]{0,200}/)?.[0] || ''), 'checkbox must not be pre-checked by default');
});

test('startPayment() guards against missing policy acceptance', () => {
    const startPaymentBlock = bookingHtml.match(/async function startPayment[\s\S]*?function handlePaymentReturnFromQuery/)?.[0] || '';
    assert.ok(startPaymentBlock, 'startPayment function should be found');
    assert.match(startPaymentBlock, /isPaymentPolicyAccepted\(\)/);
    assert.match(startPaymentBlock, /Please review and accept the Booking & Payment Policy before continuing to payment\./);
});

test('payment request body includes termsAccepted and policyVersion', () => {
    const startPaymentBlock = bookingHtml.match(/async function startPayment[\s\S]*?function handlePaymentReturnFromQuery/)?.[0] || '';
    assert.match(startPaymentBlock, /termsAccepted: true/);
    assert.match(startPaymentBlock, /policyVersion: securityConfig\.bookingPolicyVersion/);
});

test('Private Event modal does not auto-start payment on close', () => {
    const privateEventBlock = bookingHtml.match(/async function selectPrivateEvent[\s\S]*?\/\/ 🌟 选房间逻辑/)?.[0] || '';
    assert.ok(privateEventBlock, 'selectPrivateEvent function should be found');
    assert.ok(!/onClose:\s*\(\)\s*=>\s*startPayment/.test(privateEventBlock), 'modal must not auto-start payment on close');
    assert.match(privateEventBlock, /buttonText: 'Review Payment'/);
});

test('Private Event is described as a deposit, not a final full-day price', () => {
    assert.match(bookingHtml, /'Private Event Deposit'/);
    assert.match(bookingHtml, /deposit required to confirm your Private Event booking/);
    assert.ok(!/Private Event Full-Day Booking/.test(bookingHtml), 'must not present $400 as the final full-day price');
});

test('Step 5 uses Booking Deposit wording without Remaining Balance', () => {
    assert.match(bookingHtml, /<h3>Booking Deposit<\/h3>/);
    assert.match(bookingHtml, /First Hour Room Deposit/);
    assert.match(bookingHtml, /Selected Package:/);
    assert.match(bookingHtml, /Deposit Due Today/);
    assert.ok(!/Remaining Balance/.test(bookingHtml), 'must not use "Remaining Balance"');
});

test('legal.html contains the full Booking & Payment Policy card', () => {
    assert.match(legalHtml, /id="booking-payment-policy"/);
    assert.match(legalHtml, /Booking &amp; Payment Policy/);
    for (const section of [
        'Booking Deposit',
        'Additional Venue Charges',
        'Cancellation and Refunds',
        'Rescheduling',
        'No-Show and Late Arrival',
        'Service Charge',
        'Taxes',
        'Contact Information'
    ]) {
        assert.ok(legalHtml.includes(section), `legal.html must contain section: ${section}`);
    }
    assert.match(legalHtml, /except where a refund is required by applicable law/);
    assert.match(legalHtml, /1383 Karaoke Bar &amp; KTV/);
    assert.match(legalHtml, /613-867-1383/);
});

test('legal.css fixes the anchor offset under the fixed nav', () => {
    assert.match(legalCss, /#booking-payment-policy\s*\{/);
    assert.match(legalCss, /scroll-margin-top:\s*120px/);
});

test('app.js defines a static policy version', () => {
    assert.match(appSource, /const BOOKING_POLICY_VERSION\s*=\s*'2026-08-05-v1'/);
});

test('app.js defines a static policy hash from canonical text', () => {
    assert.match(appSource, /const BOOKING_POLICY_TERMS = Object\.freeze\(/);
    assert.match(appSource, /const BOOKING_POLICY_HASH = crypto/);
    assert.match(appSource, /createHash\('sha256'\)/);
    // canonical text 必须覆盖全部 8 个政策主题
    for (const key of [
        'deposit:',
        'additionalVenueCharges:',
        'cancellationAndRefunds:',
        'rescheduling:',
        'lateArrival:',
        'serviceCharge:',
        'taxes:',
        'contactInformation:'
    ]) {
        assert.ok(appSource.includes(key), `BOOKING_POLICY_TERMS must include ${key}`);
    }
});

test('canonical policy text covers the eight policy topics and key terms', () => {
    const termsBlock = appSource.match(/const BOOKING_POLICY_TERMS = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] || '';
    assert.ok(termsBlock, 'BOOKING_POLICY_TERMS block should be found');

    // 1. Booking Deposit
    assert.match(termsBlock, /Online payments made through this website are booking deposits/);
    assert.match(termsBlock, /first-hour room charge plus any selected prepaid packages/);
    assert.match(termsBlock, /not necessarily the final amount for the guest/);
    // 2. Additional Venue Charges（额外店内消费）
    assert.match(termsBlock, /Any additional charges, including extra room time, food and beverage purchases/);
    assert.match(termsBlock, /settled at the venue/);
    // 3. Cancellation and Refunds（依法可退例外）
    assert.match(termsBlock, /non-refundable when the customer cancels the booking or does not attend/);
    assert.match(termsBlock, /except where a refund is required by applicable law/);
    assert.match(termsBlock, /non-waivable rights or remedies/);
    // 4. Rescheduling（24 小时改期）
    assert.match(termsBlock, /at least 24 hours before the reserved start time/);
    assert.match(termsBlock, /subject to availability and is not guaranteed/);
    assert.match(termsBlock, /Changes requested within 24 hours of the reservation are not permitted/);
    // 5. No-Show and Late Arrival（迟到释放房间）
    assert.match(termsBlock, /The reserved booking time begins at the scheduled start time/);
    assert.match(termsBlock, /within 30 minutes after the scheduled start time, the room may be released/);
    assert.match(termsBlock, /does not automatically entitle the customer to a refund/);
    // 6. Service Charge（包括 Private Event）
    assert.match(termsBlock, /18% Service Charge applies to all room bookings and food & beverage purchases/);
    assert.match(termsBlock, /including Private Event bookings/);
    // 7. Taxes（HST）
    assert.match(termsBlock, /HST is additional where applicable/);
    // 8. Contact Information（已确认信息）
    assert.match(termsBlock, /1383 Karaoke Bar & KTV/);
    assert.match(termsBlock, /613-867-1383/);
    assert.match(termsBlock, /Ottawa, ON/);
});

test('canonical text and legal.html agree on the substantive terms', () => {
    const termsBlock = appSource.match(/const BOOKING_POLICY_TERMS = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] || '';
    const policyCard = legalHtml.match(/id="booking-payment-policy"[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(termsBlock && policyCard, 'both canonical text and legal.html card should exist');

    for (const phrase of [
        'Online payments made through this website are booking deposits',
        'except where a refund is required by applicable law',
        'Nothing in this policy limits any non-waivable rights or remedies',
        'Requests to reschedule must be made at least 24 hours before the reserved start time',
        'Changes requested within 24 hours of the reservation are not permitted',
        'If the venue does not hear from the customer within 30 minutes after the scheduled start time, the room may be released',
        'A released room does not automatically entitle the customer to a refund',
        'An 18% Service Charge applies to all room bookings and food',
        'HST is additional where applicable',
        '1383 Karaoke Bar',
        '613-867-1383'
    ]) {
        assert.ok(termsBlock.includes(phrase), `canonical text must include: ${phrase}`);
        assert.ok(policyCard.includes(phrase), `legal.html must include: ${phrase}`);
    }
});

test('Private Event Stripe description uses Deposit wording, never Full Day', () => {
    assert.match(appSource, /'Private Event Deposit'/);
    assert.match(appSource, /`1383 KTV Private Event Deposit \(\$\{safeDate\}\)`/);
    assert.ok(!appSource.includes('Private Event (Full Day)'), 'app.js must not label the private event as Full Day');
    assert.ok(!appSource.includes('Private Event - Full Day'), 'app.js must not describe the private event as Full Day');
});

test('security-config exposes policy version and hash', () => {
    assert.match(appSource, /bookingPolicyVersion: BOOKING_POLICY_VERSION/);
    assert.match(appSource, /bookingPolicyHash: BOOKING_POLICY_HASH/);
});

test('payment/start strictly validates termsAccepted === true', () => {
    assert.match(appSource, /req\.body\?\.termsAccepted !== true/);
    assert.match(appSource, /Booking & Payment Policy acceptance is required before payment\./);
});

test('payment/start strictly validates policyVersion', () => {
    assert.match(appSource, /String\(req\.body\?\.policyVersion \|\| ''\)\.trim\(\) !== BOOKING_POLICY_VERSION/);
    assert.match(appSource, /Policy has changed\. Please review and accept the current policy before payment\./i);
});

test('Stripe Checkout metadata carries policy evidence', () => {
    const metadataBlock = appSource.match(/metadata: \{[\s\S]*?termsAcceptedAt\s*\}/)?.[0] || '';
    assert.ok(metadataBlock, 'metadata block should be found');
    assert.match(metadataBlock, /termsAccepted: 'true'/);
    assert.match(metadataBlock, /policyVersion: snapshot\.policyVersion/);
    assert.match(metadataBlock, /policyHash: snapshot\.policyHash/);
    assert.match(metadataBlock, /termsAcceptedAt/);
    assert.ok(!metadataBlock.includes('phone'), 'metadata must not include phone number');
    assert.ok(!metadataBlock.includes('name'), 'metadata must not include customer name');
    assert.ok(!metadataBlock.includes('cancelToken'), 'metadata must not include the cancel token');
});

test('app.js has no database terms fields', () => {
    // 拼接构造关键字，避免本文件被 rg 命中
    const tAccepted = 'terms' + '_accepted';
    const tAcceptedAt = 'terms' + '_accepted_at';
    const tPolicyVersion = 'terms' + '_policy_version';
    const tSnapshot = 'terms' + '_snapshot_json';
    assert.ok(!appSource.includes(tAccepted), `app.js must not reference ${tAccepted}`);
    assert.ok(!appSource.includes(tAcceptedAt), `app.js must not reference ${tAcceptedAt}`);
    assert.ok(!appSource.includes(tPolicyVersion), `app.js must not reference ${tPolicyVersion}`);
    assert.ok(!appSource.includes(tSnapshot), `app.js must not reference ${tSnapshot}`);
});

test('this test file never touches databases or servers', () => {
    // 通过拼接构造关键字，避免源码中出现会被 rg 命中的字面量
    const badDbToken = 'sqlite' + '3';
    const badDbDirToken = 'DATABASE' + '_DIR';
    const badSetupToken = 'setup' + '_db';
    const selfSource = fs.readFileSync(__filename, 'utf8');
    assert.ok(!selfSource.includes(badDbToken), `test must not reference ${badDbToken}`);
    assert.ok(!selfSource.includes(badDbDirToken), `test must not reference ${badDbDirToken}`);
    assert.ok(!selfSource.includes(badSetupToken), `test must not reference ${badSetupToken}`);
    assert.ok(!/spawn\(/.test(selfSource), 'test must not spawn the server');
    assert.ok(!/fetch\(/.test(selfSource), 'test must not call APIs');
});

// ================================================================
// 并发预订返工：前端用户流程静态检查
// ================================================================

test('page keeps exactly 5 steps in the original order', () => {
    const ids = [1, 2, 3, 4, 5];
    for (const n of ids) {
        assert.ok(bookingHtml.includes(`id="step-${n}"`), `step-${n} must exist`);
    }
    const positions = ids.map((n) => bookingHtml.indexOf(`id="step-${n}"`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'step order must be 1..5');
});

test('success path shows the original Payment Required modal and never auto-navigates to Step 5', () => {
    assert.match(bookingHtml, /title: 'Payment Required'/);
    assert.match(bookingHtml, /buttonText: 'Continue to Payment'/);
    assert.match(bookingHtml, /Booking request submitted successfully \(Booking #\$\{bookingData\.bookingId\}\)/);
    assert.match(bookingHtml, /continue to pay the deposit now to secure your spot/);
    assert.match(bookingHtml, /this reservation will be automatically released/);

    // 成功分支（response.ok 内）：显示弹窗，而不是自动 goToStep(5)
    const successBlock = bookingHtml.match(/if \(response\.ok\) \{[\s\S]*?\n            return;/)?.[0] || '';
    assert.ok(successBlock.includes('openAppModal'), 'success must show the modal');
    assert.ok(!successBlock.includes('goToStep(5)'), 'success must not auto-navigate to Step 5');
});

test('only the Continue to Payment button enters Step 5 (explicit action, not dismiss)', () => {
    assert.match(bookingHtml, /buttonText: 'Continue to Payment',\s*action: \(\) => \{\s*goToStep\(5\);\s*\}/);
});

test('conflict handler returns to Step 3, clears time/payment state, keeps booking fields', () => {
    const block = bookingHtml.match(/function handleConflictReturnToStep3\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.ok(block, 'handleConflictReturnToStep3 must exist');
    assert.match(block, /goToStep\(3\)/);
    assert.match(block, /bookingData\.time = null/);
    assert.match(block, /bookingData\.bookingId = null/);
    assert.match(block, /bookingData\.paymentStatus = 'unpaid'/);
    assert.match(block, /bookingData\.paymentQuote = null/);
    assert.match(block, /bookingData\.paymentCancelToken = ''/);
    // 保留字段：不得出现对这些字段的清空赋值
    for (const cleared of [
        'bookingData.room = null',
        'bookingData.partySize = null',
        'bookingData.date = null',
        'bookingData.duration = null',
        'bookingData.selectedPackages = []',
        'bookingData.name = null',
        'bookingData.phone = null'
    ]) {
        assert.ok(!block.includes(cleared), `conflict must keep: ${cleared}`);
    }
    assert.match(block, /regenerateBookingAttemptId\(\)/, 'conflict must generate a new attempt id');
    assert.match(block, /resetCaptchaChallenge\(\)/, 'conflict must reset the captcha challenge');
    assert.match(block, /fetchBookingsAndRenderTimes\(\)/, 'conflict must reload available times');
});

test('network error keeps the same attemptId and does not clear the captcha token', () => {
    const block = bookingHtml.match(/网络请求错误[\s\S]*?Unable to Verify Availability[\s\S]*?\n            return;/)?.[0] || '';
    assert.ok(block.includes('retryBookingSubmission'), 'retry must reuse the same attempt');
    assert.ok(!block.includes('resetCaptchaChallenge'), 'network error must not clear the captcha token');
    assert.ok(!block.includes('regenerateBookingAttemptId'), 'network error must not regenerate the attempt id');
});

test('loading modal has dialog semantics, no backdrop close, no ESC handler, no auto retry', () => {
    const modalHtml = bookingHtml.match(/<div class="availability-overlay"[\s\S]*?<\/div>\s*\n<\/div>/)?.[0] || '';
    assert.ok(modalHtml.includes('role="dialog"'));
    assert.ok(modalHtml.includes('aria-modal="true"'));
    assert.ok(modalHtml.includes('aria-live="polite"'));
    assert.ok(!modalHtml.includes('onclick'), 'availability modal must not close on backdrop click');
    assert.ok(!/keydown|keyup/.test(bookingHtml), 'no ESC handler may exist on the page');
});

test('captcha failure requires a fresh challenge, a new attempt id and scrolls to the captcha area', () => {
    const block = bookingHtml.match(/CAPTCHA_FAILED[\s\S]*?Verification Required[\s\S]*?\n            return;/)?.[0] || '';
    assert.ok(block.includes('resetCaptchaChallenge()'), 'captcha token must be cleared');
    assert.ok(block.includes('regenerateBookingAttemptId()'), 'new captcha token must get a new attempt id (new idempotency key)');
    assert.ok(block.includes('captcha-section'));
    // 新 token 不能自动用空 token 提交
    assert.ok(!block.includes('performBookingSubmission()'), 'must not auto-submit');
});

test('ATTEMPT_PAYLOAD_MISMATCH: new attempt id, fresh challenge, and NO direct retry', () => {
    const block = bookingHtml.match(/result\.code === 'ATTEMPT_PAYLOAD_MISMATCH'[\s\S]*?captcha-section[\s\S]*?\n            return;/)?.[0] || '';
    assert.ok(block, 'mismatch block must be found');
    assert.ok(block.includes('regenerateBookingAttemptId()'), 'mismatch must generate a new attempt id');
    assert.ok(block.includes('resetCaptchaChallenge()'), 'mismatch must not reuse the old captcha token');
    // 按钮不能直接发起 fetch/retry：只能滚动到 CAPTCHA 区域等待用户完成新 challenge
    assert.ok(!block.includes('retryBookingSubmission()'), 'mismatch button must not retry');
    assert.ok(!block.includes('performBookingSubmission()'), 'mismatch button must not re-submit');
    assert.ok(block.includes("buttonText: 'Complete Verification'"), 'button must say Complete Verification');
    assert.ok(block.includes('captcha-section'), 'action must scroll to the captcha area');
});

test('performBookingSubmission guards against an empty CAPTCHA token before any fetch', () => {
    const block = bookingHtml.match(/async function performBookingSubmission\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.ok(block, 'performBookingSubmission must be found');
    // guard 条件存在
    assert.ok(block.includes('securityConfig.captchaEnabled && !captchaToken'), 'CAPTCHA guard must exist');
    // guard 在"提交进行中标记"赋值之前（用行首匹配，避免命中注释文字）
    const guardIdx = block.indexOf('securityConfig.captchaEnabled && !captchaToken');
    const lockIdx = block.search(/^\s*bookingSubmitInProgress = true;/m);
    assert.ok(lockIdx > 0, 'bookingSubmitInProgress = true must exist in the function');
    assert.ok(guardIdx < lockIdx, 'CAPTCHA guard must run before bookingSubmitInProgress = true');
    // guard 在任何网络请求之前
    const fetchIdx = block.indexOf("'/api/book'");
    assert.ok(guardIdx < fetchIdx, 'CAPTCHA guard must run before any fetch');
    // guard 分支不递归重试（只检查 guard 块内部，排除函数签名）
    const guardStart = block.indexOf('if (securityConfig.captchaEnabled && !captchaToken)');
    const guardBlock = block.slice(guardStart, lockIdx);
    assert.ok(!guardBlock.includes('retryBookingSubmission()'), 'guard must not retry');
    assert.ok(!guardBlock.includes('performBookingSubmission()'), 'guard must not recurse');
    // guard 弹窗引导用户完成验证
    assert.ok(guardBlock.includes('Complete Verification'));
    assert.ok(guardBlock.includes('captcha-section'));
});

test('app.js maps CHECKOUT_CAPACITY_EXCEEDED to HTTP 503 without leaking internals', () => {
    const idx = appSource.indexOf("err.code === 'CHECKOUT_CAPACITY_EXCEEDED'");
    assert.ok(idx > 0, 'capacity error mapping must exist in app.js');
    const block = appSource.slice(idx, idx + 600);
    assert.ok(block.includes('res.status(503)'), 'capacity error must map to HTTP 503');
    assert.ok(block.includes('The payment system is busy. Please wait a moment and try again.'), 'user-facing copy must exist');
    // 不得向用户暴露内部实现
    assert.ok(!block.includes('maxStates'), 'must not leak maxStates');
    assert.ok(!block.includes('Map'), 'must not leak internal Map');
    assert.ok(!block.includes('queue'), 'must not leak queue internals');
});

test('modal separates action (button) from dismiss (backdrop/close); retry only via Try Again', () => {
    // 按钮绑定显式 action handler；Try Again 弹窗用 action 而非 dismiss onClose
    assert.match(bookingHtml, /id="validation-modal-ok-btn"[^>]*onclick="handleModalAction\(\)"/);
    assert.match(bookingHtml, /function handleModalAction\(\)/);
    assert.ok(!/onClose: \(\) => retryBookingSubmission\(\)/.test(bookingHtml), 'retry must not be bound to dismiss');
    assert.ok(/action: \(\) => retryBookingSubmission\(\)/.test(bookingHtml), 'retry must be the explicit button action');
    // backdrop 只 dismiss，不执行 action
    assert.match(bookingHtml, /function closeValidationModal\(\)/);
    assert.match(bookingHtml, /function handleModalBackdropClick\(event\)/);
    assert.match(bookingHtml, /modalDismissHandler/);
    // 没有任何错误弹窗把业务操作绑在 dismiss 上
    assert.ok(!/onClose: \(\) => \{\s*retryBookingSubmission\(\)/.test(bookingHtml));
});

test('server 500/503 retry reuses the same attemptId without clearing captcha', () => {
    const block = bookingHtml.match(/其他服务端错误[\s\S]*?retryBookingSubmission\(\)[\s\S]*?\n    \}/)?.[0] || '';
    assert.ok(block.includes('retryBookingSubmission'));
    assert.ok(!block.includes('resetCaptchaChallenge'));
    assert.ok(!block.includes('regenerateBookingAttemptId'));
});

test('frontend sends bookingAttemptId with the booking payload', () => {
    // 拼接构造关键字，避免本文件自检命中
    const fetchStart = 'fetch' + "('/api/book'";
    const startIdx = bookingHtml.indexOf(fetchStart);
    assert.ok(startIdx > 0, 'booking submission fetch must exist');
    const submitBlock = bookingHtml.slice(startIdx, startIdx + 400);
    assert.match(submitBlock, /bookingAttemptId/);
    assert.match(submitBlock, /\.\.\.bookingData/);
});

// ================================================================
// Step 5 手机端紧凑付款布局：纯静态结构检查
// ================================================================

const step5Start = bookingHtml.indexOf('<div id="step-5"');
const step5End = bookingHtml.indexOf('<div class="availability-overlay"');
const step5 = bookingHtml.slice(step5Start, step5End);

// 提取 600px 媒体块：从 @media 行到配对的闭合大括号为止
const extractMedia600 = () => {
    const start = bookingHtml.indexOf('@media (max-width: 600px)');
    assert.ok(start > 0, '600px media query must exist');
    let depth = 0;
    let i = start;
    for (; i < bookingHtml.length; i += 1) {
        const ch = bookingHtml[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    return bookingHtml.slice(start, i + 1);
};

test('Step 5 has exactly one policy card (Before You Pay); service-charge-notice is gone', () => {
    assert.ok(step5.includes('Before You Pay'), 'Step 5 must show the merged Before You Pay card');
    assert.ok(step5.includes('payment-important-notice'), 'merged card keeps payment-important-notice');
    assert.ok(!step5.includes('service-charge-notice'), 'Step 5 must not contain the old service-charge-notice');
    assert.ok(!bookingHtml.includes('<aside class="service-charge-notice"'), 'no service-charge-notice aside may remain anywhere');
    assert.ok(!bookingHtml.includes('.service-charge-notice'), 'no service-charge-notice CSS may remain');
    assert.ok(!bookingHtml.includes('Thank you for choosing 1383 Karaoke Bar.'), 'redundant thanks copy must be removed');
});

test('Step 5 exposes exactly three key disclosure items with all required terms', () => {
    const items = step5.split('class="payment-disclosure-item"').length - 1;
    assert.equal(items, 3, 'exactly three payment-disclosure-item blocks must exist');
    for (const phrase of [
        'Deposit only',
        'Pay at the venue',
        'Non-refundable',
        '18% Service Charge',
        'food &amp; beverage',
        'HST',
        'cancellations and no-shows',
        'except where required by law'
    ]) {
        assert.ok(step5.includes(phrase), `Step 5 disclosure must include: ${phrase}`);
    }
});

test('key terms stay outside the details; details only holds the service-charge reason and is closed by default', () => {
    const detailsIdx = step5.indexOf('<details class="service-charge-details">');
    assert.ok(detailsIdx > 0, 'service-charge-details element must exist');
    // 关键条款必须在 details 之前出现，不能被折叠
    for (const phrase of ['Deposit only', '18% Service Charge', 'HST', 'cancellations and no-shows', 'except where required by law']) {
        assert.ok(step5.indexOf(phrase) < detailsIdx, `"${phrase}" must appear before the details element`);
    }
    const detailsEnd = step5.indexOf('</details>', detailsIdx);
    const detailsBlock = step5.slice(detailsIdx, detailsEnd);
    assert.ok(!/^<details[^>]*\sopen/.test(detailsBlock), 'details must be closed by default (no open attribute)');
    assert.ok(detailsBlock.includes('<summary>Why is there an 18% Service Charge?</summary>'), 'summary text is fixed');
    assert.ok(detailsBlock.includes('The Service Charge helps cover room preparation, cleaning, ongoing service, and support staff.'), 'details holds the reason copy');
    // details 不能是任何关键条款唯一出现的位置，也不能藏入不退款/HST
    assert.ok(!detailsBlock.includes('non-refundable'), 'non-refundable must not be hidden in details');
    assert.ok(!detailsBlock.includes('HST'), 'HST must not be hidden in details');
    assert.ok(!detailsBlock.includes('applies to all room'), '18% applicability rule must not be hidden in details');
});

test('checkbox consent is a single sentence with no bullet list, still mandatory and unchecked', () => {
    const consentStart = bookingHtml.indexOf('id="payment-policy-consent"');
    assert.ok(consentStart > 0, 'payment-policy-consent must exist');
    const consentEnd = bookingHtml.indexOf('<div class="upsell-grid">', consentStart);
    const consentBlock = bookingHtml.slice(consentStart, consentEnd);
    assert.ok(consentBlock.includes('id="payment-policy-checkbox"'), 'checkbox id must exist');
    assert.ok(!consentBlock.includes('checked'), 'checkbox must not be pre-checked');
    assert.ok(consentBlock.includes('onchange="handlePaymentPolicyCheckboxChange()"'), 'checkbox handler must be preserved');
    assert.ok(!consentBlock.includes('<ul'), 'consent region must not contain a ul list');
    assert.ok(!consentBlock.includes('<li'), 'consent region must not contain li items');
    assert.ok(consentBlock.includes('class="payment-policy-copy"'), 'payment-policy-copy must wrap the sentence');
    for (const phrase of [
        'non-refundable booking deposit',
        'cancellations and no-shows',
        'except where required by law',
        '18% Service Charge',
        'all room and food &amp; beverage purchases',
        'HST',
        'I agree to the Booking &amp; Payment Policy'
    ]) {
        assert.ok(consentBlock.includes(phrase), `consent sentence must include: ${phrase}`);
    }
    assert.ok(consentBlock.includes('id="payment-policy-error"'), 'payment-policy-error must remain');
    assert.ok(consentBlock.includes('role="alert"'), 'error alert semantics must remain');
    assert.ok(consentBlock.includes('aria-live="polite"'), 'error aria-live must remain');
});

test('policy link sits outside the label with the exact href/target/rel', () => {
    const linkIdx = bookingHtml.indexOf('class="payment-policy-link"');
    assert.ok(linkIdx > 0, 'payment-policy-link must exist');
    const linkBlock = bookingHtml.slice(linkIdx, linkIdx + 260);
    assert.match(linkBlock, /href="legal\.html#booking-payment-policy"/);
    assert.match(linkBlock, /target="_blank"/);
    assert.match(linkBlock, /rel="noopener noreferrer"/);
    assert.ok(linkBlock.includes('Review Booking &amp; Payment Policy'), 'link text must be Review Booking & Payment Policy');
    const labelStart = bookingHtml.indexOf('<label for="payment-policy-checkbox"');
    const labelEnd = bookingHtml.indexOf('</label>', labelStart);
    assert.ok(labelStart > 0 && labelEnd > labelStart, 'payment label must exist');
    assert.ok(linkIdx > labelEnd, 'link must be outside the label to avoid toggling the checkbox');
});

test('payment behavior markers (ids, onclick, handlers) are unchanged', () => {
    for (const marker of [
        'id="pay-with-stripe-btn"',
        'onclick="startPayment(\'stripe\')"',
        'id="stripe-status-text"',
        'id="payment-step-hint"',
        'id="refresh-payment-status-btn"',
        'id="payment-policy-checkbox"',
        'goBackFromPaymentStep()',
        'refreshPaymentQuote()'
    ]) {
        assert.ok(bookingHtml.includes(marker), `payment marker must remain: ${marker}`);
    }
});

test('600px mobile breakpoint compacts the payment area (single column, 22px checkbox, 44px summary, 52px button)', () => {
    const media600 = extractMedia600();
    assert.ok(media600.includes('.payment-disclosure-list'), 'disclosure list must be styled on mobile');
    assert.ok(media600.includes('grid-template-columns: 1fr'), 'disclosures must stack to one column on mobile');
    assert.ok(media600.includes('.payment-policy-label input'), 'checkbox must be styled on mobile');
    assert.ok(media600.includes('width: 22px') && media600.includes('height: 22px'), 'mobile checkbox must be 22x22');
    assert.ok(media600.includes('.service-charge-details summary'), 'details summary must be styled on mobile');
    assert.ok(media600.includes('min-height: 44px'), 'summary tap target must be at least 44px');
    assert.ok(media600.includes('#pay-with-stripe-btn'), 'Stripe button must be styled on mobile');
    assert.ok(media600.includes('min-height: 52px'), 'Stripe button must be at least 52px tall');
    assert.ok(media600.includes('width: 100%'), 'Stripe button must be full width on mobile');
});

test('600px block never hides or truncates key payment content', () => {
    const media600 = extractMedia600();
    assert.ok(!media600.includes('display: none'), 'mobile CSS must not hide key payment content');
    assert.ok(!media600.includes('overflow: hidden'), 'mobile CSS must not clip key payment content');
    // 三个关键容器自身不得使用固定 height 截断（checkbox 的 22px 固定尺寸是任务要求，允许）
    for (const sel of ['.payment-important-notice', '.payment-disclosure-list', '.payment-policy-consent']) {
        const ruleStart = media600.indexOf(sel + ' {');
        assert.ok(ruleStart > 0, `${sel} rule must exist in the mobile block`);
        const rule = media600.slice(ruleStart, media600.indexOf('}', ruleStart) + 1);
        assert.ok(!rule.includes('height:'), `${sel} must not use a fixed height on mobile`);
        assert.ok(!rule.includes('overflow:'), `${sel} must not clip content on mobile`);
    }
});

test('the payment JS entry points (startPayment/updatePaymentButtonState/clearPaymentPolicyConsent/handlePaymentPolicyCheckboxChange) still exist', () => {
    const scripts = [...bookingHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .filter((s) => s.trim());
    assert.ok(scripts.length > 0, 'inline scripts must exist');
    const lastScript = scripts[scripts.length - 1];
    assert.match(lastScript, /function startPayment/);
    assert.match(lastScript, /function updatePaymentButtonState/);
    assert.match(lastScript, /function clearPaymentPolicyConsent/);
    assert.match(lastScript, /function handlePaymentPolicyCheckboxChange/);
});

// ================================================================
// 数据库冻结静态验证（对比 HEAD 基线 SQL 集合）
// ================================================================

test('SQL statement set is unchanged vs the HEAD baseline', () => {
    const { execSync } = require('node:child_process');
    const headSrc = execSync(`git show HEAD:${'app'}.js`, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: ROOT,
        encoding: 'utf8'
    });
    const currentSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    const extractSql = (src) => {
        const out = [];
        const re = /\`([\s\S]*?)\`/g;
        let m;
        while ((m = re.exec(src))) {
            const text = m[1];
            if (/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE bookings|DELETE FROM|SELECT/.test(text) && text.length < 600) {
                out.push(text.replace(/\s+/g, ' ').trim());
            }
        }
        return out;
    };

    const headSql = new Set(extractSql(headSrc));
    const currentSql = extractSql(currentSrc);
    const added = currentSql.filter((s) => !headSql.has(s));
    const removed = [...headSql].filter((s) => !currentSql.includes(s));
    assert.deepEqual(added, [], 'no new SQL statements vs HEAD');
    assert.deepEqual(removed, [], 'no removed SQL statements vs HEAD');
});
