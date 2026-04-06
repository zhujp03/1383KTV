// setup_db.js - 用于初始化数据库和默认管理员
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const BCRYPT_ROUNDS = 10;
const DEFAULT_DATABASE_DIR = path.join(__dirname, 'database');
const DATABASE_DIR_INPUT = String(process.env.DATABASE_DIR || DEFAULT_DATABASE_DIR).trim();
const DATABASE_DIR = path.isAbsolute(DATABASE_DIR_INPUT)
    ? DATABASE_DIR_INPUT
    : path.join(__dirname, DATABASE_DIR_INPUT);
const ADMIN_DB_PATH = path.join(DATABASE_DIR, 'admin.db');

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
    const defaultUser = 'admin';
    const defaultPass = 'admin123';

    const sql = `INSERT OR IGNORE INTO admins (username, password) VALUES (?, ?)`;

    bcrypt.hash(defaultPass, BCRYPT_ROUNDS)
        .then((hashedPass) => {
            db.run(sql, [defaultUser, hashedPass], function(err) {
                if (err) {
                    return console.error('❌ 插入默认管理员失败:', err.message);
                }

                // this.changes 会告诉你是否真的插入了新数据
                if (this.changes > 0) {
                    console.log(`🎉 默认管理员创建成功！\n👉 账号: ${defaultUser}\n👉 密码: ${defaultPass}`);
                } else {
                    console.log(`⚠️ 默认管理员 '${defaultUser}' 已经存在，跳过创建。`);
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
