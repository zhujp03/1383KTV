// app.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Load local .env automatically for local development (Node 20.6+).
try {
    if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(path.join(__dirname, '.env'));
    }
} catch (envErr) {
    if (String(envErr?.code || '') !== 'ENOENT') {
        console.warn('⚠️ Failed to load .env file:', envErr.message);
    }
}

const BUSINESS_TIME_ZONE = String(process.env.BUSINESS_TIME_ZONE || process.env.TZ || 'America/New_York').trim() || 'America/New_York';
process.env.TZ = BUSINESS_TIME_ZONE;

const app = express();
const PORT = Number(process.env.PORT || 3000);
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
const ADMIN_BOOTSTRAP_USERNAME = String(process.env.ADMIN_BOOTSTRAP_USERNAME || '').trim();
const ADMIN_BOOTSTRAP_PASSWORD = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '').trim();
const ADMIN_BOOTSTRAP_FORCE_RESET = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ADMIN_BOOTSTRAP_FORCE_RESET || '').trim().toLowerCase()
);

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
const GHL_PAYMENT_WORKFLOW_ID = String(process.env.GHL_PAYMENT_WORKFLOW_ID || '').trim();
const GHL_REQUEST_TIMEOUT_MS = Number(process.env.GHL_REQUEST_TIMEOUT_MS || 8000);
const GHL_ENABLED = Boolean(GHL_PRIVATE_TOKEN && GHL_LOCATION_ID && GHL_BOOKING_WORKFLOW_ID);

const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_FROM_NUMBER = String(process.env.TWILIO_FROM_NUMBER || '').trim();
const TWILIO_SUPPORT_PHONE = String(process.env.TWILIO_SUPPORT_PHONE || '+16138671383').trim();
const TWILIO_REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.TWILIO_REQUEST_TIMEOUT_MS || 8000));
const TWILIO_ENABLED = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
const TWILIO_CONFIG_ISSUES = [
    TWILIO_ACCOUNT_SID ? '' : 'missing TWILIO_ACCOUNT_SID',
    TWILIO_AUTH_TOKEN ? '' : 'missing TWILIO_AUTH_TOKEN',
    TWILIO_FROM_NUMBER ? '' : 'missing TWILIO_FROM_NUMBER'
].filter(Boolean);

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REFRESH_TOKEN = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
const GOOGLE_CALENDAR_ID = String(process.env.GOOGLE_CALENDAR_ID || 'primary').trim() || 'primary';
const GOOGLE_CALENDAR_SYNC_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.GOOGLE_CALENDAR_SYNC_INTERVAL_MS || 15 * 60 * 1000));
const GOOGLE_CALENDAR_LOOKBACK_HOURS = Math.max(0, Number(process.env.GOOGLE_CALENDAR_LOOKBACK_HOURS || 12));
const GOOGLE_CALENDAR_LOOKAHEAD_DAYS = Math.max(1, Number(process.env.GOOGLE_CALENDAR_LOOKAHEAD_DAYS || 90));
const GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS || 10000));
const GOOGLE_CALENDAR_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);
const GOOGLE_CALENDAR_CONFIG_ISSUES = [
    GOOGLE_CLIENT_ID ? '' : 'missing GOOGLE_CLIENT_ID',
    GOOGLE_CLIENT_SECRET ? '' : 'missing GOOGLE_CLIENT_SECRET',
    GOOGLE_REFRESH_TOKEN ? '' : 'missing GOOGLE_REFRESH_TOKEN'
].filter(Boolean);

const PAYMENT_CURRENCY = String(process.env.PAYMENT_CURRENCY || 'CAD').trim().toUpperCase();
const PAYMENT_PENDING_HOLD_MINUTES = Math.max(1, Number(process.env.PAYMENT_PENDING_HOLD_MINUTES || 15));
const PRIVATE_EVENT_PRICE = Math.max(0, Number(process.env.PRIVATE_EVENT_PRICE || 400));
const PRIVATE_EVENT_PLACEHOLDER = 'N/A';
const PRIVATE_EVENT_PLACEHOLDER_PHONE_PREFIX = 'PRIVATE-EVENT';
const PRIVATE_EVENT_PLACEHOLDER_NAME = 'Private Event Request';
const ROOM_FIRST_HOUR_PRICE = {
    'Small Room': Number(process.env.ROOM_PRICE_SMALL || 55),
    'Medium Room': Number(process.env.ROOM_PRICE_MEDIUM || 65),
    'VIP Room': Number(process.env.ROOM_PRICE_VIP || 85),
    'Large Room': Number(process.env.ROOM_PRICE_VIP || 85)
};
const DRINK_PACKAGE_CATALOG = {
    flying_shot: { name: 'Flying Shot', price: 35 },
    sober_sober: { name: 'Sober Sober', price: 88 },
    kpop_style: { name: 'K-Pop Style', price: 98 },
    little_tipsy: { name: 'Little Tipsy', price: 138 },
    party_tonight: { name: 'Party Tonight', price: 238 },
    boss_package: { name: 'Boss Package', price: 338 },
    party_tonight_upgrade_grey_goose: { name: 'Party Tonight Upgrade to Grey Goose', price: 45 }
};
const DRINK_PACKAGE_KEYS = new Set(Object.keys(DRINK_PACKAGE_CATALOG));

const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_PUBLISHABLE_KEY = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
const HAS_STRIPE_SECRET_KEY = Boolean(STRIPE_SECRET_KEY);
const HAS_STRIPE_PUBLISHABLE_KEY = Boolean(STRIPE_PUBLISHABLE_KEY);
const STRIPE_ENABLED = HAS_STRIPE_SECRET_KEY && HAS_STRIPE_PUBLISHABLE_KEY;
const STRIPE_MODE = STRIPE_ENABLED
    ? (STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test'
        : STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live'
        : 'unknown')
    : 'disabled';
const STRIPE_CONFIG_ISSUES = [
    HAS_STRIPE_SECRET_KEY ? '' : 'missing STRIPE_SECRET_KEY',
    HAS_STRIPE_PUBLISHABLE_KEY ? '' : 'missing STRIPE_PUBLISHABLE_KEY'
].filter(Boolean);
const stripeClient = STRIPE_ENABLED ? new Stripe(STRIPE_SECRET_KEY) : null;

const ipLastRequestAt = new Map();
const phoneRequestState = new Map();
const THROTTLE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let googleAccessTokenCache = { token: '', expiresAt: 0 };
let googleCalendarSyncInProgress = false;

fs.mkdirSync(DATABASE_DIR, { recursive: true });

function copySeedDatabaseIfNeeded(fileName, targetPath) {
    if (DATABASE_DIR === DEFAULT_DATABASE_DIR) return;
    const seedPath = path.join(DEFAULT_DATABASE_DIR, fileName);
    if (fs.existsSync(targetPath)) return;
    if (!fs.existsSync(seedPath)) return;
    fs.copyFileSync(seedPath, targetPath);
    console.log(`📦 Seeded database file '${fileName}' to ${DATABASE_DIR}`);
}

function runAlterTableIgnoreDuplicate(dbConn, sql, label) {
    dbConn.run(sql, (err) => {
        if (!err) return;
        const msg = String(err.message || '').toLowerCase();
        if (msg.includes('duplicate column name')) return;
        console.error(`Schema migration failed (${label}):`, err.message);
    });
}

function getDateTimePartsInTimeZone(date = new Date(), timeZone = BUSINESS_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const bag = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            bag[part.type] = part.value;
        }
    }
    return bag;
}

