const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
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

// Сесії
app.use(session({
    secret: 'superSecretKey_blackOromo2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

// ---------- Google OAuth ----------
passport.use(new GoogleStrategy({
    clientID: '482596293443-8pihmlhgqnd3br0chpn9rihcbopcnp4l.apps.googleusercontent.com',
    clientSecret: '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',
    callbackURL: 'http://localhost:3000/auth/google/callback'
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

// ---------- База даних ----------
const db = new sqlite3.Database('./blackoromo.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS menu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT, name TEXT, price TEXT, description TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT, user_name TEXT, user_email TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_name TEXT, user_email TEXT, rating INTEGER, text TEXT, approved INTEGER DEFAULT 0, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE, password_hash TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT, user_email TEXT, last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Виправлення структури таблиць (додавання відсутніх колонок)
db.get("PRAGMA table_info(messages)", (err, rows) => {
    if (!err && rows) {
        let hasUserId = false, hasUserName = false, hasUserEmail = false;
        for (let row in rows) {
            if (row.name === 'user_id') hasUserId = true;
            if (row.name === 'user_name') hasUserName = true;
            if (row.name === 'user_email') hasUserEmail = true;
        }
        if (!hasUserId) {
            db.run("ALTER TABLE messages ADD COLUMN user_id TEXT", (err) => {
                if (err) console.error("Помилка додавання user_id:", err.message);
                else console.log("✅ Колонку user_id додано до messages");
            });
        }
        if (!hasUserName) {
            db.run("ALTER TABLE messages ADD COLUMN user_name TEXT", (err) => {
                if (err) console.error("Помилка додавання user_name:", err.message);
                else console.log("✅ Колонку user_name додано до messages");
            });
        }
        if (!hasUserEmail) {
            db.run("ALTER TABLE messages ADD COLUMN user_email TEXT", (err) => {
                if (err) console.error("Помилка додавання user_email:", err.message);
                else console.log("✅ Колонку user_email додано до messages");
            });
        }
    }
});

// Middleware для підрахунку переглядів
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.includes('.') || req.path === '/socket.io/') {
        return next();
    }
    const page = req.path || '/';
    db.run(`INSERT INTO page_views (page) VALUES (?)`, [page], (err) => { if (err) console.error(err); });
    next();
});

// API для статистики
app.get('/api/admin/stats', isAdmin, (req, res) => {
    db.all(`SELECT DATE(timestamp) as date, COUNT(*) as count FROM page_views WHERE timestamp >= datetime('now', '-7 days') GROUP BY DATE(timestamp) ORDER BY date ASC`, (err, viewsData) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT COUNT(DISTINCT user_id) as active_users FROM user_sessions WHERE last_active >= datetime('now', '-1 day')`, (err, activeUsers) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get(`SELECT COUNT(*) as total_reviews FROM reviews`, (err, reviewsCount) => {
                if (err) return res.status(500).json({ error: err.message });
                db.get(`SELECT COUNT(*) as approved_reviews FROM reviews WHERE approved = 1`, (err, approvedReviews) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        views: viewsData,
                        active_users: activeUsers.active_users || 0,
                        total_reviews: reviewsCount.total_reviews || 0,
                        approved_reviews: approvedReviews.approved_reviews || 0
                    });
                });
            });
        });
    });
});

// Оновлення активності користувача
app.use((req, res, next) => {
    if (req.user && req.user.id) {
        db.run(`INSERT OR REPLACE INTO user_sessions (user_id, user_email, last_active) VALUES (?, ?, CURRENT_TIMESTAMP)`, [req.user.id, req.user.email]);
    }
    next();
});

// Адмін за замовчуванням
bcrypt.hash('password123', 10, (err, hash) => {
    if (!err) {
        db.get(`SELECT id FROM admins WHERE username = 'admin'`, (err, row) => {
            if (!row) db.run(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, ['admin', hash]);
        });
    }
});

// ---------- Публічні API ----------
app.get('/api/menu', (req, res) => {
    db.all(`SELECT * FROM menu ORDER BY category`, (err, rows) => res.json(rows || []));
});

app.get('/api/messages', (req, res) => {
    db.all(`SELECT user_name, text, timestamp FROM messages ORDER BY timestamp ASC LIMIT 100`, (err, rows) => res.json(rows || []));
});

app.post('/api/message', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Необхідно увійти' });
    const { text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Повідомлення порожнє' });
    db.run(`INSERT INTO messages (user_id, user_name, user_email, text) VALUES (?, ?, ?, ?)`,
        [req.user.id, req.user.name, req.user.email, text.trim()], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('new_message', { id: this.lastID, user_name: req.user.name, text: text.trim(), timestamp: new Date() });
            res.json({ success: true });
        });
});

app.get('/api/reviews', (req, res) => {
    db.all(`SELECT user_name, rating, text, timestamp FROM reviews WHERE approved = 1 ORDER BY timestamp DESC LIMIT 10`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/reviews', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Увійдіть, щоб залишити відгук' });
    const { rating, text } = req.body;
    if (!rating || !text) return res.status(400).json({ error: 'Заповніть всі поля' });
    db.run(`INSERT INTO reviews (user_name, user_email, rating, text, approved) VALUES (?, ?, ?, ?, 0)`,
        [req.user.name, req.user.email, rating, text], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Відгук додано, після перевірки він з\'явиться на сайті' });
        });
});

// ---------- API для адміна (захищені) ----------
function isAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).redirect('/admin/login');
}

// Відгуки
app.get('/api/admin/reviews', isAdmin, (req, res) => {
    db.all(`SELECT * FROM reviews ORDER BY timestamp DESC`, (err, rows) => res.json(rows || []));
});
app.post('/api/admin/reviews/:id/approve', isAdmin, (req, res) => {
    db.run(`UPDATE reviews SET approved = 1 WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
app.delete('/api/admin/reviews/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM reviews WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Повідомлення чату
app.get('/api/admin/messages', isAdmin, (req, res) => {
    db.all(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200`, (err, rows) => res.json(rows || []));
});
app.delete('/api/admin/message/:id', isAdmin, (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM messages WHERE id = ?`, id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
app.delete('/api/admin/messages/clear', isAdmin, (req, res) => {
    db.run(`DELETE FROM messages`, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Керування меню
app.post('/api/admin/menu', isAdmin, (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || !price) {
        return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    }
    db.run(`INSERT INTO menu (category, name, price, description) VALUES (?, ?, ?, ?)`,
        [category, name, price, description], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});
app.delete('/api/admin/menu/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM menu WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
app.put('/api/admin/menu/:id', isAdmin, (req, res) => {
    const { category, name, price, description } = req.body;
    db.run(`UPDATE menu SET category=?, name=?, price=?, description=? WHERE id=?`,
        [category, name, price, description, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// ---------- Адмін-панель (сторінки) ----------
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM admins WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return res.redirect('/admin/login?error=1');
        bcrypt.compare(password, row.password_hash, (err, result) => {
            if (result) {
                req.session.admin = { id: row.id, username: row.username };
                res.redirect('/admin');
            } else res.redirect('/admin/login?error=1');
        });
    });
});
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});
app.get('/admin', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API для поточного користувача
app.get('/api/user', (req, res) => {
    if (req.user) res.json(req.user);
    else res.status(401).json({ error: 'not logged in' });
});

// Сторінки
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reviews.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));

// WebSocket
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('admin_message', (data) => {
        if (!data.isAdmin) return;
        const { text } = data;
        if (!text || text.trim() === '') return;
        db.run(`INSERT INTO messages (user_id, user_name, text) VALUES (?, ?, ?)`, 
            ['admin', 'Адмін', text.trim()], function(err) {
                if (!err) {
                    io.emit('new_message', { id: this.lastID, user_name: 'Адмін', text: text.trim(), timestamp: new Date() });
                }
            });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер: http://localhost:${PORT}`));