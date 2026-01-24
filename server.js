const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'dental_booking.db');

let db;

// Treatment types with durations (in minutes)
const TREATMENTS = [
    { id: 1, name_en: 'Regular Checkup', name_ku: 'پشکنینی ئاسایی', duration: 30 },
    { id: 2, name_en: 'Teeth Cleaning', name_ku: 'پاککردنەوەی ددان', duration: 45 },
    { id: 3, name_en: 'Tooth Filling', name_ku: 'پڕکردنەوەی ددان', duration: 60 },
    { id: 4, name_en: 'Tooth Extraction', name_ku: 'ددان کشان', duration: 45 },
    { id: 5, name_en: 'Root Canal', name_ku: 'دەمار بڕین', duration: 90 },
    { id: 6, name_en: 'Dental Crown', name_ku: 'کیفی ددان', duration: 60 },
    { id: 7, name_en: 'Teeth Whitening', name_ku: 'سپیکردنەوەی ددان', duration: 60 },
    { id: 8, name_en: 'Dental X-Ray', name_ku: 'تیشکی ددان', duration: 15 },
    { id: 9, name_en: 'Dental Implant Consultation', name_ku: 'ڕاوێژی چاندنی ددان', duration: 30 },
    { id: 10, name_en: 'Gum Treatment', name_ku: 'پووک بڕین بۆ جوانکاری', duration: 45 }
];

// Clinic schedule
// Saturday=6, Sunday=0, Monday=1, Tuesday=2, Wednesday=3
// Closed: Thursday=4, Friday=5
const CLINIC_SCHEDULE = {
    openDays: [6, 0, 1, 2, 3], // شەمە - یەک شەمە - دوو شەمە - سێ شەمە - چوارشەمە
    closedDays: [4, 5], // پێنجشەممە - هەینی (Thursday, Friday)
    openTime: '13:00',
    closeTime: '19:00',
    slotDuration: 15 // minutes
};

async function initDB() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER NOT NULL,
            treatment_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            notes TEXT,
            created_by TEXT DEFAULT 'patient',
            confirmed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (patient_id) REFERENCES patients(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS blocked_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create default admin if not exists
    const adminCheck = db.exec("SELECT * FROM admins WHERE username = 'admin'");
    if (adminCheck.length === 0) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO admins (username, password, name) VALUES (?, ?, ?)", 
            ['admin', hashedPassword, 'د. نازە وشیار']);
    }

    saveDB();
}

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'dental-clinic-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Helper functions
function generateTimeSlots(date, treatmentDuration) {
    const slots = [];
    const [openHour, openMin] = CLINIC_SCHEDULE.openTime.split(':').map(Number);
    const [closeHour, closeMin] = CLINIC_SCHEDULE.closeTime.split(':').map(Number);
    
    let currentTime = openHour * 60 + openMin;
    const endTime = closeHour * 60 + closeMin;
    
    while (currentTime + treatmentDuration <= endTime) {
        const hours = Math.floor(currentTime / 60);
        const mins = currentTime % 60;
        const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        
        const endMins = currentTime + treatmentDuration;
        const endHours = Math.floor(endMins / 60);
        const endMinsRem = endMins % 60;
        const endTimeStr = `${endHours.toString().padStart(2, '0')}:${endMinsRem.toString().padStart(2, '0')}`;
        
        slots.push({
            start: timeStr,
            end: endTimeStr,
            display: `${timeStr} - ${endTimeStr}`
        });
        
        currentTime += CLINIC_SCHEDULE.slotDuration;
    }
    
    return slots;
}

function isSlotAvailable(date, startTime, endTime, excludeAppointmentId = null) {
    // Check blocked slots
    const blockedCheck = db.exec(`
        SELECT * FROM blocked_slots 
        WHERE date = '${date}' 
        AND NOT (end_time <= '${startTime}' OR start_time >= '${endTime}')
    `);
    if (blockedCheck.length > 0 && blockedCheck[0].values.length > 0) {
        return false;
    }
    
    // Check existing appointments
    let query = `
        SELECT * FROM appointments 
        WHERE date = '${date}' 
        AND status != 'cancelled'
        AND NOT (end_time <= '${startTime}' OR start_time >= '${endTime}')
    `;
    if (excludeAppointmentId) {
        query += ` AND id != ${excludeAppointmentId}`;
    }
    
    const appointmentCheck = db.exec(query);
    return !(appointmentCheck.length > 0 && appointmentCheck[0].values.length > 0);
}