function getBusinessDateYmd(date = new Date()) {
    const parts = getDateTimePartsInTimeZone(date, BUSINESS_TIME_ZONE);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function getBusinessDateTimeYmdHms(date = new Date()) {
    const parts = getDateTimePartsInTimeZone(date, BUSINESS_TIME_ZONE);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
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
            package_selection_json TEXT DEFAULT '[]',
            package_total_cents INTEGER DEFAULT 0,
            booking_type TEXT DEFAULT 'standard',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // 🌟 2. 数据库无损升级技巧：尝试添加 deposit 字段 (如果已经存在会报错，但我们忽略报错)
            db.run(`ALTER TABLE bookings ADD COLUMN deposit TEXT DEFAULT 'No'`, (err) => {
                if (!err) console.log("🌟 数据库自动升级：已增加 'deposit' 押金字段");
            });
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`, 'bookings.payment_status');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN payment_method TEXT DEFAULT ''`, 'bookings.payment_method');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN payment_amount_cents INTEGER DEFAULT 0`, 'bookings.payment_amount_cents');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN payment_reference TEXT DEFAULT ''`, 'bookings.payment_reference');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN payment_cancel_token TEXT DEFAULT ''`, 'bookings.payment_cancel_token');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN booking_type TEXT DEFAULT 'standard'`, 'bookings.booking_type');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN package_selection_json TEXT DEFAULT '[]'`, 'bookings.package_selection_json');
            runAlterTableIgnoreDuplicate(db, `ALTER TABLE bookings ADD COLUMN package_total_cents INTEGER DEFAULT 0`, 'bookings.package_total_cents');
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
            await ensureBootstrapAdminAccount();
            await logAdminAccountSummary();
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
            final_total_amount REAL DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (tableErr) => {
            if (tableErr) return;
            runAlterTableIgnoreDuplicate(
                historyDb,
                `ALTER TABLE historical_orders ADD COLUMN final_total_amount REAL DEFAULT NULL`,
                'historical_orders.final_total_amount'
            );

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
            final_total_amount REAL DEFAULT NULL,
            PRIMARY KEY (name, phone)
        )`, () => {
            runAlterTableIgnoreDuplicate(
                customerDb,
                `ALTER TABLE valid_customers ADD COLUMN final_total_amount REAL DEFAULT NULL`,
                'valid_customers.final_total_amount'
            );
        });
    }
});

// ==========================================
// 3. 通用辅助函数与权限中间件
// ==========================================

// 自动清理过期预约的函数
function cleanupOldBookings() {
    const todayYmd = getBusinessDateYmd();
    const sql = `DELETE FROM bookings WHERE date < ?`;
    db.run(sql, [todayYmd], function(err) {
        if (err) console.error("Auto-cleanup failed:", err);
        else if (this.changes > 0) {
            console.log(`🧹 Auto-cleanup executed: Deleted ${this.changes} outdated bookings.`);
        }
    });
}

// 自动清理两个月前的历史订单
function cleanupOldHistoricalOrders() {
    const threshold = new Date();
    threshold.setMonth(threshold.getMonth() - 2);
    const thresholdYmdHms = getBusinessDateTimeYmdHms(threshold);
    const sql = `DELETE FROM historical_orders WHERE created_at < ?`;
    historyDb.run(sql, [thresholdYmdHms], function(err) {
        if (err) {
            console.error('History auto-cleanup failed:', err);
        } else if (this.changes > 0) {
            console.log(`🧹 History cleanup executed: Deleted ${this.changes} outdated historical orders.`);
        }
    });
}

