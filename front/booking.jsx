import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

// 房间数据配置
const roomsData = [
    { id: 'small', name: 'Small Room', price: 30, capacity: '1-4 people', img: './room_pic/small.jpg', features: ['Premium sound system', 'LED lighting'] },
    { id: 'mid', name: 'Medium Room', price: 60, capacity: '1-8 people', img: './room_pic/mid.jpg', features: ['Enhanced sound system', 'Dynamic lighting'] },
    { id: 'large', name: 'Large Room', price: 100, capacity: '1-15 people', img: './room_pic/large.jpg', features: ['Professional sound system', 'Stage lighting'] }
];

const BookingApp = () => {
    // --- 状态管理 (State) ---
    const [step, setStep] = useState(1);
    const [partySize, setPartySize] = useState(1);
    const [selectedRoom, setSelectedRoom] = useState(null);
    const [duration, setDuration] = useState('');
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [selectedDate, setSelectedDate] = useState(null);
    const [selectedTime, setSelectedTime] = useState(null);
    const [customerInfo, setCustomerInfo] = useState({ name: '', phone: '' });

    // --- Step 1: 选择房间与人数 ---
    const renderStep1 = () => (
        <div className="step-content">
            <h2 className="step-title">Choose Your Room</h2>
            <p className="step-subtitle">Pick a room, then tell us about your party</p>

            <div className="party-size-selector">
                <span>Party Size</span>
                <div className="counter">
                    <button onClick={() => setPartySize(p => Math.max(1, p - 1))}>-</button>
                    <span>{partySize}</span>
                    <button onClick={() => setPartySize(p => p + 1)}>+</button>
                </div>
            </div>

            <div className="rooms-grid">
                {roomsData.map(room => (
                    <div
                        key={room.id}
                        className={`room-card ${selectedRoom === room.id ? 'selected' : ''}`}
                        onClick={() => setSelectedRoom(room.id)}
                    >
                        <div className="card-header">
                            <h3>{room.name}</h3>
                            <span className="price">${room.price}/hr</span>
                        </div>
                        <p className="capacity">👥 {room.capacity}</p>
                        <ul className="features">
                            {room.features.map((f, i) => <li key={i}>✦ {f}</li>)}
                        </ul>
                    </div>
                ))}
            </div>

            <div className="actions">
                <button
                    className="next-btn"
                    disabled={!selectedRoom}
                    onClick={() => setStep(2)}
                >
                    Next →
                </button>
            </div>
        </div>
    );

    // --- Step 2: 选择时长 ---
    const handleDurationSelect = (opt) => {
        if (opt.includes('6h+')) {
            alert('For bookings over 6 hours, please call us directly!');
            setDuration('');
        } else {
            setDuration(opt);
        }
        setIsDrawerOpen(false);
    };

    const renderStep2 = () => (
        <div className="step-content">
            <h2 className="step-title">Select Duration</h2>
            <div
                className="duration-input"
                onClick={() => setIsDrawerOpen(true)}
            >
                {duration || 'Select duration...'}
            </div>

            {isDrawerOpen && (
                <div className="drawer-overlay" onClick={() => setIsDrawerOpen(false)}>
                    <div className="drawer-content" onClick={e => e.stopPropagation()}>
                        <h3>Select Duration</h3>
                        {['1 hour', '2 hours', '3 hours', '4 hours', '5 hours', '6h+ (Call Us)'].map(opt => (
                            <button key={opt} className="drawer-btn" onClick={() => handleDurationSelect(opt)}>
                                {opt}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="actions">
                <button className="back-btn" onClick={() => setStep(1)}>← Back</button>
                <button className="next-btn" disabled={!duration} onClick={() => setStep(3)}>Next →</button>
            </div>
        </div>
    );

    // --- Step 3: 日期与时间 (简易版) ---
    const renderStep3 = () => (
        <div className="step-content">
            <h2 className="step-title">Select Date & Time</h2>
            <div className="calendar-placeholder">
                {/* 这里使用简化的网格代表日历 */}
                <div className="days-grid">
                    {[10, 11, 12, 13, 14, 15, 16].map(day => (
                        <div
                            key={day}
                            className={`day-box ${selectedDate === day ? 'selected' : ''}`}
                            onClick={() => setSelectedDate(day)}
                        >
                            March {day}
                        </div>
                    ))}
                </div>
            </div>

            {selectedDate && (
                <div className="time-grid">
                    {['6:00 PM', '8:00 PM', '10:00 PM'].map(time => (
                        <button
                            key={time}
                            className={`time-btn ${selectedTime === time ? 'selected' : ''}`}
                            onClick={() => setSelectedTime(time)}
                        >
                            {time}
                        </button>
                    ))}
                </div>
            )}

            <div className="actions">
                <button className="back-btn" onClick={() => setStep(2)}>← Back</button>
                <button className="next-btn" disabled={!selectedTime} onClick={() => setStep(4)}>Next →</button>
            </div>
        </div>
    );

    // --- Step 4: 客户信息 ---
    const renderStep4 = () => (
        <div className="step-content">
            <h2 className="step-title">Customer Info</h2>
            <div className="form-group">
                <input
                    type="text"
                    placeholder="Your Name"
                    value={customerInfo.name}
                    onChange={e => setCustomerInfo({...customerInfo, name: e.target.value})}
                />
                <input
                    type="tel"
                    placeholder="Phone Number"
                    value={customerInfo.phone}
                    onChange={e => setCustomerInfo({...customerInfo, phone: e.target.value})}
                />
            </div>
            <div className="actions">
                <button className="back-btn" onClick={() => setStep(3)}>← Back</button>
                <button
                    className="next-btn"
                    disabled={!customerInfo.name || !customerInfo.phone}
                    onClick={() => setStep(5)}
                >
                    Next →
                </button>
            </div>
        </div>
    );

    // --- Step 5: 确认页面 ---
    const renderStep5 = () => (
        <div className="step-content summary-box">
            <h2 className="step-title">Review & Confirm</h2>
            <p><strong>Room:</strong> {roomsData.find(r => r.id === selectedRoom)?.name}</p>
            <p><strong>Party Size:</strong> {partySize} people</p>
            <p><strong>Duration:</strong> {duration}</p>
            <p><strong>Time:</strong> March {selectedDate}, {selectedTime}</p>
            <p><strong>Name:</strong> {customerInfo.name} ({customerInfo.phone})</p>

            <div className="actions">
                <button className="back-btn" onClick={() => setStep(4)}>← Back</button>
                <button className="confirm-btn" onClick={() => alert('Booking Submitted!')}>Confirm Booking</button>
            </div>
        </div>
    );

    // --- 主渲染逻辑 ---
    return (
        <div className="booking-container">
            {/* 顶部进度条 */}
            <div className="stepper">
                {[1, 2, 3, 4, 5].map(num => (
                    <div key={num} className={`step-circle ${step >= num ? 'active' : ''}`}>
                        {num}
                    </div>
                ))}
            </div>

            {/* 动态渲染对应的步骤 */}
            {step === 1 && renderStep1()}
            {step === 2 && renderStep2()}
            {step === 3 && renderStep3()}
            {step === 4 && renderStep4()}
            {step === 5 && renderStep5()}
        </div>
    );
};

// 找到 index.html 里的根节点并挂载 React 应用
const rootElement = document.getElementById('booking-root');
if (rootElement) {
    const root = createRoot(rootElement);
    root.render(<BookingApp />);
}