function isDayOpen(date) {
    const dayOfWeek = new Date(date).getDay();
    return CLINIC_SCHEDULE.openDays.includes(dayOfWeek);
}

// API Routes

// Get treatments
app.get('/api/treatments', (req, res) => {
    res.json(TREATMENTS);
});

// Get clinic schedule
app.get('/api/schedule', (req, res) => {
    res.json(CLINIC_SCHEDULE);
});

// Get available slots for a date and treatment
app.get('/api/slots/:date/:treatmentId', (req, res) => {
    const { date, treatmentId } = req.params;
    const showAll = req.query.showAll === 'true';
    
    if (!isDayOpen(date)) {
        return res.json({ available: false, message: 'Clinic is closed on this day', slots: [] });
    }
    
    const treatment = TREATMENTS.find(t => t.id === parseInt(treatmentId));
    if (!treatment) {
        return res.status(400).json({ error: 'Invalid treatment' });
    }
    
    const allSlots = generateTimeSlots(date, treatment.duration);
    
    if (showAll) {
        // Return all slots with booked status
        const slotsWithStatus = allSlots.map(slot => ({
            ...slot,
            booked: !isSlotAvailable(date, slot.start, slot.end)
        }));
        res.json({ available: true, slots: slotsWithStatus });
    } else {
        // Return only available slots (old behavior)
        const availableSlots = allSlots.filter(slot => 
            isSlotAvailable(date, slot.start, slot.end)
        );
        res.json({ available: true, slots: availableSlots });
    }
});

// Patient login/register
app.post('/api/patient/auth', (req, res) => {
    const { phone, name } = req.body;
    
    if (!phone || !name) {
        return res.status(400).json({ error: 'Phone and name are required' });
    }
    
    // Clean phone number
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Check if patient exists
    const existing = db.exec(`SELECT * FROM patients WHERE phone = '${cleanPhone}'`);
    
    let patientId;
    if (existing.length > 0 && existing[0].values.length > 0) {
        patientId = existing[0].values[0][0];
        // Update name if different
        db.run(`UPDATE patients SET name = ? WHERE id = ?`, [name, patientId]);
    } else {
        db.run(`INSERT INTO patients (phone, name) VALUES (?, ?)`, [cleanPhone, name]);
        const result = db.exec('SELECT last_insert_rowid()');
        patientId = result[0].values[0][0];
    }
    
    saveDB();
    
    req.session.patientId = patientId;
    req.session.patientPhone = cleanPhone;
    req.session.patientName = name;
    
    res.json({ success: true, patientId, name });
});

