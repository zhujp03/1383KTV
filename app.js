// app.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// ==========================================
// 1. 中间件配置
// ==========================================
app.use(cors()); // 允许前端跨域请求
app.use(express.json()); // 允许 Express 解析前端发来的 JSON 数据
app.use(express.static(path.join(__dirname))); // 托管静态文件

app.get('/', (req, res) => {
    res.redirect('/pages/homeindex.html');
});

// ==========================================
// 2. 数据库连接 (ktv_data.db 和 admin.db)
// ==========================================

// 初始化业务数据库 (预订信息)
// const db = new sqlite3.Database('./ktv_data.db', (err) => {
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
const db = new sqlite3.Database('./ktv_data.db', (err) => {
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
const adminDb = new sqlite3.Database('./admin.db', (err) => {
    if (err) {
        console.error('Admin DB failed:', err.message);
    } else {
        console.log('✅ Connected to admin.db successfully.');
        // 确保 admins 表存在
        adminDb.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )`);
    }
});

// 历史订单数据库（最多保留两个月）
const historyDb = new sqlite3.Database('./history_orders.db', (err) => {
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
const customerDb = new sqlite3.Database('./valid_customers.db', (err) => {
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

// 4.1 客户提交预订 API
app.post('/api/book', (req, res) => {
    const { room, partySize, date, time, duration, name, phone } = req.body;
    const sql = `INSERT INTO bookings (room, partySize, date, time, duration, name, phone) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [room, partySize, date, time, duration, name, phone], function(err) {
        if (err) {
            console.error('Error inserting data:', err);
            return res.status(500).json({ error: 'Failed to save booking to database.' });
        }
        const bookingId = this.lastID;
        syncValidCustomer(name, phone);

        res.status(200).json({ message: 'Booking successful!', bookingId });
    });
});

// 4.2 客户查询预订 API (根据手机号)
app.get('/api/book/search/:phone', (req, res) => {
    const searchPhone = req.params.phone;

    // 根据手机号查询，按照日期和时间降序排列 (最新的排前面)
    const sql = `SELECT * FROM bookings WHERE phone = ? ORDER BY date DESC, time DESC`;

    db.all(sql, [searchPhone], (err, rows) => {
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

    // 验证这个预订是否属于这个手机号
    db.get(`SELECT id, name, phone, deposit FROM bookings WHERE id = ? AND phone = ?`, [bookingId, phone], (err, booking) => {
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
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    adminDb.get("SELECT * FROM admins WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err || !row) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // 登录成功时触发一次过期清理
        cleanupOldBookings();
        cleanupOldHistoricalOrders();

        res.json({ message: 'Login successful', username: row.username });
    });
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
app.post('/api/admin/add', checkAdminLogin, (req, res) => {
    const { newUsername, newPassword } = req.body;

    adminDb.run("INSERT INTO admins (username, password) VALUES (?, ?)", [newUsername, newPassword], function(err) {
        if (err) return res.status(400).json({ error: 'Username already exists.' });
        res.json({ message: 'New admin added successfully.', id: this.lastID });
    });
});

// 5.5 修改其他管理员密码 API (受保护)
app.put('/api/admin/password/:id', checkAdminLogin, (req, res) => {
    const adminIdToUpdate = req.params.id;
    const { newPassword } = req.body;

    adminDb.run("UPDATE admins SET password = ? WHERE id = ?", [newPassword, adminIdToUpdate], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to update password.' });
        res.json({ message: 'Password updated successfully.' });
    });
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
});