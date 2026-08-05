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
    const metadataBlock = appSource.match(/metadata: \{[\s\S]*?termsAcceptedAt: acceptedAt\s*\}/)?.[0] || '';
    assert.ok(metadataBlock, 'metadata block should be found');
    assert.match(metadataBlock, /termsAccepted: 'true'/);
    assert.match(metadataBlock, /policyVersion: BOOKING_POLICY_VERSION/);
    assert.match(metadataBlock, /policyHash: BOOKING_POLICY_HASH/);
    assert.match(metadataBlock, /termsAcceptedAt: acceptedAt/);
    assert.ok(!metadataBlock.includes('phone'), 'metadata must not include phone number');
    assert.ok(!metadataBlock.includes('name'), 'metadata must not include customer name');
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