// Book appointment (patient)
app.post('/api/appointments', (req, res) => {
    if (!req.session.patientId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    
    const { treatmentId, date, startTime, endTime, notes } = req.body;
    
    if (!isDayOpen(date)) {
        return res.status(400).json({ error: 'Clinic is closed on this day' });
    }
    
    if (!isSlotAvailable(date, startTime, endTime)) {
        return res.status(400).json({ error: 'This time slot is not available' });
    }
    
    db.run(`
        INSERT INTO appointments (patient_id, treatment_id, date, start_time, end_time, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'patient')
    `, [req.session.patientId, treatmentId, date, startTime, endTime, notes || '']);
    
    saveDB();
    
    io.emit('newAppointment');
    
    res.json({ success: true, message: 'Appointment booked successfully. Admin will call to confirm.' });
});

// Get patient appointments
app.get('/api/patient/appointments', (req, res) => {
    if (!req.session.patientId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    
    const result = db.exec(`
        SELECT a.*, p.name as patient_name, p.phone as patient_phone
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id
        WHERE a.patient_id = ${req.session.patientId}
        ORDER BY a.date DESC, a.start_time DESC
    `);
    
    if (result.length === 0) {
        return res.json([]);
    }
    
    const columns = result[0].columns;
    const appointments = result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = row[i]);
        obj.treatment = TREATMENTS.find(t => t.id === obj.treatment_id);
        return obj;
    });
    
    res.json(appointments);
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    const result = db.exec(`SELECT * FROM admins WHERE username = '${username}'`);
    
    if (result.length === 0 || result[0].values.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const admin = result[0].values[0];
    const adminObj = {
        id: admin[0],
        username: admin[1],
        password: admin[2],
        name: admin[3]
    };
    
    if (!bcrypt.compareSync(password, adminObj.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.adminId = adminObj.id;
    req.session.adminName = adminObj.name;
    
    res.json({ success: true, name: adminObj.name });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Check admin auth
app.get('/api/admin/check', (req, res) => {
    if (req.session.adminId) {
        res.json({ authenticated: true, name: req.session.adminName });
    } else {
        res.json({ authenticated: false });
    }
});

// Admin middleware
function requireAdmin(req, res, next) {
    if (!req.session.adminId) {
        return res.status(401).json({ error: 'Admin access required' });
    }
    next();
}

// Get all appointments (admin)
app.get('/api/admin/appointments', requireAdmin, (req, res) => {
    const { date, status } = req.query;
    
    let query = `
        SELECT a.*, p.name as patient_name, p.phone as patient_phone
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id
        WHERE 1=1
    `;
    
    if (date) {
        query += ` AND a.date = '${date}'`;
    }
    if (status) {
        query += ` AND a.status = '${status}'`;
    }
    
    query += ' ORDER BY a.date DESC, a.start_time ASC';
    
    const result = db.exec(query);
    
    if (result.length === 0) {
        return res.json([]);
    }
    
    const columns = result[0].columns;
    const appointments = result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = row[i]);
        obj.treatment = TREATMENTS.find(t => t.id === obj.treatment_id);
        return obj;
    });
    
    res.json(appointments);
});

// Get all patients (admin)
app.get('/api/admin/patients', requireAdmin, (req, res) => {
    const result = db.exec(`
        SELECT p.*, 
            (SELECT COUNT(*) FROM appointments WHERE patient_id = p.id) as total_appointments,
            (SELECT COUNT(*) FROM appointments WHERE patient_id = p.id AND status = 'completed') as completed_appointments
        FROM patients p
        ORDER BY p.created_at DESC
    `);
    
    if (result.length === 0) {
        return res.json([]);
    }
    
    const columns = result[0].columns;
    const patients = result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
    });
    
    res.json(patients);
});

// Create appointment manually (admin)
app.post('/api/admin/appointments', requireAdmin, (req, res) => {
    const { patientPhone, patientName, treatmentId, date, startTime, endTime, notes, status } = req.body;
    
    if (!isDayOpen(date)) {
        return res.status(400).json({ error: 'Clinic is closed on this day' });
    }
    
    if (!isSlotAvailable(date, startTime, endTime)) {
        return res.status(400).json({ error: 'This time slot is not available' });
    }
    
    // Find or create patient
    const cleanPhone = patientPhone.replace(/\D/g, '');
    let patientId;
    
    const existing = db.exec(`SELECT id FROM patients WHERE phone = '${cleanPhone}'`);
    if (existing.length > 0 && existing[0].values.length > 0) {
        patientId = existing[0].values[0][0];
        db.run(`UPDATE patients SET name = ? WHERE id = ?`, [patientName, patientId]);
    } else {
        db.run(`INSERT INTO patients (phone, name) VALUES (?, ?)`, [cleanPhone, patientName]);
        const result = db.exec('SELECT last_insert_rowid()');
        patientId = result[0].values[0][0];
    }
    
    db.run(`
        INSERT INTO appointments (patient_id, treatment_id, date, start_time, end_time, notes, created_by, status)
        VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)
    `, [patientId, treatmentId, date, startTime, endTime, notes || '', status || 'confirmed']);
    
    saveDB();
    
    io.emit('appointmentUpdated');
    
    res.json({ success: true });
});

