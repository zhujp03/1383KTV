// app.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const app = express();
const PORT = 3000;
const BCRYPT_ROUNDS = 10;
const DEFAULT_DATABASE_DIR = path.join(__dirname, 'database');
const DATABASE_DIR_INPUT = String(process.env.DATABASE_DIR || DEFAULT_DATABASE_DIR).trim();
const DATABASE_DIR = path.isAbsolute(DATABASE_DIR_INPUT)
    ? DATABASE_DIR_INPUT
    : path.join(__dirname, DATABASE_DIR_INPUT);
const KTV_DB_PATH = path.join(DATABASE_DIR, 'ktv_data.db');
const ADMIN_DB_PATH = path.join(DATABASE_DIR, 'admin.db');
const HISTORY_DB_PATH = path.join(DATABASE_DIR, 'history_orders.db');
const CUSTOMER_DB_PATH = path.join(DATABASE_DIR, 'valid_customers.db');
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);

const BOOKING_IP_WINDOW_MS = Number(process.env.BOOKING_IP_WINDOW_MS || 10 * 60 * 1000);
const BOOKING_IP_MAX_REQUESTS = Number(process.env.BOOKING_IP_MAX_REQUESTS || 30);
const BOOKING_IP_MIN_INTERVAL_MS = Number(process.env.BOOKING_IP_MIN_INTERVAL_MS || 15 * 1000);
const BOOKING_PHONE_WINDOW_MS = Number(process.env.BOOKING_PHONE_WINDOW_MS || 60 * 60 * 1000);
const BOOKING_PHONE_MAX_REQUESTS = Number(process.env.BOOKING_PHONE_MAX_REQUESTS || 2);
const BOOKING_PHONE_MIN_INTERVAL_MS = Number(process.env.BOOKING_PHONE_MIN_INTERVAL_MS || 30 * 1000);
const ALLOWED_PHONE_COUNTRIES = String(process.env.ALLOWED_PHONE_COUNTRIES || 'CA,US')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

const CAPTCHA_PROVIDER = String(process.env.CAPTCHA_PROVIDER || 'turnstile').trim().toLowerCase();
const TURNSTILE_SITE_KEY = String(process.env.TURNSTILE_SITE_KEY || '').trim();
const TURNSTILE_SECRET_KEY = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
const CAPTCHA_ENABLED = CAPTCHA_PROVIDER === 'turnstile' && Boolean(TURNSTILE_SITE_KEY) && Boolean(TURNSTILE_SECRET_KEY);

const GHL_API_BASE_URL = String(process.env.GHL_API_BASE_URL || 'https://services.leadconnectorhq.com').replace(/\/+$/, '');
const GHL_API_VERSION = String(process.env.GHL_API_VERSION || '2021-07-28').trim();
const GHL_PRIVATE_TOKEN = String(process.env.GHL_PRIVATE_TOKEN || '').trim();
const GHL_LOCATION_ID = String(process.env.GHL_LOCATION_ID || '').trim();
const GHL_BOOKING_WORKFLOW_ID = String(process.env.GHL_BOOKING_WORKFLOW_ID || '').trim();
const GHL_REQUEST_TIMEOUT_MS = Number(process.env.GHL_REQUEST_TIMEOUT_MS || 8000);
const GHL_ENABLED = Boolean(GHL_PRIVATE_TOKEN && GHL_LOCATION_ID && GHL_BOOKING_WORKFLOW_ID);

const ipLastRequestAt = new Map();
const phoneRequestState = new Map();
const THROTTLE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

fs.mkdirSync(DATABASE_DIR, { recursive: true });

function copySeedDatabaseIfNeeded(fileName, targetPath) {
    if (DATABASE_DIR === DEFAULT_DATABASE_DIR) return;
    const seedPath = path.join(DEFAULT_DATABASE_DIR, fileName);
    if (fs.existsSync(targetPath)) return;
    if (!fs.existsSync(seedPath)) return;
    fs.copyFileSync(seedPath, targetPath);
    console.log(`📦 Seeded database file '${fileName}' to ${DATABASE_DIR}`);
}

copySeedDatabaseIfNeeded('ktv_data.db', KTV_DB_PATH);
copySeedDatabaseIfNeeded('admin.db', ADMIN_DB_PATH);
copySeedDatabaseIfNeeded('history_orders.db', HISTORY_DB_PATH);
copySeedDatabaseIfNeeded('valid_customers.db', CUSTOMER_DB_PATH);

if (TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS);

// ==========================================
// 1. 中间件配置
// ==========================================
app.use(cors()); // 允许前端跨域请求
app.use(express.json({ limit: '100kb' })); // 允许 Express 解析前端发来的 JSON 数据
app.use(express.static(path.join(__dirname))); // 托管静态文件