function cleanupExpiredPendingPaymentBookings() {
    const threshold = new Date(Date.now() - (PAYMENT_PENDING_HOLD_MINUTES * 60 * 1000));
    const thresholdYmdHms = getBusinessDateTimeYmdHms(threshold);
    const sql = `DELETE FROM bookings
                 WHERE LOWER(COALESCE(payment_status, 'unpaid')) = 'unpaid'
                   AND LOWER(COALESCE(deposit, 'no')) != 'yes'
                   AND TRIM(COALESCE(payment_method, '')) = ''
                   AND created_at < ?`;
    db.run(sql, [thresholdYmdHms], function(err) {
        if (err) {
            console.error('Pending-payment cleanup failed:', err.message);
        } else if (this.changes > 0) {
            console.log(`🧹 Pending-payment cleanup executed: Released ${this.changes} unpaid reservations.`);
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

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
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

function roundCurrency(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function toCents(amount) {
    return Math.round(Number(amount || 0) * 100);
}

function normalizePaymentStatus(value) {
    return String(value || '').trim().toLowerCase() === 'paid' ? 'paid' : 'unpaid';
}

function isPendingPaymentHoldExpired(booking) {
    if (!booking) return false;
    if (normalizePaymentStatus(booking.payment_status) === 'paid') return false;
    if (normalizeDepositValue(booking.deposit) === 'Yes') return false;
    if (String(booking.payment_method || '').trim() !== '') return false;
    const createdAt = String(booking.created_at || '').trim();
    if (!createdAt) return false;
    const threshold = getBusinessDateTimeYmdHms(new Date(Date.now() - (PAYMENT_PENDING_HOLD_MINUTES * 60 * 1000)));
    return createdAt < threshold;
}

async function releaseBookingIfPendingHoldExpired(booking) {
    if (!isPendingPaymentHoldExpired(booking)) {
        return false;
    }
    await dbRun(
        `DELETE FROM bookings
         WHERE id = ?
           AND LOWER(COALESCE(payment_status, 'unpaid')) = 'unpaid'
           AND LOWER(COALESCE(deposit, 'no')) != 'yes'`,
        [Number(booking.id)]
    );
    return true;
}

function getRoomFirstHourPrice(room) {
    const safeRoom = String(room || '').trim();
    return Number(ROOM_FIRST_HOUR_PRICE[safeRoom] || ROOM_FIRST_HOUR_PRICE['Small Room'] || 0);
}

function normalizeSelectedDrinkPackages(rawSelection) {
    let source = rawSelection;
    if (typeof source === 'string') {
        const trimmed = source.trim();
        if (!trimmed) source = [];
        else {
            try {
                const parsed = JSON.parse(trimmed);
                source = Array.isArray(parsed) ? parsed : trimmed.split(',').map((item) => item.trim());
            } catch (_err) {
                source = trimmed.split(',').map((item) => item.trim());
            }
        }
    }
    if (!Array.isArray(source)) source = [];

    const unique = new Set();
    const normalized = [];
    for (const item of source) {
        const key = String(item || '').trim();
        if (!key || !DRINK_PACKAGE_KEYS.has(key) || unique.has(key)) continue;
        unique.add(key);
        normalized.push(key);
    }
    return normalized;
}

function buildDrinkPackageItems(selectedPackages) {
    const normalized = normalizeSelectedDrinkPackages(selectedPackages);
    return normalized.map((key) => {
        const pkg = DRINK_PACKAGE_CATALOG[key];
        const price = Number(pkg?.price || 0);
        return {
            key,
            name: String(pkg?.name || key),
            price: roundCurrency(price),
            cents: toCents(price)
        };
    });
}

function calculateBookingPaymentQuote(booking) {
    const bookingType = String(booking?.booking_type || '').trim().toLowerCase();
    const isPrivateEvent = bookingType === 'private_event';
    const packageItems = isPrivateEvent
        ? []
        : buildDrinkPackageItems(booking?.package_selection_json ?? booking?.selectedPackages ?? booking?.selected_packages ?? []);
    const packageTotalCents = packageItems.reduce((sum, item) => sum + Number(item.cents || 0), 0);
    const packageTotal = roundCurrency(packageTotalCents / 100);
    const firstHourPrice = isPrivateEvent ? PRIVATE_EVENT_PRICE : getRoomFirstHourPrice(booking.room);
    const subtotal = roundCurrency(firstHourPrice + packageTotal);
    const total = subtotal;
    const totalCents = toCents(total);
    const safeRoomLabel = isPrivateEvent ? 'Private Event (Full Day)' : String(booking.room || 'Room');
    const safeDate = String(booking.date || PRIVATE_EVENT_PLACEHOLDER);
    const safeTime = String(booking.time || PRIVATE_EVENT_PLACEHOLDER);

    return {
        currency: PAYMENT_CURRENCY,
        roomFirstHourPrice: firstHourPrice,
        packageItems,
        packageTotal,
        packageTotalCents,
        subtotal,
        total,
        totalCents,
        description: isPrivateEvent
            ? `1383 KTV Private Event - Full Day (${safeDate})`
            : `1383 KTV Booking Deposit - ${safeRoomLabel} (${safeDate} ${safeTime})`
    };
}

function generatePaymentCancelToken() {
    return crypto.randomBytes(24).toString('hex');
}

function generatePrivateEventPlaceholderPhone() {
    return `${PRIVATE_EVENT_PLACEHOLDER_PHONE_PREFIX}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function isLocalHostname(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getPublicBaseUrl(req) {
    const explicit = String(process.env.PUBLIC_BASE_URL || '').trim();
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

    if (explicit) {
        try {
            const explicitUrl = new URL(explicit);
            const explicitHost = String(explicitUrl.hostname || '').trim();
            const requestHostOnly = String(host || '').split(':')[0].trim();
            if (explicitHost && requestHostOnly && isLocalHostname(explicitHost) && !isLocalHostname(requestHostOnly)) {
                console.warn(
                    `⚠️ Ignoring PUBLIC_BASE_URL='${explicit}' for this request host '${host}'. Falling back to request host.`
                );
            } else {
                return explicit.replace(/\/+$/, '');
            }
        } catch (_err) {
            console.warn(`⚠️ Invalid PUBLIC_BASE_URL='${explicit}', falling back to request host.`);
        }
    }
    if (!host) return '';
    return `${proto}://${host}`;
}

async function markBookingAsPaid({ booking, method, reference, totalCents }) {
    const sql = `UPDATE bookings
                 SET payment_status = 'paid',
                     payment_method = ?,
                     payment_reference = ?,
                     payment_amount_cents = ?,
                     payment_cancel_token = '',
                     deposit = 'Yes'
                 WHERE id = ?`;
    await dbRun(sql, [String(method || ''), String(reference || ''), Number(totalCents || 0), Number(booking.id)]);

    syncValidCustomer(booking.name, booking.phone);
    syncHistoricalOrder({
        booking_id: Number(booking.id),
        room: booking.room,
        partySize: booking.partySize,
        date: booking.date,
        time: booking.time,
        duration: booking.duration,
        name: booking.name,
        phone: booking.phone,
        deposit: 'Yes'
    });
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

function formatSmsBookingTimeLabel(date, time) {
    const safeDate = String(date || '').trim() || 'N/A';
    const safeTime = String(time || '').trim() || 'N/A';
    return `${safeDate} ${safeTime}`.trim();
}

function formatSmsCurrency(amount) {
    const rounded = roundCurrency(Number(amount || 0));
    const fixed = rounded.toFixed(2);
    return fixed.endsWith('.00') ? `$${fixed.slice(0, -3)}` : `$${fixed}`;
}

function parseBookingLocalDateTime(dateStr, timeStr) {
    const safeDate = String(dateStr || '').trim();
    const safeTime = String(timeStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate) || !safeTime) return null;

    let hour = 0;
    let minute = 0;
    if (/^\d{1,2}:\d{2}$/.test(safeTime)) {
        const parts = safeTime.split(':').map(Number);
        hour = Number(parts[0]);
        minute = Number(parts[1]);
    } else {
        const match = safeTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (!match) return null;
        hour = Number(match[1]);
        minute = Number(match[2]);
        const ampm = String(match[3] || '').toUpperCase();
        if (ampm === 'PM' && hour !== 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
    }

    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }

    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const dateObj = new Date(`${safeDate}T${hh}:${mm}:00`);
    return Number.isNaN(dateObj.getTime()) ? null : dateObj;
}

function buildReservationWindowText(dateStr, timeStr, durationRaw) {
    const startAt = parseBookingLocalDateTime(dateStr, timeStr);
    const durationHours = Number(durationRaw);
    if (!startAt || !Number.isFinite(durationHours) || durationHours <= 0) {
        return formatSmsBookingTimeLabel(dateStr, timeStr);
    }

    const endAt = new Date(startAt.getTime() + (durationHours * 60 * 60 * 1000));
    const dateLabel = new Intl.DateTimeFormat('en-US', {
        month: 'long',
        day: 'numeric'
    }).format(startAt);
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
    const startLabel = timeFormatter.format(startAt);
    const endLabel = timeFormatter.format(endAt);
    return `${dateLabel} from ${startLabel} to ${endLabel}`;
}

function buildTwilioPaidMessage({ booking, totalCents }) {
    const bookingId = Number(booking?.id || 0);
    const customerName = String(booking?.name || '').trim() || 'Guest';
    const room = String(booking?.room || '').trim() || 'Room';
    const bookingType = String(booking?.booking_type || '').trim().toLowerCase();
    const isPrivateEvent = bookingType === 'private_event';
    const roomRate = isPrivateEvent ? PRIVATE_EVENT_PRICE : getRoomFirstHourPrice(room);
    const roomRateLabel = `${formatSmsCurrency(roomRate)}${isPrivateEvent ? '/day' : '/hr'}`;
    const depositAmount = roundCurrency(Number(totalCents || 0) / 100);
    const depositLabel = formatSmsCurrency(depositAmount);
    const whenLabel = buildReservationWindowText(booking?.date, booking?.time, booking?.duration);

    return `Hi ${customerName}, this is 1383 Karaoke Bar. Your reservation is confirmed. Booking ID: #${bookingId}. ${room} at rate: ${roomRateLabel} on ${whenLabel}.\n\nYour ${depositLabel} deposit has been received. Rescheduling is available with at least 24 hours' notice (subject to availability); changes within 24 hours are not permitted.\n\nAn 18% service charge applies. Outside food & drinks are not allowed.\n\nPlease note: your booking starts on time. If we do not hear from you within 30 minutes of your reservation, the room may be released.\n\nFor assistance: 613-867-1383`;
}

function normalizePhoneOrEmpty(rawPhone) {
    const normalized = normalizeAndValidatePhoneNumber(rawPhone);
    return normalized.ok ? normalized.e164 : '';
}

function buildTwilioRecipients(customerPhone) {
    const recipients = new Set();
    const customer = normalizePhoneOrEmpty(customerPhone);
    const support = normalizePhoneOrEmpty(TWILIO_SUPPORT_PHONE);
    if (customer) recipients.add(customer);
    if (support) recipients.add(support);
    return Array.from(recipients);
}

async function sendTwilioSms(to, body) {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
    const form = new URLSearchParams();
    form.set('To', String(to || '').trim());
    form.set('From', TWILIO_FROM_NUMBER);
    form.set('Body', String(body || '').trim().slice(0, 1200));
    const basicAuth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
    }, TWILIO_REQUEST_TIMEOUT_MS);
    const payload = await safeReadJson(response);
    if (!response.ok) {
        throw new Error(`Twilio send failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
    }
    return {
        sid: String(payload.sid || '').trim(),
        to: String(payload.to || to || '').trim()
    };
}

async function sendPaidBookingSmsNotifications({ booking, totalCents }) {
    if (!TWILIO_ENABLED) {
        return { sent: false, reason: `Twilio is not configured (${TWILIO_CONFIG_ISSUES.join(', ') || 'unknown issue'}).`, recipients: [] };
    }

    const recipients = buildTwilioRecipients(booking?.phone || '');
    if (!recipients.length) {
        return { sent: false, reason: 'No valid recipient phone numbers for Twilio SMS.', recipients: [] };
    }

    const body = buildTwilioPaidMessage({ booking, totalCents });
    const deliveries = [];
    const failures = [];

    for (const to of recipients) {
        try {
            const result = await sendTwilioSms(to, body);
            deliveries.push({ to: result.to || to, sid: result.sid });
        } catch (err) {
            failures.push({ to, error: err.message });
        }
    }

    return {
        sent: deliveries.length > 0,
        recipients,
        deliveries,
        failures
    };
}

function getBusinessYmdHmFromDate(dateObj) {
    const parts = getDateTimePartsInTimeZone(dateObj, BUSINESS_TIME_ZONE);
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`
    };
}

function detectRoomFromCalendarText(text) {
    const lower = String(text || '').toLowerCase();
    if (/\b(vip|large)\b/.test(lower)) return 'VIP Room';
    if (/\b(medium|group)\b/.test(lower)) return 'Medium Room';
    return 'Small Room';
}

function detectPaidFromCalendarText(text) {
    return /\b(?:emt|auto)\b/i.test(String(text || ''));
}

function detectPartySizeFromCalendarText(text) {
    const match = String(text || '').match(/\b(\d{1,2})\s*(?:p|people|person|persons)\b/i);
    if (!match) return 0;
    const size = Number(match[1]);
    return Number.isFinite(size) && size >= 0 ? size : 0;
}

function extractBookingNameFromCalendarSummary(summary) {
    const safe = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!safe) return 'Google Calendar Booking';
    const tokens = safe.split(' ');
    const roomTokenIndex = tokens.findIndex((t) => /^(small|medium|vip|large|group|room)$/i.test(t));
    if (roomTokenIndex > 0) {
        return tokens.slice(0, roomTokenIndex).join(' ').slice(0, 80);
    }
    return safe.slice(0, 80);
}

function extractAmountCentsFromCalendarText(text, room, paid) {
    if (!paid) return 0;
    const match = String(text || '').match(/\$(\d+(?:\.\d{1,2})?)/);
    if (match) return toCents(roundCurrency(Number(match[1])));
    return toCents(roundCurrency(getRoomFirstHourPrice(room)));
}

function extractPhoneFromCalendarText(text, fallbackReference) {
    const safeText = String(text || '');
    const phoneMatch = safeText.match(/(?:\+?1[\s().-]*)?(?:\d[\s().-]*){10}/);
    if (phoneMatch) {
        const digits = phoneMatch[0].replace(/[^\d]/g, '');
        const tenDigits = digits.length === 11 && digits.startsWith('1')
            ? digits.slice(1)
            : digits.slice(-10);
        const checked = normalizeAndValidatePhoneNumber(tenDigits);
        if (checked.ok) return checked.e164;
    }
    const seed = String(fallbackReference || '').replace(/[^\w-]/g, '').slice(-12) || String(Date.now());
    return `GCAL-${seed}`;
}

async function fetchGoogleAccessToken() {
    const now = Date.now();
    if (googleAccessTokenCache.token && googleAccessTokenCache.expiresAt > now + 30 * 1000) {
        return googleAccessTokenCache.token;
    }

    const body = new URLSearchParams();
    body.set('client_id', GOOGLE_CLIENT_ID);
    body.set('client_secret', GOOGLE_CLIENT_SECRET);
    body.set('refresh_token', GOOGLE_REFRESH_TOKEN);
    body.set('grant_type', 'refresh_token');

    const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    }, GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS);
    const payload = await safeReadJson(response);
    if (!response.ok || !payload.access_token) {
        throw new Error(`Google token refresh failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
    }

    const expiresInSec = Math.max(60, Number(payload.expires_in || 3600));
    googleAccessTokenCache = {
        token: String(payload.access_token || '').trim(),
        expiresAt: now + (expiresInSec * 1000)
    };
    return googleAccessTokenCache.token;
}

async function fetchGoogleCalendarEvents(timeMinDate, timeMaxDate) {
    const accessToken = await fetchGoogleAccessToken();
    const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        timeMin: timeMinDate.toISOString(),
        timeMax: timeMaxDate.toISOString(),
        timeZone: BUSINESS_TIME_ZONE
    });
    const calendarPath = encodeURIComponent(GOOGLE_CALENDAR_ID);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarPath}/events?${params.toString()}`;
    const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json'
        }
    }, GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS);
    const payload = await safeReadJson(response);
    if (!response.ok) {
        throw new Error(`Google Calendar fetch failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
    }
    return Array.isArray(payload.items) ? payload.items : [];
}

function parseGoogleCalendarEvent(event) {
    const eventId = String(event?.id || '').trim();
    const startValue = String(event?.start?.dateTime || '').trim();
    const endValue = String(event?.end?.dateTime || '').trim();
    if (!eventId || !startValue || !endValue) return null;

    const startDate = new Date(startValue);
    const endDate = new Date(endValue);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) return null;

    const summary = String(event?.summary || '').trim();
    const description = String(event?.description || '').trim();
    const textBlob = `${summary} ${description}`.trim();
    const room = detectRoomFromCalendarText(textBlob);
    const paymentStatus = detectPaidFromCalendarText(textBlob) ? 'paid' : 'unpaid';
    const deposit = paymentStatus === 'paid' ? 'Yes' : 'No';
    const paymentReference = `gcal:${eventId}`;
    const amountCents = extractAmountCentsFromCalendarText(textBlob, room, paymentStatus === 'paid');
    const startParts = getBusinessYmdHmFromDate(startDate);
    const durationHours = roundCurrency(Math.max(0.5, (endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000)));

    return {
        paymentReference,
        room,
        partySize: detectPartySizeFromCalendarText(textBlob),
        date: startParts.date,
        time: startParts.time,
        duration: String(durationHours),
        name: extractBookingNameFromCalendarSummary(summary),
        phone: extractPhoneFromCalendarText(textBlob, paymentReference),
        deposit,
        paymentStatus,
        paymentAmountCents: amountCents
    };
}

async function upsertGoogleCalendarBooking(parsedBooking) {
    const existing = await dbGet(
        `SELECT id FROM bookings WHERE payment_method = 'google-calendar' AND payment_reference = ? LIMIT 1`,
        [parsedBooking.paymentReference]
    );

    if (existing) {
        await dbRun(
            `UPDATE bookings
             SET room = ?, partySize = ?, date = ?, time = ?, duration = ?, name = ?, phone = ?,
                 deposit = ?, payment_status = ?, payment_amount_cents = ?, booking_type = 'standard'
             WHERE id = ?`,
            [
                parsedBooking.room,
                parsedBooking.partySize,
                parsedBooking.date,
                parsedBooking.time,
                parsedBooking.duration,
                parsedBooking.name,
                parsedBooking.phone,
                parsedBooking.deposit,
                parsedBooking.paymentStatus,
                parsedBooking.paymentAmountCents,
                Number(existing.id)
            ]
        );
        return { inserted: 0, updated: 1, reference: parsedBooking.paymentReference };
    }

    await dbRun(
        `INSERT INTO bookings (
            room, partySize, date, time, duration, name, phone, deposit, payment_status,
            payment_method, payment_amount_cents, payment_reference, payment_cancel_token, booking_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'google-calendar', ?, ?, '', 'standard', ?)`,
        [
            parsedBooking.room,
            parsedBooking.partySize,
            parsedBooking.date,
            parsedBooking.time,
            parsedBooking.duration,
            parsedBooking.name,
            parsedBooking.phone,
            parsedBooking.deposit,
            parsedBooking.paymentStatus,
            parsedBooking.paymentAmountCents,
            parsedBooking.paymentReference,
            getBusinessDateTimeYmdHms()
        ]
    );

    return { inserted: 1, updated: 0, reference: parsedBooking.paymentReference };
}

async function syncGoogleCalendarBookings(options = {}) {
    if (!GOOGLE_CALENDAR_ENABLED) {
        return {
            ok: false,
            skipped: true,
            reason: `Google Calendar integration is not configured (${GOOGLE_CALENDAR_CONFIG_ISSUES.join(', ') || 'unknown issue'}).`
        };
    }

    if (googleCalendarSyncInProgress) {
        return { ok: false, skipped: true, reason: 'Google Calendar sync is already running.' };
    }

    googleCalendarSyncInProgress = true;
    try {
        const now = new Date();
        const timeMinDate = new Date(now.getTime() - (GOOGLE_CALENDAR_LOOKBACK_HOURS * 60 * 60 * 1000));
        const timeMaxDate = new Date(now.getTime() + (GOOGLE_CALENDAR_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
        const events = await fetchGoogleCalendarEvents(timeMinDate, timeMaxDate);

        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        const activeReferences = new Set();

        for (const event of events) {
            const parsed = parseGoogleCalendarEvent(event);
            if (!parsed) {
                skipped += 1;
                continue;
            }
            const result = await upsertGoogleCalendarBooking(parsed);
            inserted += Number(result.inserted || 0);
            updated += Number(result.updated || 0);
            activeReferences.add(parsed.paymentReference);
        }

        const minDateYmd = getBusinessDateYmd(timeMinDate);
        const maxDateYmd = getBusinessDateYmd(timeMaxDate);
        const existingRows = await dbAll(
            `SELECT id, payment_reference FROM bookings
             WHERE payment_method = 'google-calendar'
               AND date >= ?
               AND date <= ?`,
            [minDateYmd, maxDateYmd]
        );

        let removed = 0;
        for (const row of existingRows) {
            const reference = String(row.payment_reference || '').trim();
            if (reference && activeReferences.has(reference)) continue;
            await dbRun(`DELETE FROM bookings WHERE id = ?`, [Number(row.id)]);
            removed += 1;
        }

        return {
            ok: true,
            inserted,
            updated,
            removed,
            skipped,
            totalEvents: events.length,
            reason: String(options.reason || 'manual')
        };
    } finally {
        googleCalendarSyncInProgress = false;
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

async function triggerPaymentConfirmedMessageInGhl(booking) {
    if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID || !GHL_PAYMENT_WORKFLOW_ID) {
        return { sent: false, reason: 'GHL payment workflow is not configured.' };
    }

    const contactId = await upsertContactInGhl(booking);
    const workflowUrl = `${GHL_API_BASE_URL}/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(GHL_PAYMENT_WORKFLOW_ID)}`;
    const response = await fetchWithTimeout(workflowUrl, {
        method: 'POST',
        headers: getGhlHeaders(),
        body: JSON.stringify({ locationId: GHL_LOCATION_ID })
    });
    const payload = await safeReadJson(response);
    if (!response.ok) {
        throw new Error(`GHL payment workflow failed (${response.status}): ${compactJson(JSON.stringify(payload))}`);
    }
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

function getDayOfWeekFromYmd(dateYmd) {
    const parts = String(dateYmd || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
    const [year, month, day] = parts;
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function validateBookingRequest(rawData) {
    const booking = rawData || {};
    const room = String(booking.room || '').trim();
    const date = String(booking.date || '').trim();
    const time = String(booking.time || '').trim();
    const duration = Number(booking.duration);
    const partySize = Number(booking.partySize);
    const name = String(booking.name || '').trim().replace(/\s+/g, ' ');
    const selectedPackages = normalizeSelectedDrinkPackages(
        booking.selectedPackages ?? booking.packageSelections ?? booking.package_selection_json ?? []
    );
    const selectedPackageNames = selectedPackages
        .map((key) => DRINK_PACKAGE_CATALOG[key]?.name || '')
        .filter(Boolean);
    const packageSummary = selectedPackageNames.join(', ').slice(0, 200);

    if (!room || !date || !time || !name || !Number.isFinite(duration) || !Number.isFinite(partySize)) {
        return { ok: false, error: 'Missing required booking fields.' };
    }

    if (name.length < 2 || name.length > 80) {
        return { ok: false, error: 'Name length must be between 2 and 80 characters.' };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, error: 'Invalid booking date format.' };
    }
    if (getDayOfWeekFromYmd(date) === 1) {
        return { ok: false, error: 'We are closed on Mondays. Please choose another date.' };
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

    const phoneDigits = String(booking.phone || '').replace(/[^\d]/g, '');
    if (!/^\d{10}$/.test(phoneDigits)) {
        return { ok: false, error: 'Phone number must be exactly 10 digits.' };
    }

    const phoneCheck = normalizeAndValidatePhoneNumber(phoneDigits);
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
            selectedPackages,
            packageSelectionJson: JSON.stringify(selectedPackages),
            packageTotalCents: selectedPackages.reduce((sum, key) => sum + toCents(DRINK_PACKAGE_CATALOG[key]?.price || 0), 0),
            upsellInterest: packageSummary
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

async function ensureBootstrapAdminAccount() {
    if (!ADMIN_BOOTSTRAP_USERNAME || !ADMIN_BOOTSTRAP_PASSWORD) return;

    try {
        const hashed = await hashPassword(ADMIN_BOOTSTRAP_PASSWORD);
        if (ADMIN_BOOTSTRAP_FORCE_RESET) {
            await adminDbRun(
                `INSERT INTO admins (username, password)
                 VALUES (?, ?)
                 ON CONFLICT(username)
                 DO UPDATE SET password = excluded.password`,
                [ADMIN_BOOTSTRAP_USERNAME, hashed]
            );
            console.log(`🔐 Bootstrap admin ensured (force reset): ${ADMIN_BOOTSTRAP_USERNAME}`);
            return;
        }

        const existing = await adminDbGet(`SELECT id FROM admins WHERE username = ?`, [ADMIN_BOOTSTRAP_USERNAME]);
        if (existing) return;

        await adminDbRun(`INSERT INTO admins (username, password) VALUES (?, ?)`, [ADMIN_BOOTSTRAP_USERNAME, hashed]);
        console.log(`🔐 Bootstrap admin created: ${ADMIN_BOOTSTRAP_USERNAME}`);
    } catch (err) {
        console.error('Failed to ensure bootstrap admin account:', err.message);
    }
}

async function logAdminAccountSummary() {
    try {
        const rows = await adminDbAll(`SELECT username FROM admins ORDER BY id ASC LIMIT 20`);
        const usernames = rows.map((row) => String(row.username || '').trim()).filter(Boolean);
        if (!usernames.length) {
            console.warn('⚠️ No admin accounts found in admin.db. Login will always fail until an admin account is created.');
            return;
        }
        console.log(`👤 Admin accounts loaded: ${usernames.join(', ')}`);
    } catch (err) {
        console.error('Failed to read admin account summary:', err.message);
    }
}

function syncValidCustomer(name, phone) {
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').trim();
    if (!safeName || !safePhone) return;

    const nowYmdHms = getBusinessDateTimeYmdHms();
    const sql = `INSERT INTO valid_customers (name, phone, first_seen, last_seen)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(name, phone)
                 DO UPDATE SET last_seen = ?`;
    customerDb.run(sql, [safeName, safePhone, nowYmdHms, nowYmdHms, nowYmdHms], (err) => {
        if (err) console.error('Failed to sync valid customer:', err.message);
    });
}

function updateValidCustomerFinalAmount(name, phone, finalTotalAmount) {
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').trim();
    if (!safeName || !safePhone) return;

    const normalizedAmount = Number(finalTotalAmount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0) return;

    const nowYmdHms = getBusinessDateTimeYmdHms();
    const sql = `UPDATE valid_customers
                 SET final_total_amount = ?, last_seen = ?
                 WHERE name = ? AND phone = ?`;
    customerDb.run(sql, [roundCurrency(normalizedAmount), nowYmdHms, safeName, safePhone], (err) => {
        if (err) console.error('Failed to update valid customer amount:', err.message);
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

    const sql = `INSERT INTO historical_orders (booking_id, room, partySize, date, time, duration, name, phone, deposit, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        normalizedDeposit,
        getBusinessDateTimeYmdHms()
    ], (err) => {
        if (err) console.error('Failed to sync historical order:', err.message);
    });
}

