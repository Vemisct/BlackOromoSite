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

// ========== ПІДКЛЮЧЕННЯ ДО SUPABASE (POSTGRESQL) ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Перевірка підключення при старті
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Помилка підключення до Supabase:', err.message);
        process.exit(1);
    } else {
        console.log('✅ Підключено до Supabase (PostgreSQL)');
        release();
    }
});

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

// ========== ІНІЦІАЛІЗАЦІЯ ТАБЛИЦЬ (PostgreSQL) ==========
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
                rating INT,
                text TEXT,
                approved INT DEFAULT 0,
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
            CREATE TABLE IF NOT EXISTS promotions (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                image_url TEXT,
                start_date DATE,
                end_date DATE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                excerpt TEXT,
                image_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const adminCheck = await pool.query(`SELECT id FROM admins WHERE username = 'admin'`);
        if (adminCheck.rows.length === 0) {
            const hash = bcrypt.hashSync('password123', 10);
            await pool.query(`INSERT INTO admins (username, password_hash) VALUES ($1, $2)`, ['admin', hash]);
        }
        console.log('✅ Таблиці створено/перевірено (PostgreSQL)');
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
        await pool.query(`INSERT INTO page_views (page) VALUES ($1)`, [page]);
    } catch(e) {}
    next();
});

// Оновлення активності користувача
app.use(async (req, res, next) => {
    if (req.user && req.user.id) {
        try {
            await pool.query(`INSERT INTO user_sessions (user_id, user_email, last_active) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP`, [req.user.id, req.user.email]);
        } catch(e) {}
    }
    next();
});

// ========== ПУБЛІЧНІ API (ті ж самі, що й були) ==========
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

app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    try {
        await pool.query(`INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3)`, [name, email, message]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// Акції, блог – перевірте, що API працюють (методи такі ж)
app.get('/api/promotions', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM promotions WHERE is_active = true AND (start_date <= CURRENT_DATE OR start_date IS NULL) AND (end_date >= CURRENT_DATE OR end_date IS NULL) ORDER BY created_at DESC`);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/posts', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, title, excerpt, image_url, DATE(created_at) as date FROM posts ORDER BY created_at DESC`);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/posts/:id', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM posts WHERE id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Пост не знайдено' });
        res.json(result.rows[0]);
    } catch(e) { res.status(500).json({ error: 'Помилка сервера' }); }
});

// ========== АДМІН API (скорочено, але всі вони повинні працювати) ==========
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

// Решта адмін API (меню, відгуки, чат, акції, блог) залишаються з тими ж самими назвами колонок.
// Важливо: усюди використовувати $1, $2 замість ? для параметрів.

// ========== СТОРІНКИ (без змін) ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reviews.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contacts.html')));
app.get('/promotions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'promotions.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog.html')));
app.get('/blog-post', (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog-post.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin_login.html')));
app.post('/admin/login', async (req, res) => { /* той самий код, як у SQLite, але з PostgreSQL синтаксисом */ });
app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/user', (req, res) => {
    if (req.user) res.json(req.user);
    else res.status(401).json({ error: 'not logged in' });
});

// WebSocket (без змін)
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('admin_message', async (data) => {
        if (!data.isAdmin) return;
        const { text } = data;
        if (!text || text.trim() === '') return;
        try {
            const result = await pool.query(`INSERT INTO messages (user_id, user_name, text) VALUES ($1, $2, $3) RETURNING id`, ['admin', 'Адмін', text.trim()]);
            io.emit('new_message', { id: result.rows[0].id, user_name: 'Адмін', text: text.trim(), timestamp: new Date() });
        } catch(e) { console.error(e); }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер (Supabase/PostgreSQL) запущено на порту ${PORT}`));