const bookingIpRateLimiter = rateLimit({
    windowMs: BOOKING_IP_WINDOW_MS,
    max: BOOKING_IP_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many booking attempts from this IP. Please wait and try again.'
    }
});

app.get('/', (req, res) => {
    res.redirect('/pages/homeindex.html');
});

// ==========================================
// 2. 数据库连接 (database/ 目录下的数据库文件)
// ==========================================

// 初始化业务数据库 (预订信息)
// const db = new sqlite3.Database(KTV_DB_PATH, (err) => {
//     if (err) {
//         console.error('KTV Database connection failed:', err.message);
//     } else {
//         console.log('✅ Connected to ktv_data.db successfully.');
//         // 确保预订数据表存在
//         db.run(`CREATE TABLE IF NOT EXISTS bookings (
//             id INTEGER PRIMARY KEY AUTOINCREMENT,
//             room TEXT NOT NULL,
//             partySize INTEGER NOT NULL,
//             date TEXT NOT NULL,
//             time TEXT NOT NULL,
//             duration TEXT NOT NULL,
//             name TEXT NOT NULL,
//             phone TEXT NOT NULL,
//             created_at DATETIME DEFAULT CURRENT_TIMESTAMP
//         )`);
//     }
// });

// 初始化业务数据库 (预订信息)
const db = new sqlite3.Database(KTV_DB_PATH, (err) => {
    if (err) {
        console.error('KTV Database connection failed:', err.message);
    } else {
        console.log('✅ Connected to ktv_data.db successfully.');
        // 1. 创建基础表
        db.run(`CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT NOT NULL,
            partySize INTEGER NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            duration TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // 🌟 2. 数据库无损升级技巧：尝试添加 deposit 字段 (如果已经存在会报错，但我们忽略报错)
            db.run(`ALTER TABLE bookings ADD COLUMN deposit TEXT DEFAULT 'No'`, (err) => {
                if (!err) console.log("🌟 数据库自动升级：已增加 'deposit' 押金字段");
            });
        });
    }
});

// 初始化后台数据库 (管理员信息)
const adminDb = new sqlite3.Database(ADMIN_DB_PATH, (err) => {
    if (err) {
        console.error('Admin DB failed:', err.message);
    } else {
        console.log('✅ Connected to admin.db successfully.');
        // 确保 admins 表存在
        adminDb.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )`, async (tableErr) => {
            if (tableErr) {
                console.error('Failed to prepare admins table:', tableErr.message);
                return;
            }
            await migratePlaintextAdminPasswords();
        });
    }
});