// 每天执行一次历史订单清理
setInterval(cleanupOldHistoricalOrders, 24 * 60 * 60 * 1000);
// 每分钟执行一次未支付超时释放
setInterval(cleanupExpiredPendingPaymentBookings, 60 * 1000);
cleanupExpiredPendingPaymentBookings();

function startGoogleCalendarSyncJobs() {
    if (!GOOGLE_CALENDAR_ENABLED) return;

    setInterval(() => {
        syncGoogleCalendarBookings({ reason: 'interval' }).then((result) => {
            if (result && result.ok) {
                console.log(`📅 Google Calendar sync complete: inserted=${result.inserted}, updated=${result.updated}, removed=${result.removed}, skipped=${result.skipped}`);
            }
        }).catch((err) => {
            console.error('Google Calendar periodic sync failed:', err.message);
        });
    }, GOOGLE_CALENDAR_SYNC_INTERVAL_MS).unref();

    syncGoogleCalendarBookings({ reason: 'startup' }).then((result) => {
        if (result && result.ok) {
            console.log(`📅 Google Calendar startup sync complete: inserted=${result.inserted}, updated=${result.updated}, removed=${result.removed}, skipped=${result.skipped}`);
        }
    }).catch((err) => {
        console.error('Google Calendar startup sync failed:', err.message);
    });
}

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
        businessTimeZone: BUSINESS_TIME_ZONE,
        captchaEnabled: CAPTCHA_ENABLED,
        captchaProvider: CAPTCHA_ENABLED ? 'turnstile' : '',
        turnstileSiteKey: CAPTCHA_ENABLED ? TURNSTILE_SITE_KEY : '',
        payment: {
            currency: PAYMENT_CURRENCY,
            pendingHoldMinutes: PAYMENT_PENDING_HOLD_MINUTES,
            providers: {
                stripe: {
                    enabled: STRIPE_ENABLED,
                    mode: STRIPE_MODE,
                    configIssue: STRIPE_CONFIG_ISSUES.join(', '),
                    publishableKey: STRIPE_ENABLED ? STRIPE_PUBLISHABLE_KEY : ''
                }
            }
        }
    });
});