// Update appointment status (admin)
app.patch('/api/admin/appointments/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    let query = 'UPDATE appointments SET ';
    const updates = [];
    
    if (status) {
        updates.push(`status = '${status}'`);
        if (status === 'confirmed') {
            updates.push(`confirmed_at = datetime('now')`);
        }
    }
    if (notes !== undefined) {
        updates.push(`notes = '${notes}'`);
    }
    
    query += updates.join(', ') + ` WHERE id = ${id}`;
    db.run(query);
    saveDB();
    
    io.emit('appointmentUpdated');
    
    res.json({ success: true });
});

// Delete appointment (admin)
app.delete('/api/admin/appointments/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM appointments WHERE id = ${id}`);
    saveDB();
    
    io.emit('appointmentUpdated');
    
    res.json({ success: true });
});

// Block time slot (admin)
app.post('/api/admin/block-slot', requireAdmin, (req, res) => {
    const { date, startTime, endTime, reason } = req.body;
    
    db.run(`
        INSERT INTO blocked_slots (date, start_time, end_time, reason)
        VALUES (?, ?, ?, ?)
    `, [date, startTime, endTime, reason || '']);
    
    saveDB();
    res.json({ success: true });
});

// Get blocked slots (admin)
app.get('/api/admin/blocked-slots', requireAdmin, (req, res) => {
    const { date } = req.query;
    
    let query = 'SELECT * FROM blocked_slots';
    if (date) {
        query += ` WHERE date = '${date}'`;
    }
    query += ' ORDER BY date DESC, start_time ASC';
    
    const result = db.exec(query);
    
    if (result.length === 0) {
        return res.json([]);
    }
    
    const columns = result[0].columns;
    const slots = result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
    });
    
    res.json(slots);
});

// Delete blocked slot (admin)
app.delete('/api/admin/blocked-slots/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM blocked_slots WHERE id = ${id}`);
    saveDB();
    res.json({ success: true });
});

// Dashboard stats (admin)
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const todayAppointments = db.exec(`
        SELECT COUNT(*) FROM appointments WHERE date = '${today}' AND status != 'cancelled'
    `);
    
    const pendingAppointments = db.exec(`
        SELECT COUNT(*) FROM appointments WHERE status = 'pending'
    `);
    
    const totalPatients = db.exec(`
        SELECT COUNT(*) FROM patients
    `);
    
    const thisWeekCompleted = db.exec(`
        SELECT COUNT(*) FROM appointments 
        WHERE status = 'completed' 
        AND date >= date('now', '-7 days')
    `);
    
    const upcomingAppointments = db.exec(`
        SELECT a.*, p.name as patient_name, p.phone as patient_phone
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id
        WHERE a.date >= '${today}' AND a.status != 'cancelled'
        ORDER BY a.date ASC, a.start_time ASC
        LIMIT 10
    `);
    
    let upcoming = [];
    if (upcomingAppointments.length > 0) {
        const columns = upcomingAppointments[0].columns;
        upcoming = upcomingAppointments[0].values.map(row => {
            const obj = {};
            columns.forEach((col, i) => obj[col] = row[i]);
            obj.treatment = TREATMENTS.find(t => t.id === obj.treatment_id);
            return obj;
        });
    }
    
    res.json({
        todayAppointments: todayAppointments[0]?.values[0][0] || 0,
        pendingAppointments: pendingAppointments[0]?.values[0][0] || 0,
        totalPatients: totalPatients[0]?.values[0][0] || 0,
        thisWeekCompleted: thisWeekCompleted[0]?.values[0][0] || 0,
        upcomingAppointments: upcoming
    });
});

// Change admin password
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    const result = db.exec(`SELECT * FROM admins WHERE id = ${req.session.adminId}`);
    const admin = result[0].values[0];
    
    if (!bcrypt.compareSync(currentPassword, admin[2])) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }
    
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.run(`UPDATE admins SET password = ? WHERE id = ?`, [hashedPassword, req.session.adminId]);
    saveDB();
    
    res.json({ success: true });
});

// Serve main pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Initialize database and start server
initDB().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🦷 Dental Booking System running on http://localhost:${PORT}`);
        console.log(`👩‍⚕️ Dr. Naza Wshyar - Family Dentist`);
        console.log(`📅 Open: Sun-Wed & Sat, 1:00 PM - 7:00 PM`);
        console.log(`🔐 Admin: /admin (username: admin, password: admin123)`);
    });
});