// 历史订单数据库（最多保留两个月）
const historyDb = new sqlite3.Database(HISTORY_DB_PATH, (err) => {
    if (err) {
        console.error('History DB failed:', err.message);
    } else {
        console.log('✅ Connected to history_orders.db successfully.');
        historyDb.run(`CREATE TABLE IF NOT EXISTS historical_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER UNIQUE,
            room TEXT NOT NULL,
            partySize INTEGER NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            duration TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            deposit TEXT DEFAULT 'No',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (tableErr) => {
            if (tableErr) return;

            // Enforce historical_orders as deposit=Yes only; clear legacy No rows once at startup.
            historyDb.run(`DELETE FROM historical_orders WHERE LOWER(TRIM(COALESCE(deposit, ''))) != 'yes'`, () => {
                cleanupOldHistoricalOrders();
            });
        });
    }
});

// 有效客户数据库（姓名+手机号复合主键）
const customerDb = new sqlite3.Database(CUSTOMER_DB_PATH, (err) => {
    if (err) {
        console.error('Valid Customer DB failed:', err.message);
    } else {
        console.log('✅ Connected to valid_customers.db successfully.');
        customerDb.run(`CREATE TABLE IF NOT EXISTS valid_customers (
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (name, phone)
        )`);
    }
});

// ==========================================
// 3. 通用辅助函数与权限中间件
// ==========================================

// 自动清理过期预约的函数
function cleanupOldBookings() {
    // 删除所有 date 小于今天本地日期的记录
    const sql = `DELETE FROM bookings WHERE date < date('now', 'localtime')`;
    db.run(sql, function(err) {
        if (err) console.error("Auto-cleanup failed:", err);
        else if (this.changes > 0) {
            console.log(`🧹 Auto-cleanup executed: Deleted ${this.changes} outdated bookings.`);
        }
    });
}

// 自动清理两个月前的历史订单
function cleanupOldHistoricalOrders() {
    const sql = `DELETE FROM historical_orders WHERE created_at < datetime('now', 'localtime', '-2 months')`;
    historyDb.run(sql, function(err) {
        if (err) {
            console.error('History auto-cleanup failed:', err);
        } else if (this.changes > 0) {
            console.log(`🧹 History cleanup executed: Deleted ${this.changes} outdated historical orders.`);
        }
    });
}

function normalizeDepositValue(deposit) {
    return String(deposit || '').trim().toLowerCase() === 'yes' ? 'Yes' : 'No';
}

function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

async function hashPassword(plainPassword) {
    return bcrypt.hash(String(plainPassword || ''), BCRYPT_ROUNDS);
}

async function verifyAdminPassword(inputPassword, storedPassword) {
    if (isBcryptHash(storedPassword)) {
        return await bcrypt.compare(String(inputPassword || ''), storedPassword);
    }
    return String(inputPassword || '') === String(storedPassword || '');
}

function adminDbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        adminDb.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function adminDbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        adminDb.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function adminDbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        adminDb.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function getClientIp(req) {
    return String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown');
}

function cleanupThrottleStores() {
    const now = Date.now();
    for (const [ip, lastSeen] of ipLastRequestAt.entries()) {
        if (now - lastSeen > BOOKING_IP_WINDOW_MS) {
            ipLastRequestAt.delete(ip);
        }
    }

    for (const [phone, state] of phoneRequestState.entries()) {
        const keptTimestamps = (state.timestamps || []).filter((ts) => now - ts <= BOOKING_PHONE_WINDOW_MS);
        if (!keptTimestamps.length && (!state.lastSeenAt || now - state.lastSeenAt > BOOKING_PHONE_WINDOW_MS)) {
            phoneRequestState.delete(phone);
            continue;
        }
        phoneRequestState.set(phone, {
            timestamps: keptTimestamps,
            lastSeenAt: state.lastSeenAt || now
        });
    }
}

setInterval(cleanupThrottleStores, THROTTLE_CLEANUP_INTERVAL_MS).unref();

function enforceIpBookingCooldown(req, res, next) {
    const now = Date.now();
    const clientIp = getClientIp(req);
    const lastAt = ipLastRequestAt.get(clientIp) || 0;
    const waitMs = BOOKING_IP_MIN_INTERVAL_MS - (now - lastAt);

    if (waitMs > 0) {
        return res.status(429).json({
            error: `Too many requests from the same IP. Please wait ${Math.ceil(waitMs / 1000)} seconds before trying again.`
        });
    }

    ipLastRequestAt.set(clientIp, now);
    next();
}

function normalizeAndValidatePhoneNumber(rawPhone) {
    const input = String(rawPhone || '').trim();
    if (!input) {
        return { ok: false, error: 'Phone number is required.' };
    }

    const digitsOnly = input.replace(/[^\d]/g, '');
    let candidate = input;

    if (!candidate.startsWith('+')) {
        if (digitsOnly.length === 10) {
            candidate = `+1${digitsOnly}`;
        } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
            candidate = `+${digitsOnly}`;
        } else {
            candidate = `+${digitsOnly}`;
        }
    }

    const parsed = parsePhoneNumberFromString(candidate);
    if (!parsed || !parsed.isValid()) {
        return { ok: false, error: 'Phone number is invalid. Please enter a real CA/US phone number.' };
    }

    const country = String(parsed.country || '').toUpperCase();
    if (ALLOWED_PHONE_COUNTRIES.length > 0 && !ALLOWED_PHONE_COUNTRIES.includes(country)) {
        return { ok: false, error: `Phone number country is not allowed. Allowed countries: ${ALLOWED_PHONE_COUNTRIES.join(', ')}.` };
    }

    return {
        ok: true,
        e164: parsed.number,
        national: parsed.formatNational(),
        country
    };
}

function buildPhoneQueryCandidates(rawPhone) {
    const raw = String(rawPhone || '').trim();
    const digits = raw.replace(/[^\d]/g, '');
    const candidates = new Set();

    if (raw) candidates.add(raw);
    if (digits) candidates.add(digits);
    if (digits.length === 10) candidates.add(`1${digits}`);
    if (digits.length === 11 && digits.startsWith('1')) candidates.add(digits.slice(1));

    const normalized = normalizeAndValidatePhoneNumber(raw);
    if (normalized.ok) {
        candidates.add(normalized.e164);
        if (normalized.e164.startsWith('+1')) candidates.add(normalized.e164.slice(2));
    }

    return Array.from(candidates).filter(Boolean);
}

function enforcePhoneBookingLimit(normalizedPhone) {
    const now = Date.now();
    const prev = phoneRequestState.get(normalizedPhone) || { timestamps: [], lastSeenAt: 0 };
    const recentTimestamps = prev.timestamps.filter((ts) => now - ts <= BOOKING_PHONE_WINDOW_MS);
    const sinceLast = now - (prev.lastSeenAt || 0);

    if (prev.lastSeenAt && sinceLast < BOOKING_PHONE_MIN_INTERVAL_MS) {
        return {
            ok: false,
            statusCode: 429,
            error: `This phone number requested too frequently. Please wait ${Math.ceil((BOOKING_PHONE_MIN_INTERVAL_MS - sinceLast) / 1000)} seconds and try again.`
        };
    }

    if (recentTimestamps.length >= BOOKING_PHONE_MAX_REQUESTS) {
        const waitMs = BOOKING_PHONE_WINDOW_MS - (now - recentTimestamps[0]);
        return {
            ok: false,
            statusCode: 429,
            error: `This phone number has reached the booking attempt limit. Please wait ${Math.ceil(waitMs / 1000)} seconds.`
        };
    }

    recentTimestamps.push(now);
    phoneRequestState.set(normalizedPhone, {
        timestamps: recentTimestamps,
        lastSeenAt: now
    });

    return { ok: true };
}

function splitName(fullName) {
    const safe = String(fullName || '').trim().replace(/\s+/g, ' ');
    if (!safe) return { firstName: '', lastName: '' };
    const [firstName, ...rest] = safe.split(' ');
    return {
        firstName: firstName || '',
        lastName: rest.join(' ')
    };
}

function compactJson(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    if (safe.length <= 150) return safe;
    return `${safe.slice(0, 147)}...`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GHL_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function safeReadJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (err) {
        return { raw: text };
    }
}

function getGhlHeaders() {
    return {
        Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json'
    };
}

function extractGhlContactId(payload) {
    return payload?.contact?.id
        || payload?.contactId
        || payload?.id
        || payload?._id
        || payload?.data?.contact?.id
        || payload?.data?.id
        || '';
}

async function upsertContactInGhl(booking) {
    const { firstName, lastName } = splitName(booking.name);
    const customFields = [
        { key: 'booking_room', field_value: booking.room },
        { key: 'booking_party_size', field_value: String(booking.partySize) },
        { key: 'booking_date', field_value: booking.date },
        { key: 'booking_time', field_value: booking.time },
        { key: 'booking_duration', field_value: String(booking.duration) },
        { key: 'booking_id', field_value: String(booking.bookingId) },
        { key: 'booking_upsell_interest', field_value: booking.upsellInterest || '' }
    ];

    const basePayload = {
        locationId: GHL_LOCATION_ID,
        name: booking.name,
        firstName,
        lastName,
        phone: booking.phone,
        source: '1383KTV Booking',
        tags: ['booking-request']
    };

    const attempts = [
        { ...basePayload, customFields },
        { ...basePayload }
    ];

    let lastError = null;

    for (const requestPayload of attempts) {
        const response = await fetchWithTimeout(`${GHL_API_BASE_URL}/contacts/upsert`, {
            method: 'POST',
            headers: getGhlHeaders(),
            body: JSON.stringify(requestPayload)
        });

        const payload = await safeReadJson(response);
        if (!response.ok) {
            lastError = new Error(`GHL contact upsert failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
            continue;
        }

        const contactId = extractGhlContactId(payload);
        if (!contactId) {
            lastError = new Error(`GHL contact upsert succeeded but no contactId was returned: ${compactJson(JSON.stringify(payload))}`);
            continue;
        }

        return contactId;
    }

    throw lastError || new Error('GHL contact upsert failed with unknown error.');
}

async function addContactToGhlWorkflow(contactId) {
    const workflowUrl = `${GHL_API_BASE_URL}/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(GHL_BOOKING_WORKFLOW_ID)}`;
    const attempts = [
        {
            method: 'POST',
            headers: getGhlHeaders(),
            body: JSON.stringify({ locationId: GHL_LOCATION_ID })
        },
        {
            method: 'POST',
            headers: getGhlHeaders()
        }
    ];

    let lastError = null;

    for (const requestOptions of attempts) {
        const response = await fetchWithTimeout(workflowUrl, requestOptions);
        const payload = await safeReadJson(response);
        if (response.ok) return;
        lastError = new Error(`GHL workflow trigger failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
    }

    throw lastError || new Error('GHL workflow trigger failed with unknown error.');
}

async function triggerBookingMessageInGhl(booking) {
    if (!GHL_ENABLED) {
        return { sent: false, reason: 'GHL integration is not configured.' };
    }

    const contactId = await upsertContactInGhl(booking);
    await addContactToGhlWorkflow(contactId);

    return { sent: true, contactId };
}

async function verifyCaptchaToken(captchaToken, req) {
    if (!CAPTCHA_ENABLED) {
        return { ok: true, skipped: true };
    }

    const token = String(captchaToken || '').trim();
    if (!token) {
        return { ok: false, error: 'Captcha verification is required.' };
    }

    const form = new URLSearchParams();
    form.set('secret', TURNSTILE_SECRET_KEY);
    form.set('response', token);
    form.set('remoteip', getClientIp(req));

    try {
        const response = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString()
        }, 5000);

        const payload = await safeReadJson(response);
        if (!response.ok) {
            return { ok: false, error: 'Captcha service failed. Please try again later.' };
        }
        if (!payload.success) {
            return { ok: false, error: 'Captcha verification failed. Please retry.' };
        }
        return { ok: true };
    } catch (err) {
        console.error('Captcha verification request failed:', err.message);
        return { ok: false, error: 'Captcha verification failed due to network issue. Please retry.' };
    }
}

function validateBookingRequest(rawData) {
    const booking = rawData || {};
    const room = String(booking.room || '').trim();
    const date = String(booking.date || '').trim();
    const time = String(booking.time || '').trim();
    const duration = Number(booking.duration);
    const partySize = Number(booking.partySize);
    const name = String(booking.name || '').trim().replace(/\s+/g, ' ');
    const upsellInterest = String(booking.upsellInterest || '').trim().slice(0, 80);

    if (!room || !date || !time || !name || !Number.isFinite(duration) || !Number.isFinite(partySize)) {
        return { ok: false, error: 'Missing required booking fields.' };
    }

    if (name.length < 2 || name.length > 80) {
        return { ok: false, error: 'Name length must be between 2 and 80 characters.' };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, error: 'Invalid booking date format.' };
    }

    if (!/^\d{1,2}:\d{2}$/.test(time)) {
        return { ok: false, error: 'Invalid booking time format.' };
    }

    if (![1, 2].includes(duration)) {
        return { ok: false, error: 'Online booking currently supports 1 or 2 hours only.' };
    }

    if (partySize < 1 || partySize > 30) {
        return { ok: false, error: 'Party size must be between 1 and 30.' };
    }

    const phoneCheck = normalizeAndValidatePhoneNumber(booking.phone);
    if (!phoneCheck.ok) return phoneCheck;

    return {
        ok: true,
        data: {
            room,
            partySize,
            date,
            time,
            duration,
            name,
            phone: phoneCheck.e164,
            upsellInterest
        }
    };
}

async function migratePlaintextAdminPasswords() {
    try {
        const admins = await adminDbAll(`SELECT id, username, password FROM admins`);
        for (const admin of admins) {
            if (isBcryptHash(admin.password)) continue;
            const hashed = await hashPassword(admin.password);
            await adminDbRun(`UPDATE admins SET password = ? WHERE id = ?`, [hashed, admin.id]);
            console.log(`🔐 Migrated admin password to hash for user: ${admin.username}`);
        }
    } catch (err) {
        console.error('Failed to migrate plaintext admin passwords:', err.message);
    }
}

function syncValidCustomer(name, phone) {
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').trim();
    if (!safeName || !safePhone) return;

    const sql = `INSERT INTO valid_customers (name, phone)
                 VALUES (?, ?)
                 ON CONFLICT(name, phone)
                 DO UPDATE SET last_seen = CURRENT_TIMESTAMP`;
    customerDb.run(sql, [safeName, safePhone], (err) => {
        if (err) console.error('Failed to sync valid customer:', err.message);
    });
}

// 删除 valid_customer (用于 deposit 回滚)
function removeValidCustomer(name, phone) {
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').trim();
    if (!safeName || !safePhone) return;

    const sql = `DELETE FROM valid_customers WHERE name = ? AND phone = ?`;
    customerDb.run(sql, [safeName, safePhone], (err) => {
        if (err) console.error('Failed to remove valid customer:', err.message);
    });
}

// 删除 historical_order (用于 deposit 回滚)
function removeHistoricalOrder(bookingId) {
    const sql = `DELETE FROM historical_orders WHERE booking_id = ?`;
    historyDb.run(sql, [bookingId], (err) => {
        if (err) console.error('Failed to remove historical order:', err.message);
    });
}

function syncHistoricalOrder(booking) {
    const normalizedDeposit = normalizeDepositValue(booking.deposit);
    if (normalizedDeposit !== 'Yes') {
        removeHistoricalOrder(Number(booking.booking_id));
        return;
    }

    const sql = `INSERT INTO historical_orders (booking_id, room, partySize, date, time, duration, name, phone, deposit)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(booking_id)
                 DO UPDATE SET
                    room = excluded.room,
                    partySize = excluded.partySize,
                    date = excluded.date,
                    time = excluded.time,
                    duration = excluded.duration,
                    name = excluded.name,
                    phone = excluded.phone,
                    deposit = excluded.deposit`;

    historyDb.run(sql, [
        booking.booking_id,
        booking.room,
        booking.partySize,
        booking.date,
        booking.time,
        booking.duration,
        booking.name,
        booking.phone,
        normalizedDeposit
    ], (err) => {
        if (err) console.error('Failed to sync historical order:', err.message);
    });
}

// 每天执行一次历史订单清理
setInterval(cleanupOldHistoricalOrders, 24 * 60 * 60 * 1000);

// 极简身份验证中间件 (用于保护后台 API)
function checkAdminLogin(req, res, next) {
    const adminUser = req.headers['x-admin-username'];
    if (!adminUser) {
        return res.status(401).json({ error: 'Access denied. Please log in first.' });
    }
    req.adminUser = adminUser; // 将当前管理员名字存入请求对象
    next();
}

// ==========================================
// 4. API 路由区域: 客户端前台
// ==========================================

app.get('/api/public/security-config', (req, res) => {
    res.status(200).json({
        captchaEnabled: CAPTCHA_ENABLED,
        captchaProvider: CAPTCHA_ENABLED ? 'turnstile' : '',
        turnstileSiteKey: CAPTCHA_ENABLED ? TURNSTILE_SITE_KEY : ''
    });
});

// 4.1 客户提交预订 API
app.post('/api/book', bookingIpRateLimiter, enforceIpBookingCooldown, async (req, res) => {
    const validation = validateBookingRequest(req.body);
    if (!validation.ok) {
        return res.status(400).json({ error: validation.error || 'Invalid booking payload.' });
    }

    const captchaResult = await verifyCaptchaToken(req.body?.captchaToken, req);
    if (!captchaResult.ok) {
        return res.status(400).json({ error: captchaResult.error || 'Captcha verification failed.' });
    }

    const bookingData = validation.data;
    const phoneLimitResult = enforcePhoneBookingLimit(bookingData.phone);
    if (!phoneLimitResult.ok) {
        return res.status(phoneLimitResult.statusCode || 429).json({ error: phoneLimitResult.error });
    }

    const sql = `INSERT INTO bookings (room, partySize, date, time, duration, name, phone) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    try {
        const runResult = await dbRun(sql, [
            bookingData.room,
            bookingData.partySize,
            bookingData.date,
            bookingData.time,
            bookingData.duration,
            bookingData.name,
            bookingData.phone
        ]);
        const bookingId = runResult.lastID;
        syncValidCustomer(bookingData.name, bookingData.phone);

        let notification = { sent: false, reason: '' };
        try {
            notification = await triggerBookingMessageInGhl({
                bookingId,
                room: bookingData.room,
                partySize: bookingData.partySize,
                date: bookingData.date,
                time: bookingData.time,
                duration: bookingData.duration,
                name: bookingData.name,
                phone: bookingData.phone,
                upsellInterest: bookingData.upsellInterest
            });
        } catch (notifyErr) {
            console.error('GHL integration failed:', notifyErr.message);
            notification = { sent: false, reason: notifyErr.message };
        }

        res.status(200).json({
            message: 'Booking successful!',
            bookingId,
            notification,
            normalizedPhone: bookingData.phone
        });
    } catch (err) {
        console.error('Error inserting data:', err.message);
        return res.status(500).json({ error: 'Failed to save booking to database.' });
    }
});

// 4.2 客户查询预订 API (根据手机号)
app.get('/api/book/search/:phone', (req, res) => {
    const searchPhone = req.params.phone;
    const phoneCandidates = buildPhoneQueryCandidates(searchPhone);

    if (!phoneCandidates.length) {
        return res.status(400).json({ error: 'Invalid phone number.' });
    }

    // 根据手机号查询，按照日期和时间降序排列 (最新的排前面)
    const placeholders = phoneCandidates.map(() => '?').join(', ');
    const sql = `SELECT * FROM bookings WHERE phone IN (${placeholders}) ORDER BY date DESC, time DESC`;

    db.all(sql, phoneCandidates, (err, rows) => {
        if (err) {
            console.error('Error searching bookings:', err);
            return res.status(500).json({ error: 'Failed to search bookings.' });
        }
        res.status(200).json({ data: rows });
    });
});

// 4.3 客户取消预订 API (用户输入手机号和预订 ID)
app.delete('/api/book/cancel/:id/:phone', (req, res) => {
    const bookingId = req.params.id;
    const phone = req.params.phone;
    const phoneCandidates = buildPhoneQueryCandidates(phone);

    if (!phoneCandidates.length) {
        return res.status(400).json({ error: 'Invalid phone number.' });
    }

    // 验证这个预订是否属于这个手机号
    const placeholders = phoneCandidates.map(() => '?').join(', ');
    db.get(`SELECT id, name, phone, deposit FROM bookings WHERE id = ? AND phone IN (${placeholders})`, [bookingId, ...phoneCandidates], (err, booking) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        if (!booking) return res.status(404).json({ error: 'Booking not found or phone number does not match.' });

        // 删除 bookings 表里的记录
        db.run(`DELETE FROM bookings WHERE id = ?`, [bookingId], function(bookingErr) {
            if (bookingErr) return res.status(500).json({ error: 'Failed to cancel booking.' });

            // 如果这个预订的 deposit 是 Yes，也要从 history_orders 和 valid_customers 删除
            if (normalizeDepositValue(booking.deposit) === 'Yes') {
                removeHistoricalOrder(Number(bookingId));
                removeValidCustomer(booking.name, booking.phone);
            }

            res.json({ message: 'Booking cancelled successfully.' });
        });
    });
});

// ==========================================
// 🌟 4.3 新增：前台公开的查询接口 (用于防碰撞检测)
// ==========================================
// 注意：这个接口不需要管理员密码，任何人都可以访问。
// 为了保护隐私，只返回算冲突所必需的字段，绝不返回客人的姓名和电话。
app.get('/api/public/bookings', (req, res) => {
    // 按理说这里可以通过 req.query.date 过滤指定日期，为了简单我们暂时全拿出来给前端算
    const sql = `SELECT room, partySize, date, time, duration FROM bookings`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Failed to fetch public bookings:', err);
            return res.status(500).json({ error: 'Failed to fetch bookings data.' });
        }
        res.status(200).json({ total: rows.length, data: rows });
    });
});