app.post('/api/book/private-event', bookingIpRateLimiter, enforceIpBookingCooldown, async (req, res) => {
    const cancelToken = generatePaymentCancelToken();
    const placeholderPhone = generatePrivateEventPlaceholderPhone();
    const nowYmdHms = getBusinessDateTimeYmdHms();
    const sql = `INSERT INTO bookings (
                    room, partySize, date, time, duration, name, phone,
                    package_selection_json, package_total_cents,
                    deposit, payment_status, payment_method, payment_amount_cents, payment_reference,
                    payment_cancel_token, booking_type, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0, 'No', 'unpaid', '', 0, '', ?, 'private_event', ?)`;

    try {
        const runResult = await dbRun(sql, [
            'Small Room',
            0,
            PRIVATE_EVENT_PLACEHOLDER,
            PRIVATE_EVENT_PLACEHOLDER,
            PRIVATE_EVENT_PLACEHOLDER,
            PRIVATE_EVENT_PLACEHOLDER_NAME,
            placeholderPhone,
            cancelToken,
            nowYmdHms
        ]);

        const bookingId = Number(runResult.lastID);
        const paymentQuote = calculateBookingPaymentQuote({
            id: bookingId,
            room: 'Small Room',
            partySize: 0,
            date: PRIVATE_EVENT_PLACEHOLDER,
            time: PRIVATE_EVENT_PLACEHOLDER,
            duration: PRIVATE_EVENT_PLACEHOLDER,
            name: PRIVATE_EVENT_PLACEHOLDER_NAME,
            phone: placeholderPhone,
            package_selection_json: '[]',
            booking_type: 'private_event'
        });

        return res.status(200).json({
            message: 'Private event request created.',
            bookingId,
            normalizedPhone: placeholderPhone,
            paymentStatus: 'unpaid',
            paymentCancelToken: cancelToken,
            paymentHoldMinutes: PAYMENT_PENDING_HOLD_MINUTES,
            bookingType: 'private_event',
            paymentQuote,
            paymentProviders: {
                stripe: STRIPE_ENABLED
            }
        });
    } catch (err) {
        console.error('Failed to create private event request:', err.message);
        return res.status(500).json({ error: 'Failed to create private event request.' });
    }
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

    const cancelToken = generatePaymentCancelToken();
    const sql = `INSERT INTO bookings (
                    room, partySize, date, time, duration, name, phone,
                    package_selection_json, package_total_cents,
                    deposit, payment_status, payment_method, payment_amount_cents, payment_reference,
                    payment_cancel_token, booking_type, created_at
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'No', 'unpaid', '', 0, '', ?, 'standard', ?)`;

    try {
        const runResult = await dbRun(sql, [
            bookingData.room,
            bookingData.partySize,
            bookingData.date,
            bookingData.time,
            bookingData.duration,
            bookingData.name,
            bookingData.phone,
            bookingData.packageSelectionJson,
            bookingData.packageTotalCents,
            cancelToken,
            getBusinessDateTimeYmdHms()
        ]);
        const bookingId = runResult.lastID;
        syncValidCustomer(bookingData.name, bookingData.phone);
        const paymentQuote = calculateBookingPaymentQuote({
            id: bookingId,
            room: bookingData.room,
            partySize: bookingData.partySize,
            date: bookingData.date,
            time: bookingData.time,
            duration: bookingData.duration,
            name: bookingData.name,
            phone: bookingData.phone,
            package_selection_json: bookingData.packageSelectionJson
        });

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
            normalizedPhone: bookingData.phone,
            paymentStatus: 'unpaid',
            paymentCancelToken: cancelToken,
            paymentHoldMinutes: PAYMENT_PENDING_HOLD_MINUTES,
            bookingType: 'standard',
            paymentQuote,
            paymentProviders: {
                stripe: STRIPE_ENABLED
            }
        });
    } catch (err) {
        console.error('Error inserting data:', err.message);
        return res.status(500).json({ error: 'Failed to save booking to database.' });
    }
});

