// //app.js
// const express = require('express');
// const sqlite3 = require('sqlite3').verbose();
// const cors = require('cors');
// const path = require('path');
//
// const app = express();
// const PORT = 3000;
//
// // 1. 中间件配置
// app.use(cors()); // 允许前端跨域请求
// app.use(express.json()); // 允许 Express 解析前端发来的 JSON 数据
// app.use(express.static(path.join(__dirname))); // 托管静态文件
//
// // 2. 初始化 SQLite3 数据库
// // 运行后会在根目录自动生成 ktv_data.db 文件
// const db = new sqlite3.Database('./ktv_data.db', (err) => {
//     if (err) {
//         console.error('Database connection failed:', err.message);
//     } else {
//         console.log('Connected to SQLite database successfully.');
//         // 创建预订数据表
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
//
// // ==========================================
// // API 路由区域
// // ==========================================
//
// // 3. 客户 API：接收前端预订数据并写入数据库
// app.post('/api/book', (req, res) => {
//     // 从前端发送的 JSON body 中提取数据
//     const { room, partySize, date, time, duration, name, phone } = req.body;
//
//     // SQL 插入语句
//     const sql = `INSERT INTO bookings (room, partySize, date, time, duration, name, phone) VALUES (?, ?, ?, ?, ?, ?, ?)`;
//
//     // 执行 SQL
//     db.run(sql, [room, partySize, date, time, duration, name, phone], function(err) {
//         if (err) {
//             console.error('Error inserting data:', err);
//             return res.status(500).json({ error: 'Failed to save booking to database.' });
//         }
//         // this.lastID 是 SQLite 自动生成的订单号
//         res.status(200).json({ message: 'Booking successful!', bookingId: this.lastID });
//     });
// });
//
// // 4. 管理员 API：供后台调用的查询接口
// app.get('/api/admin/bookings', (req, res) => {
//     // SQL 查询语句：获取所有订单，按创建时间倒序排列 (最新的在最前)
//     const sql = `SELECT * FROM bookings ORDER BY created_at DESC`;
//
//     db.all(sql, [], (err, rows) => {
//         if (err) {
//             console.error('Error fetching data:', err);
//             return res.status(500).json({ error: 'Failed to fetch bookings.' });
//         }
//         // 将数据库查询到的所有行作为 JSON 返回
//         res.status(200).json({ total: rows.length, data: rows });
//     });
// });
//
// // ==========================================
// // 1. 初始化 admin.db (明文存储版)
// // ==========================================
// const adminDb = new sqlite3.Database('./admin.db', (err) => {
//     if (err) {
//         console.error('Admin DB failed:', err.message);
//     } else {
//         console.log('Connected to admin.db');
//         // 创建 admins 表
//         adminDb.run(`CREATE TABLE IF NOT EXISTS admins (
//             id INTEGER PRIMARY KEY AUTOINCREMENT,
//             username TEXT UNIQUE NOT NULL,
//             password TEXT NOT NULL
//         )`, () => {
//             // 如果数据库是空的，自动创建一个默认的明文超级管理员
//             adminDb.get("SELECT COUNT(*) AS count FROM admins", (err, row) => {
//                 if (row && row.count === 0) {
//                     adminDb.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', 'admin123']);
//                     console.log('🤖 Default admin created (Plaintext): username[admin], password[admin123]');
//                 }
//             });
//         });
//     }
// });
//
// // ==========================================
// // 2. 自动清理过期预约的函数
// // ==========================================
// function cleanupOldBookings() {
//     // SQLite 的 date('now', 'localtime') 获取今天的本地日期 YYYY-MM-DD
//     // 删除所有 date 小于今天的记录（清理昨天及以前的）
//     const sql = `DELETE FROM bookings WHERE date < date('now', 'localtime')`;
//     db.run(sql, function(err) {
//         if (err) console.error("Auto-cleanup failed:", err);
//         else if (this.changes > 0) {
//             console.log(`🧹 Auto-cleanup executed: Deleted ${this.changes} outdated bookings.`);
//         }
//     });
// }
//
// // ==========================================
// // 3. 极简身份验证中间件
// // ==========================================
// // 因为没有加密 token，我们只检查请求头里有没有传 'x-admin-username'
// function checkAdminLogin(req, res, next) {
//     const adminUser = req.headers['x-admin-username'];
//     if (!adminUser) {
//         return res.status(401).json({ error: 'Access denied. Please log in first.' });
//     }
//     req.adminUser = adminUser; // 记录当前操作的管理员名字
//     next();
// }
//
// // ==========================================
// // 4. 管理员 API 接口 (明文比对)
// // ==========================================
//
// // 登录 API
// app.post('/api/admin/login', (req, res) => {
//     const { username, password } = req.body;
//
//     // 直接在数据库里同时比对用户名和明文密码
//     adminDb.get("SELECT * FROM admins WHERE username = ? AND password = ?", [username, password], (err, row) => {
//         if (err || !row) {
//             return res.status(401).json({ error: 'Invalid username or password.' });
//         }
//
//         // 账号密码完全匹配，登录成功！触发清理过期预约
//         cleanupOldBookings();
//
//         res.json({ message: 'Login successful', username: row.username });
//     });
// });
//
// // 获取管理员列表
// app.get('/api/admin/list', checkAdminLogin, (req, res) => {
//     adminDb.all("SELECT id, username FROM admins", [], (err, rows) => {
//         res.json(rows);
//     });
// });
//
// // 添加新管理员 (明文密码)
// app.post('/api/admin/add', checkAdminLogin, (req, res) => {
//     const { newUsername, newPassword } = req.body;
//
//     adminDb.run("INSERT INTO admins (username, password) VALUES (?, ?)", [newUsername, newPassword], function(err) {
//         if (err) return res.status(400).json({ error: 'Username already exists.' });
//         res.json({ message: 'New admin added successfully.', id: this.lastID });
//     });
// });
//
// // 修改其他管理员密码 (明文密码)
// app.put('/api/admin/password/:id', checkAdminLogin, (req, res) => {
//     const adminIdToUpdate = req.params.id;
//     const { newPassword } = req.body;
//
//     adminDb.run("UPDATE admins SET password = ? WHERE id = ?", [newPassword, adminIdToUpdate], function(err) {
//         if (err) return res.status(500).json({ error: 'Failed to update password.' });
//         res.json({ message: 'Password updated successfully.' });
//     });
// });
//
// // 删除管理员
// app.delete('/api/admin/delete/:id', checkAdminLogin, (req, res
//
// // 5. 启动服务器
// app.listen(PORT, () => {
//     console.log(`Server is running on http://localhost:${PORT}`);
// });

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
const db = new sqlite3.Database('./ktv_data.db', (err) => {
    if (err) {
        console.error('KTV Database connection failed:', err.message);
    } else {
        console.log('✅ Connected to ktv_data.db successfully.');
        // 确保预订数据表存在
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
        )`);
    }
});

// 初始化后台数据库 (管理员信息)
// 注意：这里不再负责插入初始账号，请使用外部 SQL 脚本初始化
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

// 客户提交预订 API
app.post('/api/book', (req, res) => {
    const { room, partySize, date, time, duration, name, phone } = req.body;
    const sql = `INSERT INTO bookings (room, partySize, date, time, duration, name, phone) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [room, partySize, date, time, duration, name, phone], function(err) {
        if (err) {
            console.error('Error inserting data:', err);
            return res.status(500).json({ error: 'Failed to save booking to database.' });
        }
        res.status(200).json({ message: 'Booking successful!', bookingId: this.lastID });
    });
});

// ==========================================
// 5. API 路由区域: 后台管理
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

    // 在 ktv_data.db (预订数据库) 中删除对应 ID 的记录
    db.run("DELETE FROM bookings WHERE id = ?", [bookingIdToDelete], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete booking.' });
        res.json({ message: 'Booking deleted successfully.' });
    });
});

// 客户查询预订 API (根据手机号)
app.get('/api/book/search/:phone', (req, res) => {
    const searchPhone = req.params.phone;

    // 根据手机号查询，按照日期和时间降序排列 (最新的排前面)
    const sql = `SELECT * FROM bookings WHERE phone = ? ORDER BY date DESC, time DESC`;

    db.all(sql, [searchPhone], (err, rows) => {
        if (err) {
            console.error('Error searching bookings:', err);
            return res.status(500).json({ error: 'Failed to search bookings.' });
        }
        // 把查到的结果返回给前端
        res.status(200).json({ data: rows });
    });
});

// ==========================================
// 6. 启动服务器
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});