// ==========================================
// 5. API 路由区域: 后台管理 (带权限校验)
// ==========================================

// 5.1 管理员登录 API
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const row = await adminDbGet("SELECT * FROM admins WHERE username = ?", [username]);
        if (!row) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const isValid = await verifyAdminPassword(password, row.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // Lazy upgrade: if account is still plaintext, hash it on successful login.
        if (!isBcryptHash(row.password)) {
            const hashed = await hashPassword(password);
            await adminDbRun("UPDATE admins SET password = ? WHERE id = ?", [hashed, row.id]);
        }

        // 登录成功时触发一次过期清理
        cleanupOldBookings();
        cleanupOldHistoricalOrders();

        res.json({ message: 'Login successful', username: row.username });
    } catch (err) {
        console.error('Admin login failed:', err.message);
        res.status(500).json({ error: 'Login failed due to server error.' });
    }
});

// 5.2 获取所有预订记录 API (受保护)
app.get('/api/admin/bookings', checkAdminLogin, (req, res) => {
    const sql = `SELECT * FROM bookings ORDER BY date ASC, time ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch bookings.' });
        res.status(200).json({ total: rows.length, data: rows });
    });
});

// 历史订单列表（最近两个月）
app.get('/api/admin/history-orders', checkAdminLogin, (req, res) => {
    const sql = `SELECT * FROM historical_orders WHERE deposit = 'Yes' ORDER BY created_at DESC, date DESC, time DESC`;
    historyDb.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch historical orders.' });
        res.status(200).json({ total: rows.length, data: rows });
    });
});

// 有效客户列表（去重：name + phone）
app.get('/api/admin/valid-customers', checkAdminLogin, (req, res) => {
    const sql = `SELECT name, phone, first_seen, last_seen FROM valid_customers ORDER BY last_seen DESC`;
    customerDb.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch valid customers.' });
        res.status(200).json({ total: rows.length, data: rows });
    });
});

// 5.3 获取管理员列表 API (受保护)
app.get('/api/admin/list', checkAdminLogin, (req, res) => {
    adminDb.all("SELECT id, username FROM admins", [], (err, rows) => {
        res.json(rows);
    });
});

// 5.4 添加新管理员 API (受保护)
app.post('/api/admin/add', checkAdminLogin, async (req, res) => {
    const { newUsername, newPassword } = req.body;

    try {
        const hashedPassword = await hashPassword(newPassword);
        const runResult = await adminDbRun("INSERT INTO admins (username, password) VALUES (?, ?)", [newUsername, hashedPassword]);
        res.json({ message: 'New admin added successfully.', id: runResult.lastID });
    } catch (err) {
        if (String(err.message || '').includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists.' });
        }
        res.status(500).json({ error: 'Failed to add admin.' });
    }
});

// 5.5 修改其他管理员密码 API (受保护)
app.put('/api/admin/password/:id', checkAdminLogin, async (req, res) => {
    const adminIdToUpdate = req.params.id;
    const { newPassword } = req.body;

    try {
        const hashedPassword = await hashPassword(newPassword);
        await adminDbRun("UPDATE admins SET password = ? WHERE id = ?", [hashedPassword, adminIdToUpdate]);
        res.json({ message: 'Password updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update password.' });
    }
});

// 5.6 删除管理员 API (受保护)
app.delete('/api/admin/delete/:id', checkAdminLogin, (req, res) => {
    const adminIdToDelete = req.params.id;

    adminDb.run("DELETE FROM admins WHERE id = ?", [adminIdToDelete], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete admin.' });
        res.json({ message: 'Admin deleted successfully.' });
    });
});

// 5.7 手动删除指定预订记录 API (受保护)
app.delete('/api/admin/bookings/:id', checkAdminLogin, (req, res) => {
    const bookingIdToDelete = req.params.id;

    db.run("DELETE FROM bookings WHERE id = ?", [bookingIdToDelete], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete booking.' });
        res.json({ message: 'Booking deleted successfully.' });
    });
});

// 5.8 修改指定预订记录 API (受保护)
// app.put('/api/admin/bookings/:id', checkAdminLogin, (req, res) => {
//     const bookingId = req.params.id;
//     const { room, partySize, date, time, duration, name, phone } = req.body;
//
//     const sql = `UPDATE bookings
//                  SET room = ?, partySize = ?, date = ?, time = ?, duration = ?, name = ?, phone = ?
//                  WHERE id = ?`;
//
//     db.run(sql, [room, partySize, date, time, duration, name, phone, bookingId], function(err) {
//         if (err) return res.status(500).json({ error: 'Failed to update booking.' });
//         res.json({ message: 'Booking updated successfully.' });
//     });
// });

// 5.8 修改指定预订记录 API (受保护)
app.put('/api/admin/bookings/:id', checkAdminLogin, (req, res) => {
    const bookingId = req.params.id;
    // 🌟 新增接收 deposit 字段
    const { room, partySize, date, time, duration, name, phone, deposit } = req.body;
    const normalizedDeposit = normalizeDepositValue(deposit);

    // 先查询旧的 deposit 状态，用于判断是否需要回滚
    db.get(`SELECT deposit FROM bookings WHERE id = ?`, [bookingId], (err, oldRow) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch old booking data.' });

        const oldDeposit = oldRow ? normalizeDepositValue(oldRow.deposit) : 'No';
        const isDepositChanged = oldDeposit !== normalizedDeposit;
        const isDepositRevertedFromYesToNo = oldDeposit === 'Yes' && normalizedDeposit === 'No';

        // 🌟 SQL 增加 deposit 更新
        const sql = `UPDATE bookings 
                     SET room = ?, partySize = ?, date = ?, time = ?, duration = ?, name = ?, phone = ?, deposit = ? 
                     WHERE id = ?`;

        // 🌟 传入 deposit 参数，如果没有传默认给 'No'
        db.run(sql, [room, partySize, date, time, duration, name, phone, normalizedDeposit, bookingId], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to update booking.' });

            // 🌟 核心逻辑：处理 deposit 状态变化
            if (isDepositRevertedFromYesToNo) {
                // 如果从 Yes 改回 No，删除 history_orders 和 valid_customers 里的记录
                removeHistoricalOrder(Number(bookingId));
                removeValidCustomer(name, phone);
            } else if (normalizedDeposit === 'Yes') {
                // 如果改成 Yes，添加到 history_orders 和 valid_customers
                syncHistoricalOrder({
                    booking_id: Number(bookingId),
                    room,
                    partySize,
                    date,
                    time,
                    duration,
                    name,
                    phone,
                    deposit: normalizedDeposit
                });
                syncValidCustomer(name, phone);
            }

            res.json({ message: 'Booking updated successfully.' });
        });
    });
});

// ==========================================
// 6. 启动服务器
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`💾 DATABASE_DIR: ${DATABASE_DIR}`);
    console.log(`🛡️ CAPTCHA ${CAPTCHA_ENABLED ? 'enabled' : 'disabled'} (${CAPTCHA_PROVIDER})`);
    console.log(`📨 GoHighLevel workflow notification ${GHL_ENABLED ? 'enabled' : 'disabled'}`);
});