app.get('/api/book/:id/payment-quote', async (req, res) => {
    try {
        const bookingId = Number(req.params.id);
        if (!Number.isFinite(bookingId) || bookingId <= 0) {
            return res.status(400).json({ error: 'Invalid booking id.' });
        }

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        if (await releaseBookingIfPendingHoldExpired(booking)) {
            return res.status(410).json({
                error: `Payment hold expired (${PAYMENT_PENDING_HOLD_MINUTES} minutes). Please submit a new booking.`
            });
        }

        const paymentQuote = calculateBookingPaymentQuote(booking);
        return res.status(200).json({
            bookingId: booking.id,
            paymentStatus: normalizePaymentStatus(booking.payment_status),
            bookingType: String(booking.booking_type || 'standard'),
            paymentQuote,
            paymentProviders: {
                stripe: STRIPE_ENABLED
            }
        });
    } catch (err) {
        console.error('Failed to fetch payment quote:', err.message);
        return res.status(500).json({ error: 'Failed to fetch payment quote.' });
    }
});

app.post('/api/book/:id/payment/start', async (req, res) => {
    try {
        const bookingId = Number(req.params.id);
        const provider = String(req.body?.provider || '').trim().toLowerCase();
        const phoneCandidates = buildPhoneQueryCandidates(req.body?.phone || '');
        const providedCancelToken = String(req.body?.cancelToken || '').trim();

        if (!Number.isFinite(bookingId) || bookingId <= 0) {
            return res.status(400).json({ error: 'Invalid booking id.' });
        }
        if (provider !== 'stripe') {
            return res.status(400).json({ error: 'Unsupported payment provider. Only Stripe is available.' });
        }
        if (!phoneCandidates.length && !providedCancelToken) {
            return res.status(400).json({ error: 'Missing payment credentials.' });
        }

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found.' });
        }

        const tokenMatches = providedCancelToken && String(booking.payment_cancel_token || '').trim() === providedCancelToken;
        const phoneMatches = phoneCandidates.includes(String(booking.phone || '').trim());
        if (!tokenMatches && !phoneMatches) {
            return res.status(403).json({ error: 'Booking credentials do not match.' });
        }
        if (await releaseBookingIfPendingHoldExpired(booking)) {
            return res.status(410).json({
                error: `Payment hold expired (${PAYMENT_PENDING_HOLD_MINUTES} minutes). Please submit a new booking.`
            });
        }

        if (normalizePaymentStatus(booking.payment_status) === 'paid') {
            return res.status(200).json({
                message: 'Booking is already paid.',
                paymentStatus: 'paid'
            });
        }

        const quote = calculateBookingPaymentQuote(booking);
        if (!Number.isFinite(quote.totalCents) || quote.totalCents <= 0) {
            return res.status(400).json({ error: 'Invalid payment amount.' });
        }

        const baseUrl = getPublicBaseUrl(req);
        if (!baseUrl) {
            return res.status(500).json({ error: 'Unable to resolve public URL for payment redirect.' });
        }
        const issuedCancelToken = generatePaymentCancelToken();
        await dbRun(`UPDATE bookings SET payment_cancel_token = ? WHERE id = ?`, [issuedCancelToken, booking.id]);

        if (!STRIPE_ENABLED || !stripeClient) {
            return res.status(400).json({ error: 'Stripe is not configured yet.' });
        }

        const session = await stripeClient.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        currency: quote.currency.toLowerCase(),
                        unit_amount: quote.totalCents,
                        product_data: {
                            name: quote.description
                        }
                    }
                }
            ],
            metadata: {
                bookingId: String(booking.id),
                provider: 'stripe'
            },
            success_url: `${baseUrl}/pages/booking.html?payment=success&provider=stripe&bookingId=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/pages/booking.html?payment=cancel&provider=stripe&bookingId=${booking.id}&cancelToken=${encodeURIComponent(issuedCancelToken)}`
        });

        return res.status(200).json({
            provider: 'stripe',
            checkoutUrl: session.url,
            sessionId: session.id,
            cancelToken: issuedCancelToken,
            paymentHoldMinutes: PAYMENT_PENDING_HOLD_MINUTES,
            bookingType: String(booking.booking_type || 'standard'),
            paymentQuote: quote
        });
    } catch (err) {
        console.error('Failed to start payment:', err.message);
        return res.status(500).json({ error: 'Failed to start payment.' });
    }
});

