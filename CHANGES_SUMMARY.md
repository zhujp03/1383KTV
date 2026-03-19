# 修改总结 (问题 1 & 问题 2 解决方案)

## 问题 1: Deposit 状态回滚问题

**问题描述**: 当管理员把 deposit 从 "Yes" 改回 "No" 时，history_orders 和 valid_customers 数据库里的相关记录不会被删除。

### 解决方案:

#### 后端修改 (app.js)

1. **新增两个辅助函数** (第 159-180 行):
   - `removeValidCustomer(name, phone)`: 从 valid_customers 表中删除指定的客户记录
   - `removeHistoricalOrder(bookingId)`: 从 historical_orders 表中删除指定的历史订单

2. **修改 PUT /api/admin/bookings/:id 接口** (第 423-461 行):
   - 在更新 bookings 表之前，先查询该预订的旧 deposit 状态
   - 如果 deposit 从 "Yes" 改回 "No"，则：
     - 删除 historical_orders 中的该预订记录
     - 删除 valid_customers 中对应的客户记录
   - 如果 deposit 改成 "Yes"，则：
     - 添加或更新 historical_orders 和 valid_customers

**逻辑流程**:
```
当管理员修改预订的 deposit 时:
  ┌─ 查询旧的 deposit 值
  │
  ├─ 如果从 "Yes" 改回 "No" → 删除 history 和 valid_customers 里的记录
  │
  ├─ 如果改成 "Yes" → 添加到 history 和 valid_customers
  │
  └─ 其他情况 → 不处理 (保持原有数据)
```

---

## 问题 2: 用户自己取消预约功能

**问题描述**: 用户提交预约错误后，无法自行取消预约。需要允许用户输入手机号，查看自己的预约，并可选择取消。

### 解决方案:

#### 后端修改 (app.js)

新增 API 端点 (第 264-283 行):
```javascript
DELETE /api/book/cancel/:id/:phone
```

**功能**:
- 用户输入预订 ID 和手机号进行验证
- 确保预订属于该手机号（安全检查）
- 删除 bookings 表中的预订
- 如果该预订的 deposit 是 "Yes"，同时删除 history_orders 和 valid_customers 中的记录

#### 前端修改 (managebooking.html)

1. **添加取消预约弹窗** (第 44-54 行):
   - 弹窗显示预订详细信息 (预订 ID、日期、时间)
   - 提供"取消"和"保留"两个选项

2. **新增 JavaScript 函数**:
   - `openCancelModal(bookingId, date, time, phone)`: 打开取消弹窗
   - `closeCancelModal()`: 关闭弹窗
   - `handleCancelModalBackdropClick(event)`: 点击弹窗外背景关闭
   - `confirmCancelBooking()`: 确认取消，调用后端 API

3. **修改搜索结果卡片** (第 128-130 行):
   - 在每个预订卡片下方添加"Cancel Booking"按钮
   - 点击时打开确认弹窗

4. **取消成功提示**:
   - 关闭弹窗后自动刷新搜索结果
   - 显示绿色成功提示信息: "✓ Booking #XXX has been cancelled successfully."

#### 样式修改 (managebooking.css)

新增样式 (第 399-452 行):
- `.booking-actions`: 预订卡片操作按钮容器
- `.btn-cancel`: 取消按钮样式 (红色 #EF4444，hover 时深红 #DC2626)
- `.btn-danger`: 确认取消按钮样式
- `.modal-overlay`: 弹窗背景遮罩
- `.modal-box`: 弹窗内容框
- `.modal-actions`: 弹窗按钮容器

---

## 用户流程图

### 问题 1 流程 (管理员修改 deposit)
```
管理员打开预订编辑弹窗
    ↓
编辑 deposit 从 "No" → "Yes"
    ↓
点击"Save Changes"
    ↓
后端检测到 deposit 改成 "Yes"
    ↓
1. 更新 bookings 表的 deposit 为 "Yes"
2. 添加/更新 historical_orders 中的记录
3. 添加 valid_customers 中的客户信息
    ↓
预订显示在"Historical Orders"表和"Valid Customers"表中

---

管理员发现误操作，编辑 deposit 从 "Yes" → "No"
    ↓
点击"Save Changes"
    ↓
后端检测到 deposit 从 "Yes" 改回 "No"
    ↓
1. 更新 bookings 表的 deposit 为 "No"
2. 从 historical_orders 中删除该预订
3. 从 valid_customers 中删除该客户（如果是因为这个预订添加的）
    ↓
预订不再显示在"Historical Orders"表和"Valid Customers"表中
```

### 问题 2 流程 (用户自己取消预约)
```
用户进入"Search Your Reservation"页面
    ↓
输入手机号，点击"Search"
    ↓
页面显示该手机号的所有预订
    ↓
用户找到要取消的预订，点击"Cancel Booking"按钮
    ↓
弹窗弹出，显示预订详情和确认信息
    ↓
用户点击"Yes, Cancel"
    ↓
后端验证手机号和预订 ID 匹配
    ↓
1. 从 bookings 表中删除预订
2. 如果 deposit 是 "Yes"，也从 history_orders 和 valid_customers 中删除
    ↓
弹窗关闭，页面刷新
    ↓
显示绿色成功提示："✓ Booking #XXX has been cancelled successfully."
    ↓
预订列表更新，不再显示已取消的预订
```

---

## 技术细节

### 数据一致性保证
- 所有涉及 deposit 状态改变的操作都会同步更新三个数据库：
  - `bookings` (主表，一直存在)
  - `history_orders` (只在 deposit=Yes 时存在)
  - `valid_customers` (只在有 deposit=Yes 的预订时存在)

### 用户安全性
- 用户取消预约时，必须同时提供预订 ID 和手机号
- 后端验证手机号与预订 ID 匹配后才允许删除
- 防止用户通过修改 URL 参数删除其他人的预约

### 前端用户体验
- 取消操作前弹窗确认，防止误操作
- 成功后显示清晰的成功提示信息
- 失败时显示错误信息提示用户重试

---

## 测试建议

### 测试问题 1 (Deposit 回滚)
1. 在 admin 页面编辑一个预订，把 deposit 改成 "Yes"
2. 验证该预订出现在"Historical Orders"和"Valid Customers"表中
3. 再次编辑同一预订，把 deposit 改回 "No"
4. 验证该预订从两个表中消失
5. 原始 bookings 表中的记录保持不变

### 测试问题 2 (用户取消)
1. 用户进入"Search Your Reservation"
2. 输入手机号，搜索得到预订列表
3. 点击"Cancel Booking"
4. 验证弹窗显示正确的预订信息
5. 点击"Yes, Cancel"
6. 验证预订被删除，成功提示显示
7. 刷新搜索结果，确认预订不再存在

---

## 文件修改清单

| 文件 | 修改内容 | 行数 |
|------|--------|------|
| app.js | 新增 removeValidCustomer, removeHistoricalOrder 函数；修改 PUT /api/admin/bookings/:id；新增 DELETE /api/book/cancel/:id/:phone | 159-283 |
| pages/managebooking.html | 新增取消弹窗；修改搜索结果渲染；新增取消函数 | 44-135 |
| styles/managebooking.css | 新增 .booking-actions, .btn-cancel, .modal-* 等样式 | 399-452 |

