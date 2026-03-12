-- 1. 创建 admins 数据表 (如果不存在的话)
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
);

-- 2. 强行插入默认账号 (admin / admin123)
-- 使用 INSERT OR IGNORE 是为了防止重复运行报错
INSERT OR IGNORE INTO admins (username, password) VALUES ('admin', 'admin123');

-- 3. (可选) 清理一些测试用的脏数据，保持初始化干净
-- DELETE FROM bookings WHERE date < '2020-01-01';