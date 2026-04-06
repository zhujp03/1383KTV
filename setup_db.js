// setup_db.js - 用于初始化数据库和默认管理员
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

try {
    if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(path.join(__dirname, '.env'));
    }
} catch (envErr) {
    if (String(envErr?.code || '') !== 'ENOENT') {
        console.warn('⚠️ Failed to load .env file:', envErr.message);
    }
}

const BCRYPT_ROUNDS = 10;
const DEFAULT_DATABASE_DIR = path.join(__dirname, 'database');
const DATABASE_DIR_INPUT = String(process.env.DATABASE_DIR || DEFAULT_DATABASE_DIR).trim();
const DATABASE_DIR = path.isAbsolute(DATABASE_DIR_INPUT)
    ? DATABASE_DIR_INPUT
    : path.join(__dirname, DATABASE_DIR_INPUT);
const ADMIN_DB_PATH = path.join(DATABASE_DIR, 'admin.db');
const DEFAULT_ADMIN_USERNAME = String(process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin').trim() || 'admin';
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || 'admin123').trim() || 'admin123';
const ADMIN_FORCE_RESET = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ADMIN_BOOTSTRAP_FORCE_RESET || '').trim().toLowerCase()
);

fs.mkdirSync(DATABASE_DIR, { recursive: true });

if (DATABASE_DIR !== DEFAULT_DATABASE_DIR) {
    const seedAdminDb = path.join(DEFAULT_DATABASE_DIR, 'admin.db');
    if (!fs.existsSync(ADMIN_DB_PATH) && fs.existsSync(seedAdminDb)) {
        fs.copyFileSync(seedAdminDb, ADMIN_DB_PATH);
        console.log(`📦 Seeded admin.db to ${DATABASE_DIR}`);
    }
}

// 连接到 admin.db（如果不存在会自动创建）
const db = new sqlite3.Database(ADMIN_DB_PATH, (err) => {
    if (err) {
        return console.error('❌ 数据库打开失败:', err.message);
    }
    console.log('✅ 成功连接到 admin.db');
});

// 使用 serialize 确保 SQL 语句按顺序执行
db.serialize(() => {
    // 1. 创建 admins 数据表
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`, (err) => {
        if (err) console.error("❌ 创建 admins 表失败:", err.message);
        else console.log("✅ admins 表准备就绪");
    });

    // 2. 插入默认管理员账号密码 (加密)
    // 使用 INSERT OR IGNORE 是为了防止你重复运行这个脚本时报错
    const sql = ADMIN_FORCE_RESET
        ? `INSERT INTO admins (username, password)
           VALUES (?, ?)
           ON CONFLICT(username)
           DO UPDATE SET password = excluded.password`
        : `INSERT OR IGNORE INTO admins (username, password) VALUES (?, ?)`;

    bcrypt.hash(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS)
        .then((hashedPass) => {
            db.run(sql, [DEFAULT_ADMIN_USERNAME, hashedPass], function(err) {
                if (err) {
                    return console.error('❌ 插入默认管理员失败:', err.message);
                }

                if (ADMIN_FORCE_RESET) {
                    console.log(`🎉 管理员账号已强制重置！\n👉 账号: ${DEFAULT_ADMIN_USERNAME}`);
                } else if (this.changes > 0) {
                    console.log(`🎉 默认管理员创建成功！\n👉 账号: ${DEFAULT_ADMIN_USERNAME}\n👉 密码: ${DEFAULT_ADMIN_PASSWORD}`);
                } else {
                    console.log(`⚠️ 默认管理员 '${DEFAULT_ADMIN_USERNAME}' 已经存在，跳过创建。`);
                }

                // 执行完毕后安全关闭数据库连接
                db.close((closeErr) => {
                    if (closeErr) return console.error('❌ 关闭数据库失败:', closeErr.message);
                    console.log('🏁 数据库初始化脚本执行完毕！');
                });
            });
        })
        .catch((hashErr) => {
            console.error('❌ 默认密码加密失败:', hashErr.message);

            db.close((closeErr) => {
                if (closeErr) return console.error('❌ 关闭数据库失败:', closeErr.message);
                console.log('🏁 数据库初始化脚本执行完毕！');
            });
        });
});
