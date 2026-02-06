const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Turso Database Connection
const db = createClient({
    url: process.env.TURSO_URL || 'libsql://dental-clinic-me-zheer-nawzad.aws-eu-west-1.turso.io',
    authToken: process.env.TURSO_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJleHAiOjE3NzcxODE5ODEsImlhdCI6MTc2OTQwNTk4MSwiaWQiOiI3MDE2YWU3MS03ZTM5LTRmMTUtOGIxNS00MWFkYTUwNWY1NTEiLCJyaWQiOiJmOGRjODFjNi0wZGVjLTQ1YWYtOGI5ZS02MDk5ZGUxMGQwNzYifQ.0YrI1iWVwCNLUstJ-2RSbVf44yUmQozWNuqCfqH9tbd170jNg5EAuo0Fcph6DqYvK3w_bpcjuK6TXAATrkBCAg'
});

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
const CLINIC_SCHEDULE = {
    openDays: [6, 0, 1, 2, 3],
    closedDays: [4, 5],
    openTime: '13:00',
    closeTime: '19:00',
    slotDuration: 15
};

async function initDB() {
    // Create tables
    await db.execute(`
        CREATE TABLE IF NOT EXISTS patients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            age INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Add age column if not exists (for existing databases)
    try {
        await db.execute("ALTER TABLE patients ADD COLUMN age INTEGER");
    } catch(e) {
        // Column already exists
    }

    await db.execute(`
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

    await db.execute(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.execute(`
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
    const adminCheck = await db.execute("SELECT * FROM admins WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await db.execute({
            sql: "INSERT INTO admins (username, password, name) VALUES (?, ?, ?)",
            args: ['admin', hashedPassword, 'د. نازە وشیار']
        });
    }

    console.log('Database initialized successfully!');
}

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
        const startStr = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        
        const endMins = currentTime + treatmentDuration;
        const endHours = Math.floor(endMins / 60);
        const endMinsRem = endMins % 60;
        const endStr = `${String(endHours).padStart(2, '0')}:${String(endMinsRem).padStart(2, '0')}`;
        
        slots.push({
            start: startStr,
            end: endStr
        });
        
        currentTime += CLINIC_SCHEDULE.slotDuration;
    }
    
    return slots;
}

async function isSlotAvailable(date, startTime, endTime) {
    // Check blocked slots
    const blocked = await db.execute({
        sql: `SELECT * FROM blocked_slots 
              WHERE date = ? AND (
                  (start_time <= ? AND end_time > ?) OR
                  (start_time < ? AND end_time >= ?) OR
                  (start_time >= ? AND end_time <= ?)
              )`,
        args: [date, startTime, startTime, endTime, endTime, startTime, endTime]
    });
    
    if (blocked.rows.length > 0) return false;

    // Check existing appointments
    const appointments = await db.execute({
        sql: `SELECT * FROM appointments 
              WHERE date = ? AND status != 'cancelled' AND (
                  (start_time <= ? AND end_time > ?) OR
                  (start_time < ? AND end_time >= ?) OR
                  (start_time >= ? AND end_time <= ?)
              )`,
        args: [date, startTime, startTime, endTime, endTime, startTime, endTime]
    });
    
    return appointments.rows.length === 0;
}

function isDayOpen(date) {
    const dayOfWeek = new Date(date).getDay();
    return CLINIC_SCHEDULE.openDays.includes(dayOfWeek);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('trust proxy', 1);

app.use(session({
    secret: 'dental-clinic-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

// API Routes

// Serve admin page without .html
app.get('/admin', (req, res) => {
    res.sendFile('admin.html', { root: './public' });
});

// Get treatments
app.get('/api/treatments', (req, res) => {
    res.json(TREATMENTS);
});

// Get available slots for a date and treatment
app.get('/api/slots/:date/:treatmentId', async (req, res) => {
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
        const slotsWithStatus = await Promise.all(allSlots.map(async slot => ({
            ...slot,
            booked: !(await isSlotAvailable(date, slot.start, slot.end))
        })));
        res.json({ available: true, slots: slotsWithStatus });
    } else {
        const availableSlots = [];
        for (const slot of allSlots) {
            if (await isSlotAvailable(date, slot.start, slot.end)) {
                availableSlots.push(slot);
            }
        }
        res.json({ available: true, slots: availableSlots });
    }
});

// Patient login/register
app.post('/api/patient/auth', async (req, res) => {
    const { phone, name, age } = req.body;
    
    if (!phone || !name) {
        return res.status(400).json({ error: 'Phone and name are required' });
    }
    
    const cleanPhone = phone.replace(/\D/g, '');
    
    try {
        const existing = await db.execute({
            sql: "SELECT * FROM patients WHERE phone = ?",
            args: [cleanPhone]
        });
        
        let patientId;
        if (existing.rows.length > 0) {
            patientId = existing.rows[0].id;
            await db.execute({
                sql: "UPDATE patients SET name = ?, age = ? WHERE id = ?",
                args: [name, age || null, patientId]
            });
        } else {
            const result = await db.execute({
                sql: "INSERT INTO patients (phone, name, age) VALUES (?, ?, ?)",
                args: [cleanPhone, name, age || null]
            });
            patientId = result.lastInsertRowid;
        }
        
        req.session.patientId = patientId;
        req.session.patientPhone = cleanPhone;
        req.session.patientName = name;
        
        res.json({ success: true, patientId, name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check patient auth
app.get('/api/patient/check', (req, res) => {
    if (req.session.patientId) {
        res.json({ 
            authenticated: true, 
            name: req.session.patientName,
            phone: req.session.patientPhone,
            patientId: req.session.patientId
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Create appointment (patient)
app.post('/api/appointments', async (req, res) => {
    if (!req.session.patientId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    
    const { treatmentId, date, startTime, endTime, notes } = req.body;
    
    try {
        const available = await isSlotAvailable(date, startTime, endTime);
        if (!available) {
            return res.status(400).json({ error: 'Slot not available' });
        }
        
        await db.execute({
            sql: `INSERT INTO appointments (patient_id, treatment_id, date, start_time, end_time, notes)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [req.session.patientId, treatmentId, date, startTime, endTime, notes || '']
        });
        
        io.emit('newAppointment');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get patient's appointments
app.get('/api/patient/appointments', async (req, res) => {
    if (!req.session.patientId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    
    try {
        const result = await db.execute({
            sql: `SELECT a.*, p.name as patient_name, p.phone as patient_phone, p.age as patient_age
                  FROM appointments a
                  JOIN patients p ON a.patient_id = p.id
                  WHERE a.patient_id = ?
                  ORDER BY a.date DESC, a.start_time DESC`,
            args: [req.session.patientId]
        });
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Patient logout
app.post('/api/patient/logout', (req, res) => {
    req.session.patientId = null;
    req.session.patientName = null;
    req.session.patientPhone = null;
    res.json({ success: true });
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await db.execute({
            sql: "SELECT * FROM admins WHERE username = ?",
            args: [username]
        });
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        req.session.adminId = admin.id;
        req.session.adminName = admin.name;
        
        res.json({ success: true, name: admin.name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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

// Get admin stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const todayAppts = await db.execute({
            sql: "SELECT COUNT(*) as count FROM appointments WHERE date = ? AND status != 'cancelled'",
            args: [today]
        });
        
        const pendingAppts = await db.execute(
            "SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'"
        );
        
        const weekCompleted = await db.execute(
            "SELECT COUNT(*) as count FROM appointments WHERE status = 'completed' AND date >= date('now', '-7 days')"
        );
        
        const totalPatients = await db.execute(
            "SELECT COUNT(*) as count FROM patients"
        );
        
        const upcoming = await db.execute({
            sql: `SELECT a.*, p.name as patient_name, p.phone as patient_phone, p.age as patient_age
                  FROM appointments a
                  JOIN patients p ON a.patient_id = p.id
                  WHERE a.date >= ? AND a.status != 'cancelled'
                  ORDER BY a.date, a.start_time
                  LIMIT 10`,
            args: [today]
        });
        
        res.json({
            todayAppointments: todayAppts.rows[0].count,
            pendingAppointments: pendingAppts.rows[0].count,
            thisWeekCompleted: weekCompleted.rows[0].count,
            totalPatients: totalPatients.rows[0].count,
            upcomingAppointments: upcoming.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get appointments (admin)
app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
    const { date, status } = req.query;
    
    try {
        let sql = `SELECT a.*, p.name as patient_name, p.phone as patient_phone, p.age as patient_age
                   FROM appointments a
                   JOIN patients p ON a.patient_id = p.id
                   WHERE 1=1`;
        const args = [];
        
        if (date) {
            sql += ' AND a.date = ?';
            args.push(date);
        }
        if (status) {
            sql += ' AND a.status = ?';
            args.push(status);
        }
        
        sql += ' ORDER BY a.date DESC, a.start_time DESC';
        
        const result = await db.execute({ sql, args });
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create appointment (admin)
app.post('/api/admin/appointments', requireAdmin, async (req, res) => {
    const { patientName, patientPhone, treatmentId, date, startTime, endTime, status, notes } = req.body;
    
    try {
        const cleanPhone = patientPhone.replace(/\D/g, '');
        
        const existing = await db.execute({
            sql: "SELECT * FROM patients WHERE phone = ?",
            args: [cleanPhone]
        });
        
        let patientId;
        if (existing.rows.length > 0) {
            patientId = existing.rows[0].id;
            await db.execute({
                sql: "UPDATE patients SET name = ? WHERE id = ?",
                args: [patientName, patientId]
            });
        } else {
            const result = await db.execute({
                sql: "INSERT INTO patients (phone, name) VALUES (?, ?)",
                args: [cleanPhone, patientName]
            });
            patientId = result.lastInsertRowid;
        }
        
        await db.execute({
            sql: `INSERT INTO appointments (patient_id, treatment_id, date, start_time, end_time, notes, status, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')`,
            args: [patientId, treatmentId, date, startTime, endTime, notes || '', status || 'confirmed']
        });
        
        io.emit('newAppointment');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update appointment status (admin)
app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    try {
        let sql = "UPDATE appointments SET status = ?";
        const args = [status];
        
        if (status === 'confirmed') {
            sql += ", confirmed_at = CURRENT_TIMESTAMP";
        }
        
        sql += " WHERE id = ?";
        args.push(id);
        
        await db.execute({ sql, args });
        
        io.emit('appointmentUpdated');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete appointment (admin)
app.delete('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        await db.execute({
            sql: "DELETE FROM appointments WHERE id = ?",
            args: [id]
        });
        
        io.emit('appointmentUpdated');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get patients (admin)
app.get('/api/admin/patients', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT p.*, 
                   COUNT(a.id) as total_appointments,
                   SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed_appointments
            FROM patients p
            LEFT JOIN appointments a ON p.id = a.patient_id
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Block slot (admin)
app.post('/api/admin/block-slot', requireAdmin, async (req, res) => {
    const { date, startTime, endTime, reason } = req.body;
    
    try {
        await db.execute({
            sql: "INSERT INTO blocked_slots (date, start_time, end_time, reason) VALUES (?, ?, ?, ?)",
            args: [date, startTime, endTime, reason || '']
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get blocked slots (admin)
app.get('/api/admin/blocked-slots', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute(
            "SELECT * FROM blocked_slots ORDER BY date DESC"
        );
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete blocked slot (admin)
app.delete('/api/admin/blocked-slots/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        await db.execute({
            sql: "DELETE FROM blocked_slots WHERE id = ?",
            args: [id]
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Change password (admin)
app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    try {
        const result = await db.execute({
            sql: "SELECT * FROM admins WHERE id = ?",
            args: [req.session.adminId]
        });
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Admin not found' });
        }
        
        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(currentPassword, admin.password);
        
        if (!validPassword) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute({
            sql: "UPDATE admins SET password = ? WHERE id = ?",
            args: [hashedPassword, req.session.adminId]
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Start server
initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log('Using Turso database');
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