app.post('/api/book/:id/payment/cancel', async (req, res) => {
    try {
        const bookingId = Number(req.params.id);
        const provider = String(req.body?.provider || '').trim().toLowerCase();
        const cancelToken = String(req.body?.cancelToken || req.query?.cancelToken || '').trim();
        const phoneRaw = String(req.body?.phone || '').trim();

        if (!Number.isFinite(bookingId) || bookingId <= 0) {
            return res.status(400).json({ error: 'Invalid booking id.' });
        }
        if (provider && provider !== 'stripe') {
            return res.status(400).json({ error: 'Unsupported payment provider. Only Stripe is available.' });
        }
        if (!cancelToken && !phoneRaw) {
            return res.status(400).json({ error: 'Missing cancel token or phone number.' });
        }

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        if (normalizePaymentStatus(booking.payment_status) === 'paid') {
            return res.status(409).json({ error: 'Booking is already paid and cannot be auto-cancelled.' });
        }

        let authorized = false;
        const storedToken = String(booking.payment_cancel_token || '').trim();
        if (cancelToken && storedToken && storedToken === cancelToken) {
            authorized = true;
        }

        if (!authorized && phoneRaw) {
            const phoneCandidates = buildPhoneQueryCandidates(phoneRaw);
            if (phoneCandidates.includes(String(booking.phone || '').trim())) {
                authorized = true;
            }
        }

        if (!authorized) {
            return res.status(403).json({ error: 'Invalid cancellation credentials for this booking.' });
        }

        await dbRun(`DELETE FROM bookings WHERE id = ?`, [bookingId]);
        return res.status(200).json({
            message: 'Booking deleted after payment cancellation.',
            bookingId,
            bookingType: String(booking.booking_type || 'standard')
        });
    } catch (err) {
        console.error('Failed to auto-cancel unpaid booking:', err.message);
        return res.status(500).json({ error: 'Failed to auto-cancel booking.' });
    }
});

app.post('/api/book/:id/payment/confirm', async (req, res) => {
    try {
        const bookingId = Number(req.params.id);
        const provider = String(req.body?.provider || '').trim().toLowerCase();
        if (!Number.isFinite(bookingId) || bookingId <= 0) {
            return res.status(400).json({ error: 'Invalid booking id.' });
        }
        if (provider !== 'stripe') {
            return res.status(400).json({ error: 'Unsupported payment provider. Only Stripe is available.' });
        }

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        if (normalizePaymentStatus(booking.payment_status) === 'paid') {
            return res.status(200).json({
                message: 'Payment already confirmed.',
                bookingId: booking.id,
                paymentStatus: 'paid',
                bookingType: String(booking.booking_type || 'standard')
            });
        }

        const quote = calculateBookingPaymentQuote(booking);

        if (!STRIPE_ENABLED || !stripeClient) {
            return res.status(400).json({ error: 'Stripe is not configured yet.' });
        }
        const sessionId = String(req.body?.sessionId || req.body?.stripeSessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json({ error: 'Missing Stripe session id.' });
        }

        const session = await stripeClient.checkout.sessions.retrieve(sessionId);
        const paid = String(session.payment_status || '').toLowerCase() === 'paid';
        const metaBookingId = Number(session.metadata?.bookingId || 0);
        if (!paid || metaBookingId !== booking.id) {
            return res.status(400).json({ error: 'Stripe payment is not completed or does not match booking.' });
        }

        await markBookingAsPaid({
            booking,
            method: 'stripe',
            reference: session.id,
            totalCents: quote.totalCents
        });

        let twilioNotification = { sent: false, reason: '', recipients: [], deliveries: [], failures: [] };
        try {
            twilioNotification = await sendPaidBookingSmsNotifications({
                booking,
                totalCents: quote.totalCents
            });
        } catch (twilioErr) {
            twilioNotification = { sent: false, reason: twilioErr.message, recipients: [], deliveries: [], failures: [] };
            console.error('Twilio payment confirmation SMS failed:', twilioErr.message);
        }

        let paymentNotification = { sent: false, reason: '' };
        try {
            paymentNotification = await triggerPaymentConfirmedMessageInGhl({
                bookingId: booking.id,
                room: booking.room,
                partySize: booking.partySize,
                date: booking.date,
                time: booking.time,
                duration: booking.duration,
                name: booking.name,
                phone: booking.phone
            });
        } catch (notifyErr) {
            paymentNotification = { sent: false, reason: notifyErr.message };
            console.error('GHL payment confirmation failed:', notifyErr.message);
        }

        return res.status(200).json({
            message: 'Payment confirmed successfully.',
            bookingId: booking.id,
            paymentStatus: 'paid',
            bookingType: String(booking.booking_type || 'standard'),
            paymentNotification,
            twilioNotification
        });
    } catch (err) {
        console.error('Failed to confirm payment:', err.message);
        return res.status(500).json({ error: 'Failed to confirm payment.' });
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
            console.warn(`🔒 Admin login failed: username not found -> "${String(username || '').trim()}"`);
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const isValid = await verifyAdminPassword(password, row.password);
        if (!isValid) {
            console.warn(`🔒 Admin login failed: password mismatch for "${String(username || '').trim()}"`);
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
        cleanupExpiredPendingPaymentBookings();

        res.json({ message: 'Login successful', username: row.username });
    } catch (err) {
        console.error('Admin login failed:', err.message);
        res.status(500).json({ error: 'Login failed due to server error.' });
    }
});

app.post('/api/admin/google-calendar/sync', checkAdminLogin, async (req, res) => {
    try {
        const result = await syncGoogleCalendarBookings({ reason: 'admin-manual' });
        if (!result.ok && result.skipped) {
            return res.status(400).json(result);
        }
        return res.status(200).json(result);
    } catch (err) {
        console.error('Admin-triggered Google Calendar sync failed:', err.message);
        return res.status(500).json({ ok: false, error: 'Google Calendar sync failed.' });
    }
});

// 5.2 获取所有预订记录 API (受保护)
app.get('/api/admin/bookings', checkAdminLogin, (req, res) => {
    const todayYmd = getBusinessDateYmd();
    const cleanupSql = `DELETE FROM bookings WHERE date < ?`;
    const listSql = `SELECT *
                     FROM bookings
                     WHERE NOT (
                         LOWER(COALESCE(payment_status, 'unpaid')) = 'unpaid'
                         AND LOWER(COALESCE(deposit, 'no')) != 'yes'
                         AND TRIM(COALESCE(payment_method, '')) = ''
                     )
                     ORDER BY date ASC, time ASC`;

    db.run(cleanupSql, [todayYmd], (cleanupErr) => {
        if (cleanupErr) {
            console.error('Failed to cleanup outdated bookings before admin refresh:', cleanupErr.message);
        }

        db.all(listSql, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to fetch bookings.' });
            res.status(200).json({ total: rows.length, data: rows });
        });
    });
});

// 历史订单列表（最近两个月）
app.get('/api/admin/history-orders', checkAdminLogin, (req, res) => {
    const sql = `SELECT h.*
                 FROM historical_orders h
                 WHERE h.deposit = 'Yes'
                 ORDER BY h.created_at DESC, h.date DESC, h.time DESC`;
    historyDb.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch historical orders.' });
        res.status(200).json({ total: rows.length, data: rows });
    });
});

// 有效客户列表（去重：name + phone）
app.get('/api/admin/valid-customers', checkAdminLogin, (req, res) => {
    const sql = `SELECT name, phone, first_seen, last_seen, final_total_amount FROM valid_customers ORDER BY last_seen DESC`;
    customerDb.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch valid customers.' });
        res.status(200).json({ total: rows.length, data: rows });
    });
});

app.put('/api/admin/valid-customers/amount', checkAdminLogin, (req, res) => {
    const { name, phone, finalTotalAmount } = req.body || {};
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').trim();
    const amount = Number(finalTotalAmount);

    if (!safeName || !safePhone) {
        return res.status(400).json({ error: 'Name and phone are required.' });
    }
    if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'Final total amount must be a valid non-negative number.' });
    }

    const nowYmdHms = getBusinessDateTimeYmdHms();
    const sql = `UPDATE valid_customers
                 SET final_total_amount = ?, last_seen = ?
                 WHERE name = ? AND phone = ?`;
    customerDb.run(sql, [roundCurrency(amount), nowYmdHms, safeName, safePhone], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to update customer final total amount.' });
        if (!this.changes) return res.status(404).json({ error: 'Customer record not found.' });
        res.status(200).json({ message: 'Customer final total amount updated.' });
    });
});

