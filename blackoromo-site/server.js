const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieParser = require('cookie-parser');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

app.use(session({
    secret: 'superSecretKey_blackOromo2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth
passport.use(new GoogleStrategy({
    clientID: '482596293443-8pihmlhgqnd3br0chpn9rihcbopcnp4l.apps.googleusercontent.com',
    clientSecret: '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',
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

// ---------- База даних (better-sqlite3) ----------
const db = new Database('./blackoromo.db');
db.pragma('journal_mode = WAL');

// Створення таблиць
db.exec(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT, name TEXT, price TEXT, description TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, user_name TEXT, user_email TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT, user_email TEXT, rating INTEGER, text TEXT, approved INTEGER DEFAULT 0, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE, password_hash TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, user_email TEXT, last_active DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Адмін за замовчуванням
const adminRow = db.prepare(`SELECT id FROM admins WHERE username = 'admin'`).get();
if (!adminRow) {
    const hash = bcrypt.hashSync('password123', 10);
    db.prepare(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`).run('admin', hash);
}

// Middleware для підрахунку переглядів
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.includes('.') || req.path === '/socket.io/') {
        return next();
    }
    const page = req.path || '/';
    db.prepare(`INSERT INTO page_views (page) VALUES (?)`).run(page);
    next();
});

// Оновлення активності користувача
app.use((req, res, next) => {
    if (req.user && req.user.id) {
        db.prepare(`INSERT OR REPLACE INTO user_sessions (user_id, user_email, last_active) VALUES (?, ?, CURRENT_TIMESTAMP)`).run(req.user.id, req.user.email);
    }
    next();
});

// ---------- Публічні API ----------
app.get('/api/menu', (req, res) => {
    const rows = db.prepare(`SELECT * FROM menu ORDER BY category`).all();
    res.json(rows);
});

app.get('/api/messages', (req, res) => {
    const rows = db.prepare(`SELECT user_name, text, timestamp FROM messages ORDER BY timestamp ASC LIMIT 100`).all();
    res.json(rows);
});

app.post('/api/message', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Необхідно увійти' });
    const { text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Повідомлення порожнє' });
    const stmt = db.prepare(`INSERT INTO messages (user_id, user_name, user_email, text) VALUES (?, ?, ?, ?)`);
    const info = stmt.run(req.user.id, req.user.name, req.user.email, text.trim());
    io.emit('new_message', { id: info.lastInsertRowid, user_name: req.user.name, text: text.trim(), timestamp: new Date() });
    res.json({ success: true });
});

app.get('/api/reviews', (req, res) => {
    const rows = db.prepare(`SELECT user_name, rating, text, timestamp FROM reviews WHERE approved = 1 ORDER BY timestamp DESC LIMIT 10`).all();
    res.json(rows);
});

app.post('/api/reviews', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Увійдіть, щоб залишити відгук' });
    const { rating, text } = req.body;
    if (!rating || !text) return res.status(400).json({ error: 'Заповніть всі поля' });
    db.prepare(`INSERT INTO reviews (user_name, user_email, rating, text, approved) VALUES (?, ?, ?, ?, 0)`).run(req.user.name, req.user.email, rating, text);
    res.json({ success: true, message: 'Відгук додано, після перевірки він з\'явиться на сайті' });
});

// ---------- API для адміна ----------
function isAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).redirect('/admin/login');
}

app.get('/api/admin/stats', isAdmin, (req, res) => {
    const viewsData = db.prepare(`SELECT DATE(timestamp) as date, COUNT(*) as count FROM page_views WHERE timestamp >= datetime('now', '-7 days') GROUP BY DATE(timestamp) ORDER BY date ASC`).all();
    const activeUsers = db.prepare(`SELECT COUNT(DISTINCT user_id) as active_users FROM user_sessions WHERE last_active >= datetime('now', '-1 day')`).get();
    const totalReviews = db.prepare(`SELECT COUNT(*) as total_reviews FROM reviews`).get();
    const approvedReviews = db.prepare(`SELECT COUNT(*) as approved_reviews FROM reviews WHERE approved = 1`).get();
    res.json({
        views: viewsData,
        active_users: activeUsers.active_users || 0,
        total_reviews: totalReviews.total_reviews || 0,
        approved_reviews: approvedReviews.approved_reviews || 0
    });
});

app.get('/api/admin/reviews', isAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM reviews ORDER BY timestamp DESC`).all();
    res.json(rows);
});
app.post('/api/admin/reviews/:id/approve', isAdmin, (req, res) => {
    db.prepare(`UPDATE reviews SET approved = 1 WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});
app.delete('/api/admin/reviews/:id', isAdmin, (req, res) => {
    db.prepare(`DELETE FROM reviews WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});

app.get('/api/admin/messages', isAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200`).all();
    res.json(rows);
});
app.delete('/api/admin/message/:id', isAdmin, (req, res) => {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});
app.delete('/api/admin/messages/clear', isAdmin, (req, res) => {
    db.prepare(`DELETE FROM messages`).run();
    res.json({ success: true });
});

app.post('/api/admin/menu', isAdmin, (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || !price) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    const info = db.prepare(`INSERT INTO menu (category, name, price, description) VALUES (?, ?, ?, ?)`).run(category, name, price, description);
    res.json({ id: info.lastInsertRowid });
});
app.delete('/api/admin/menu/:id', isAdmin, (req, res) => {
    db.prepare(`DELETE FROM menu WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});
app.put('/api/admin/menu/:id', isAdmin, (req, res) => {
    const { category, name, price, description } = req.body;
    db.prepare(`UPDATE menu SET category=?, name=?, price=?, description=? WHERE id=?`).run(category, name, price, description, req.params.id);
    res.json({ success: true });
});

// ---------- Адмін-панель (сторінки) ----------
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const row = db.prepare(`SELECT * FROM admins WHERE username = ?`).get(username);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.redirect('/admin/login?error=1');
    }
    req.session.admin = { id: row.id, username: row.username };
    res.redirect('/admin');
});
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});
app.get('/admin', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/user', (req, res) => {
    if (req.user) res.json(req.user);
    else res.status(401).json({ error: 'not logged in' });
});

// Сторінки
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reviews.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));

// WebSocket
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('admin_message', (data) => {
        if (!data.isAdmin) return;
        const { text } = data;
        if (!text || text.trim() === '') return;
        const stmt = db.prepare(`INSERT INTO messages (user_id, user_name, text) VALUES (?, ?, ?)`);
        const info = stmt.run('admin', 'Адмін', text.trim());
        io.emit('new_message', { id: info.lastInsertRowid, user_name: 'Адмін', text: text.trim(), timestamp: new Date() });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер: http://localhost:${PORT}`));