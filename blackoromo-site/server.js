const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
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

// PostgreSQL pool з перевіркою SSL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Перевірка підключення до БД при старті
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Помилка підключення до PostgreSQL:', err.message);
        process.exit(1); // Завершуємо процес, Render перезапустить
    } else {
        console.log('✅ Підключено до PostgreSQL');
        release();
    }
});

// Сесії (MemoryStore – для початку, потім замінити на connect-pg-simple)
app.use(session({
    secret: process.env.SESSION_SECRET || 'superSecretKey_blackOromo2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth (з перевіркою змінних)
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

// Функція ініціалізації таблиць (безпечна)
async function initTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS menu (
                id SERIAL PRIMARY KEY,
                category TEXT,
                name TEXT,
                price TEXT,
                description TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id TEXT,
                user_name TEXT,
                user_email TEXT,
                text TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                user_name TEXT,
                user_email TEXT,
                rating INTEGER,
                text TEXT,
                approved INTEGER DEFAULT 0,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password_hash TEXT
            );
            CREATE TABLE IF NOT EXISTS page_views (
                id SERIAL PRIMARY KEY,
                page TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_sessions (
                id SERIAL PRIMARY KEY,
                user_id TEXT UNIQUE,
                user_email TEXT,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS contacts (
                id SERIAL PRIMARY KEY,
                name TEXT,
                email TEXT,
                message TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Адмін за замовчуванням
        const adminCheck = await pool.query(`SELECT id FROM admins WHERE username = 'admin'`);
        if (adminCheck.rows.length === 0) {
            const hash = bcrypt.hashSync('password123', 10);
            await pool.query(`INSERT INTO admins (username, password_hash) VALUES ($1, $2)`, ['admin', hash]);
        }
        console.log('✅ Таблиці створено/перевірено');
    } catch (err) {
        console.error('❌ Помилка створення таблиць:', err.message);
    }
}
initTables();

// Middleware для підрахунку переглядів (без помилок)
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.includes('.') || req.path === '/socket.io/') {
        return next();
    }
    const page = req.path || '/';
    try {
        await pool.query(`INSERT INTO page_views (page) VALUES ($1)`, [page]);
    } catch(e) { /* ігноруємо помилки статистики */ }
    next();
});

// Оновлення активності користувача (виправлено)
app.use(async (req, res, next) => {
    if (req.user && req.user.id) {
        try {
            await pool.query(`INSERT INTO user_sessions (user_id, user_email, last_active) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP`, [req.user.id, req.user.email]);
        } catch(e) { /* ігноруємо */ }
    }
    next();
});

// ---------- Публічні API (з обробкою помилок) ----------
app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM menu ORDER BY category`);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/messages', async (req, res) => {
    try {
        const result = await pool.query(`SELECT user_name, text, timestamp FROM messages ORDER BY timestamp ASC LIMIT 100`);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/message', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Необхідно увійти' });
    const { text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Повідомлення порожнє' });
    try {
        const result = await pool.query(`INSERT INTO messages (user_id, user_name, user_email, text) VALUES ($1, $2, $3, $4) RETURNING id`, [req.user.id, req.user.name, req.user.email, text.trim()]);
        io.emit('new_message', { id: result.rows[0].id, user_name: req.user.name, text: text.trim(), timestamp: new Date() });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const result = await pool.query(`SELECT user_name, rating, text, timestamp FROM reviews WHERE approved = 1 ORDER BY timestamp DESC LIMIT 10`);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.post('/api/reviews', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Увійдіть, щоб залишити відгук' });
    const { rating, text } = req.body;
    if (!rating || !text) return res.status(400).json({ error: 'Заповніть всі поля' });
    try {
        await pool.query(`INSERT INTO reviews (user_name, user_email, rating, text, approved) VALUES ($1, $2, $3, $4, 0)`, [req.user.name, req.user.email, rating, text]);
        res.json({ success: true, message: 'Відгук додано, після перевірки він з\'явиться на сайті' });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// Контактна форма
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    try {
        await pool.query(`INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3)`, [name, email, message]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// ---------- API для адміна (скорочено для економії місця, але всі маршрути є) ----------
function isAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).redirect('/admin/login');
}

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const views = await pool.query(`SELECT DATE(timestamp) as date, COUNT(*) as count FROM page_views WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY DATE(timestamp) ORDER BY date ASC`);
        const active = await pool.query(`SELECT COUNT(DISTINCT user_id) as active_users FROM user_sessions WHERE last_active >= NOW() - INTERVAL '1 day'`);
        const totalReviews = await pool.query(`SELECT COUNT(*) as total_reviews FROM reviews`);
        const approvedReviews = await pool.query(`SELECT COUNT(*) as approved_reviews FROM reviews WHERE approved = 1`);
        res.json({ views: views.rows, active_users: active.rows[0].active_users || 0, total_reviews: totalReviews.rows[0].total_reviews || 0, approved_reviews: approvedReviews.rows[0].approved_reviews || 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reviews', isAdmin, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM reviews ORDER BY timestamp DESC`); res.json(r.rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reviews/:id/approve', isAdmin, async (req, res) => {
    try { await pool.query(`UPDATE reviews SET approved = 1 WHERE id = $1`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/reviews/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM reviews WHERE id = $1`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/messages', isAdmin, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200`); res.json(r.rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/message/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM messages WHERE id = $1`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/messages/clear', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM messages`); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/menu', isAdmin, async (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || !price) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    try { const r = await pool.query(`INSERT INTO menu (category, name, price, description) VALUES ($1, $2, $3, $4) RETURNING id`, [category, name, price, description]); res.json({ id: r.rows[0].id }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/menu/:id', isAdmin, async (req, res) => {
    try { await pool.query(`DELETE FROM menu WHERE id = $1`, [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/menu/:id', isAdmin, async (req, res) => {
    const { category, name, price, description } = req.body;
    try { await pool.query(`UPDATE menu SET category=$1, name=$2, price=$3, description=$4 WHERE id=$5`, [category, name, price, description, req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// Адмін-панель
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin_login.html')));
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const r = await pool.query(`SELECT * FROM admins WHERE username = $1`, [username]);
        if (r.rows.length === 0 || !bcrypt.compareSync(password, r.rows[0].password_hash)) return res.redirect('/admin/login?error=1');
        req.session.admin = { id: r.rows[0].id, username: r.rows[0].username };
        res.redirect('/admin');
    } catch(e) { res.redirect('/admin/login?error=1'); }
});
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/user', (req, res) => {
    if (req.user) res.json(req.user);
    else res.status(401).json({ error: 'not logged in' });
});

// Сторінки
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reviews.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contacts.html')));

// WebSocket
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('admin_message', async (data) => {
        if (!data.isAdmin) return;
        const { text } = data;
        if (!text || text.trim() === '') return;
        try {
            const r = await pool.query(`INSERT INTO messages (user_id, user_name, text) VALUES ($1, $2, $3) RETURNING id`, ['admin', 'Адмін', text.trim()]);
            io.emit('new_message', { id: r.rows[0].id, user_name: 'Адмін', text: text.trim(), timestamp: new Date() });
        } catch(e) { console.error(e); }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер (PostgreSQL): http://localhost:${PORT}`));