app.put('/api/admin/history-orders/amount', checkAdminLogin, (req, res) => {
    const { bookingId, historyId, finalTotalAmount } = req.body || {};
    const amount = Number(finalTotalAmount);
    const safeBookingId = Number(bookingId);
    const safeHistoryId = Number(historyId);

    if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'Final total amount must be a valid non-negative number.' });
    }

    const roundedAmount = roundCurrency(amount);

    if (Number.isFinite(safeBookingId) && safeBookingId > 0) {
        const byBookingSql = `UPDATE historical_orders
                              SET final_total_amount = ?
                              WHERE booking_id = ?`;
        return historyDb.run(byBookingSql, [roundedAmount, safeBookingId], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to update customer final total amount.' });
            if (!this.changes) return res.status(404).json({ error: 'History record not found.' });
            return res.status(200).json({ message: 'Customer final total amount updated.' });
        });
    }

    if (Number.isFinite(safeHistoryId) && safeHistoryId > 0) {
        const byHistorySql = `UPDATE historical_orders
                              SET final_total_amount = ?
                              WHERE id = ?`;
        return historyDb.run(byHistorySql, [roundedAmount, safeHistoryId], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to update customer final total amount.' });
            if (!this.changes) return res.status(404).json({ error: 'History record not found.' });
            return res.status(200).json({ message: 'Customer final total amount updated.' });
        });
    }

    return res.status(400).json({ error: 'bookingId or historyId is required.' });
});

app.delete('/api/admin/history-orders/:historyId', checkAdminLogin, (req, res) => {
    const historyId = Number(req.params.historyId);
    if (!Number.isFinite(historyId) || historyId <= 0) {
        return res.status(400).json({ error: 'Invalid history record id.' });
    }

    const sql = `DELETE FROM historical_orders WHERE id = ?`;
    historyDb.run(sql, [historyId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete history record.' });
        if (!this.changes) return res.status(404).json({ error: 'History record not found.' });
        return res.status(200).json({ message: 'History record deleted successfully.' });
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

app.post('/api/admin/bookings/manual', checkAdminLogin, async (req, res) => {
    try {
        const payload = req.body || {};
        const room = String(payload.room || '').trim();
        const partySize = Number(payload.partySize);
        const date = String(payload.date || '').trim();
        const time = String(payload.time || '').trim();
        const duration = Number(payload.duration);
        const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
        const phoneRaw = String(payload.phone || '').trim();
        const phoneValidation = normalizeAndValidatePhoneNumber(phoneRaw);
        const safePhone = phoneValidation.ok ? phoneValidation.e164 : phoneRaw;
        const paymentStatus = normalizePaymentStatus(payload.paymentStatus);
        const paymentMethod = String(payload.paymentMethod || 'admin-manual').trim().slice(0, 40) || 'admin-manual';
        const providedAmount = Number(payload.paymentAmount);

        if (!room || !name || !safePhone || !Number.isFinite(partySize) || !Number.isFinite(duration) || !date || !time) {
            return res.status(400).json({ error: 'Missing required booking fields.' });
        }

        const amountCents = Number.isFinite(providedAmount) && providedAmount >= 0
            ? toCents(roundCurrency(providedAmount))
            : 0;
        const deposit = paymentStatus === 'paid' ? 'Yes' : 'No';

        const sql = `INSERT INTO bookings (
                        room, partySize, date, time, duration, name, phone, deposit,
                        payment_status, payment_method, payment_amount_cents, payment_reference, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const runResult = await dbRun(sql, [
            room,
            partySize,
            date,
            time,
            duration,
            name,
            safePhone,
            deposit,
            paymentStatus,
            paymentMethod,
            amountCents,
            '',
            getBusinessDateTimeYmdHms()
        ]);

        if (paymentStatus === 'paid') {
            syncValidCustomer(name, safePhone);
            syncHistoricalOrder({
                booking_id: Number(runResult.lastID),
                room,
                partySize,
                date,
                time,
                duration,
                name,
                phone: safePhone,
                deposit: 'Yes'
            });
        }

        return res.status(200).json({
            message: 'Manual booking added successfully.',
            bookingId: runResult.lastID
        });
    } catch (err) {
        console.error('Failed to create manual admin booking:', err.message);
        return res.status(500).json({ error: 'Failed to create manual booking.' });
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
    const { room, partySize, date, time, duration, name, phone, deposit, paymentStatus, paymentAmount } = req.body;
    const normalizedPaymentStatus = normalizePaymentStatus(paymentStatus || (normalizeDepositValue(deposit) === 'Yes' ? 'paid' : 'unpaid'));
    const normalizedDeposit = normalizedPaymentStatus === 'paid' ? 'Yes' : 'No';
    const amountCents = Number.isFinite(Number(paymentAmount)) && Number(paymentAmount) >= 0
        ? toCents(roundCurrency(paymentAmount))
        : 0;
    const phoneValidation = normalizeAndValidatePhoneNumber(phone);
    const normalizedPhone = phoneValidation.ok ? phoneValidation.e164 : String(phone || '').trim();

    // 先查询旧的 deposit 状态，用于判断是否需要回滚
    db.get(`SELECT deposit FROM bookings WHERE id = ?`, [bookingId], (err, oldRow) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch old booking data.' });

        const oldDeposit = oldRow ? normalizeDepositValue(oldRow.deposit) : 'No';
        const isDepositRevertedFromYesToNo = oldDeposit === 'Yes' && normalizedDeposit === 'No';

        const sql = `UPDATE bookings 
                     SET room = ?, partySize = ?, date = ?, time = ?, duration = ?, name = ?, phone = ?, deposit = ?, payment_status = ?, payment_amount_cents = ? 
                     WHERE id = ?`;

        db.run(sql, [room, partySize, date, time, duration, name, normalizedPhone, normalizedDeposit, normalizedPaymentStatus, amountCents, bookingId], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to update booking.' });

            if (isDepositRevertedFromYesToNo) {
                removeHistoricalOrder(Number(bookingId));
                removeValidCustomer(name, normalizedPhone);
            } else if (normalizedDeposit === 'Yes') {
                syncHistoricalOrder({
                    booking_id: Number(bookingId),
                    room,
                    partySize,
                    date,
                    time,
                    duration,
                    name,
                    phone: normalizedPhone,
                    deposit: normalizedDeposit
                });
                syncValidCustomer(name, normalizedPhone);
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
    console.log(`🕒 BUSINESS_TIME_ZONE: ${BUSINESS_TIME_ZONE}`);
    console.log(`🛡️ CAPTCHA ${CAPTCHA_ENABLED ? 'enabled' : 'disabled'} (${CAPTCHA_PROVIDER})`);
    console.log(`📨 GoHighLevel workflow notification ${GHL_ENABLED ? 'enabled' : 'disabled'}`);
    console.log(`📲 Twilio SMS ${TWILIO_ENABLED ? `enabled (support notify: ${TWILIO_SUPPORT_PHONE})` : 'disabled'}`);
    console.log(`📅 Google Calendar sync ${GOOGLE_CALENDAR_ENABLED ? `enabled (${Math.round(GOOGLE_CALENDAR_SYNC_INTERVAL_MS / 60000)} min interval, calendar: ${GOOGLE_CALENDAR_ID})` : 'disabled'}`);
    console.log(`💳 Payments: Stripe(${STRIPE_ENABLED ? `enabled:${STRIPE_MODE}` : 'disabled'})`);
    if (!TWILIO_ENABLED && TWILIO_CONFIG_ISSUES.length) {
        console.warn(`⚠️ Twilio config issue: ${TWILIO_CONFIG_ISSUES.join(', ')}`);
    }
    if (!GOOGLE_CALENDAR_ENABLED && GOOGLE_CALENDAR_CONFIG_ISSUES.length) {
        console.warn(`⚠️ Google Calendar config issue: ${GOOGLE_CALENDAR_CONFIG_ISSUES.join(', ')}`);
    }
    if (!STRIPE_ENABLED && STRIPE_CONFIG_ISSUES.length) {
        console.warn(`⚠️ Stripe config issue: ${STRIPE_CONFIG_ISSUES.join(', ')}`);
    }
    startGoogleCalendarSyncJobs();
});
