const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieParser = require('cookie-parser');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// ========== ПІДКЛЮЧЕННЯ ДО MYSQL (Aiven) ==========
let pool;
async function createPool() {
    try {
        let caCert = null;
        try {
            caCert = fs.readFileSync('/etc/secrets/ca.pem', 'utf8');
            console.log('✅ Сертифікат SSL завантажено');
        } catch (err) {
            console.warn('⚠️ Файл /etc/secrets/ca.pem не знайдено, SSL вимкнено');
        }
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : false,
            waitForConnections: true,
            connectionLimit: 10
        });
        const conn = await pool.getConnection();
        console.log('✅ Підключено до MySQL (Aiven)');
        conn.release();
    } catch (err) {
        console.error('❌ Помилка підключення до MySQL:', err.message);
        process.exit(1);
    }
}
createPool();

// Сесії
app.use(session({
    secret: process.env.SESSION_SECRET || 'superSecretKey_blackOromo2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || '482596293443-8pihmlhgqnd3br0chpn9rihcbopcnp4l.apps.googleusercontent.com',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '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',
    callbackURL: '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
    const user = {
        id: profile.id,
        name: profile.displayName,
        email: profile.emails[0].value,
        photo: profile.photos[0].value
    };
    return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login-failed' }),
    (req, res) => res.redirect('/')
);
app.get('/login-failed', (req, res) => res.send('<h3>Помилка входу</h3><a href="/">На головну</a>'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// ========== ІНІЦІАЛІЗАЦІЯ ТАБЛИЦЬ ==========
async function initTables() {
    try {
        const conn = await pool.getConnection();
        await conn.query(`
            CREATE TABLE IF NOT EXISTS menu (
                id INT AUTO_INCREMENT PRIMARY KEY,
                category TEXT,
                name TEXT,
                price TEXT,
                description TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id TEXT,
                user_name TEXT,
                user_email TEXT,
                text TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS reviews (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_name TEXT,
                user_email TEXT,
                rating INT,
                text TEXT,
                approved INT DEFAULT 0,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) UNIQUE,
                password_hash VARCHAR(255)
            );
            CREATE TABLE IF NOT EXISTS page_views (
                id INT AUTO_INCREMENT PRIMARY KEY,
                page TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) UNIQUE,
                user_email TEXT,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS contacts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name TEXT,
                email TEXT,
                message TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const [admins] = await conn.query(`SELECT id FROM admins WHERE username = 'admin'`);
        if (admins.length === 0) {
            const hash = bcrypt.hashSync('password123', 10);
            await conn.query(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, ['admin', hash]);
        }
        conn.release();
        console.log('✅ Таблиці створено/перевірено (MySQL)');
    } catch (err) {
        console.error('❌ Помилка створення таблиць:', err.message);
    }
}
initTables();

// Middleware для підрахунку переглядів
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.includes('.') || req.path === '/socket.io/') {
        return next();
    }
    const page = req.path || '/';
    try {
        await pool.query(`INSERT INTO page_views (page) VALUES (?)`, [page]);
    } catch(e) {}
    next();
});

// Оновлення активності користувача
app.use(async (req, res, next) => {
    if (req.user && req.user.id) {
        try {
            await pool.query(`INSERT INTO user_sessions (user_id, user_email, last_active) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE last_active = CURRENT_TIMESTAMP`, [req.user.id, req.user.email]);
        } catch(e) {}
    }
    next();
});

// ========== ПУБЛІЧНІ API ==========
app.get('/api/menu', async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM menu ORDER BY category`);
        res.json(rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/messages', async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT user_name, text, timestamp FROM messages ORDER BY timestamp ASC LIMIT 100`);
        res.json(rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/message', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Необхідно увійти' });
    const { text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Повідомлення порожнє' });
    try {
        const [result] = await pool.query(`INSERT INTO messages (user_id, user_name, user_email, text) VALUES (?, ?, ?, ?)`, [req.user.id, req.user.name, req.user.email, text.trim()]);
        io.emit('new_message', { id: result.insertId, user_name: req.user.name, text: text.trim(), timestamp: new Date() });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT user_name, rating, text, timestamp FROM reviews WHERE approved = 1 ORDER BY timestamp DESC LIMIT 10`);
        res.json(rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/reviews', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Увійдіть, щоб залишити відгук' });
    const { rating, text } = req.body;
    if (!rating || !text) return res.status(400).json({ error: 'Заповніть всі поля' });
    try {
        await pool.query(`INSERT INTO reviews (user_name, user_email, rating, text, approved) VALUES (?, ?, ?, ?, 0)`, [req.user.name, req.user.email, rating, text]);
        res.json({ success: true, message: 'Відгук додано, після перевірки він з\'явиться на сайті' });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    try {
        await pool.query(`INSERT INTO contacts (name, email, message) VALUES (?, ?, ?)`, [name, email, message]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// ========== API ДЛЯ АДМІНА ==========
function isAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).redirect('/admin/login');
}

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const [views] = await pool.query(`SELECT DATE(timestamp) as date, COUNT(*) as count FROM page_views WHERE timestamp >= NOW() - INTERVAL 7 DAY GROUP BY DATE(timestamp) ORDER BY date ASC`);
        const [active] = await pool.query(`SELECT COUNT(DISTINCT user_id) as active_users FROM user_sessions WHERE last_active >= NOW() - INTERVAL 1 DAY`);
        const [totalReviews] = await pool.query(`SELECT COUNT(*) as total_reviews FROM reviews`);
        const [approvedReviews] = await pool.query(`SELECT COUNT(*) as approved_reviews FROM reviews WHERE approved = 1`);
        res.json({ views, active_users: active[0].active_users || 0, total_reviews: totalReviews[0].total_reviews || 0, approved_reviews: approvedReviews[0].approved_reviews || 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reviews', isAdmin, async (req, res) => {
    try { const [rows] = await pool.query(`SELECT * FROM reviews ORDER BY timestamp DESC`); res.json(rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reviews/:id/approve', isAdmin, async (req, res) => {
    try { await pool.query(`UPDATE reviews SET approved = 1 WHERE id = ?`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/reviews/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM reviews WHERE id = ?`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/messages', isAdmin, async (req, res) => {
    try { const [rows] = await pool.query(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200`); res.json(rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/message/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM messages WHERE id = ?`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/messages/clear', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM messages`); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/menu', isAdmin, async (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || !price) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    try {
        const [result] = await pool.query(`INSERT INTO menu (category, name, price, description) VALUES (?, ?, ?, ?)`, [category, name, price, description]);
        res.json({ id: result.insertId });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/menu/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM menu WHERE id = ?`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/menu/:id', isAdmin, async (req, res) => {
    const { category, name, price, description } = req.body;
    try {
        await pool.query(`UPDATE menu SET category=?, name=?, price=?, description=? WHERE id=?`, [category, name, price, description, req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Адмін-панель
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin_login.html')));
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query(`SELECT * FROM admins WHERE username = ?`, [username]);
        if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) return res.redirect('/admin/login?error=1');
        req.session.admin = { id: rows[0].id, username: rows[0].username };
        res.redirect('/admin');
    } catch(e) { res.redirect('/admin/login?error=1'); }
});
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/user', (req, res) => {
    if (req.user) res.json(req.user);
    else res.status(401).json({ error: 'not logged in' });
});

// WebSocket
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('admin_message', async (data) => {
        if (!data.isAdmin) return;
        const { text } = data;
        if (!text || text.trim() === '') return;
        try {
            const [result] = await pool.query(`INSERT INTO messages (user_id, user_name, text) VALUES (?, ?, ?)`, ['admin', 'Адмін', text.trim()]);
            io.emit('new_message', { id: result.insertId, user_name: 'Адмін', text: text.trim(), timestamp: new Date() });
        } catch(e) { console.error(e); }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер (MySQL + статика): http://localhost:${PORT}`));