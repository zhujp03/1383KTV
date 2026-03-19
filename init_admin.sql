-- 1. 创建 admins 数据表 (如果不存在的话)
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
);

-- 2. 强行插入默认账号 (admin / admin123)
-- 使用 INSERT OR IGNORE 是为了防止重复运行报错
-- admin123 的 bcrypt 哈希 (cost=10)
INSERT OR IGNORE INTO admins (username, password) VALUES ('admin', '$2b$10$RQoXV7t5Mj/U4h7ZC2b8Lug8w8ow2yTp9k1GIbA751rCP1HzjC3OG');

-- 3. (可选) 清理一些测试用的脏数据，保持初始化干净
-- DELETE FROM bookings WHERE date < '2020-01-01';