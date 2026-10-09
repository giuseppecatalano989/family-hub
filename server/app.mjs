import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { installWaste } from './waste.mjs';
import { installNotifications } from './notifications.mjs';
import { installPlanning } from './planning.mjs';
import { installDeadlines } from './deadlines.mjs';
import { installWorkflows } from './workflows.mjs';
import { createBackupManager, streamFamilyBackup } from './backups.mjs';
import { BASE_SCHEMA } from './schema.mjs';
import { RECOVERY_SCHEMA, createRecovery } from './recovery.mjs';
import { installGoalSavings } from './goal-savings.mjs';
import { resetEmailSender, DEFAULT_APP_URL } from './reset-email.mjs';
import { installChunkUploads } from './uploads.mjs';
import { detachMember } from './member-removal.mjs';
import { installBank, enableBankingProvider, presentTransactions } from './bank.mjs';
import { installAdvisor, anthropicAdvisor } from './advisor.mjs';
const MAX_CENTS = 1000000000;
const COLORS = ['mint', 'amber', 'blue', 'rose', 'neutral'];
const SESSION_MS = 14 * 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function text(value, label, max = 200, optional = false) {
    if (optional && (value === undefined || value === null || value === ''))
        return '';
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
        fail(`${label}: inserisci un valore valido (massimo ${max} caratteri).`);
    return value.trim();
}
function cents(value, allowZero = false) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_CENTS)
        fail('Importo non valido.');
    return value;
}
function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        fail('Data non valida.');
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '2199-12-31')
        fail('Data non valida.');
    return value;
}
function boolean(value) {
    if (typeof value !== 'boolean')
        fail('Valore non valido.');
    return value ? 1 : 0;
}
// Overview cards in their default order: four figures, then five panels.
const DASHBOARD_CARDS = ['income', 'expense', 'balance', 'savings', 'spending', 'advice', 'home', 'goals', 'recent', 'comparison'];
function dashboardPreferences(row) {
    let saved = {};
    try { saved = row ? JSON.parse(row.cards) : {}; } catch { saved = {}; }
    const known = list => (Array.isArray(list) ? list : []).filter(id => DASHBOARD_CARDS.includes(id));
    const order = known(saved.order);
    return { quickActions: !!row?.quick_actions, dashboard: { order: [...order, ...DASHBOARD_CARDS.filter(id => !order.includes(id))], hidden: known(saved.hidden) } };
}
function passwordHash(password) {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
    const [salt, key] = stored.split(':');
    const candidate = scryptSync(password, salt, 64);
    return timingSafeEqual(candidate, Buffer.from(key, 'hex'));
}
export function createApp({ dataDir, production = false, trustProxy = false, distDir, automaticBackups = false, backupDir, database, cloudBackups, cronSecret, resetMailer = resetEmailSender(), appUrl = DEFAULT_APP_URL, scheduleResetDelivery, bankProvider = enableBankingProvider(), bankRedirectUrl = process.env.ENABLE_BANKING_REDIRECT_URL || `${appUrl}/api/bank/callback`, clock, pushSender, scheduleBackground, advisorModel = anthropicAdvisor() } = {}) {
    if (!dataDir)
        throw new Error('dataDir is required');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const uploadDir = path.join(dataDir, 'uploads');
    mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    const db = database || new DatabaseSync(path.join(dataDir, 'casa.sqlite'));
    if (!database)
        db.exec(BASE_SCHEMA + RECOVERY_SCHEMA);
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    const atomic = database ? callback => database.atomic(callback) : async (callback) => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = await callback();
            db.exec('COMMIT');
            return result;
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    };
    const app = express();
    app.disable('x-powered-by');
    if (trustProxy)
        app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'same-origin');
        res.set('X-Frame-Options', 'DENY');
        if (production)
            res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        next();
    });
    app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    // One SQLite connection cannot interleave asynchronous transactions. Cloud
    // instances also serialize their own requests; PostgreSQL locks coordinate instances.
    let queue = Promise.resolve();
    const reserve = () => { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); return { previous, release }; };
    // Background jobs use the same queue as requests.
    const exclusive = async callback => { const { previous, release } = reserve(); await previous; try { return await callback(); } finally { release(); } };
    app.use('/api', async (req, res, next) => {
        const { previous, release } = reserve();
        await previous;
        if (res.destroyed) {
            release();
            return;
        }
        res.once('finish', release);
        res.once('close', release);
        next();
    });
    app.use(express.json({ limit: '100kb' }));
    const cronAllowed = req => {
        const expected = cronSecret && Buffer.from(`Bearer ${cronSecret}`);
        const actual = Buffer.from(req.get('authorization') || '');
        return !!expected && expected.length === actual.length && timingSafeEqual(expected, actual);
    };
    // The evening round of notifications: waste collection, deadlines, consents.
    if (cronSecret)
        app.get('/api/internal/notifications', async (req, res) => {
            if (!cronAllowed(req))
                return res.status(401).json({ error: 'Accesso non consentito.' });
            await notifications.evening({ queued: true });
            // Budget reports call Claude after the response, outside the request queue.
            res.once('finish', () => { void advisor.runLater(); });
            res.json({ status: 'ok' });
        });
    if (cloudBackups)
        app.get('/api/internal/backup', async (req, res) => {
            if (!cronAllowed(req))
                return res.status(401).json({ error: 'Accesso non consentito.' });
            await planning.synchronizeAll();
            try { await bank.synchronizeAll(); await notifications.afterBankSync({ queued: true }); } catch (error) { console.error('Aggiornamento bancario non riuscito:', error.message); }
            await cloudBackups.runIfDue();
            const status = await cloudBackups.status();
            res.status(status.error ? 503 : 200).json({ status: status.error ? 'error' : 'ok' });
        });
    app.use('/api', (req, res, next) => {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const origin = req.get('origin');
            if (origin) {
                try {
                    if (new URL(origin).host !== req.get('host'))
                        fail('Origine della richiesta non valida.', 403);
                }
                catch {
                    return res.status(403).json({ error: 'Origine della richiesta non valida.' });
                }
            }
            if (req.get('x-requested-with') !== 'Casa')
                return res.status(403).json({ error: 'Richiesta non valida.' });
        }
        next();
    });
    async function getSession(req) {
        const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('casa_session='))?.slice(13);
        if (!token || !/^[a-f0-9]{64}$/.test(token))
            return null;
        return await one(`SELECT s.token_hash, s.csrf, u.id, u.name, u.email, u.role, u.household_id FROM sessions s
      JOIN users u ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires > ?`, hash(token), Date.now());
    }
    function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, householdId: user.household_id }; }
    async function issueSession(req, res, user) {
        const token = randomBytes(32).toString('hex');
        const csrf = randomBytes(24).toString('hex');
        await run('DELETE FROM sessions WHERE expires <= ?', Date.now());
        await run('INSERT INTO sessions VALUES (?, ?, ?, ?)', hash(token), user.id, csrf, Date.now() + SESSION_MS);
        res.cookie('casa_session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
        return { user: publicUser(user), csrf };
    }
    app.get('/api/health', async (req, res) => { await one('SELECT 1'); res.json({ status: 'ok' }); });
    app.get('/api/session', async (req, res) => {
        const session = await getSession(req);
        res.json(session ? { user: publicUser(session), csrf: session.csrf } : { user: null });
    });
    const attempts = new Map();
    app.use(['/api/auth', '/api/account'], async (req, res, next) => {
        if (database) {
            if (!await database.checkAuthAttempt(req.ip)) return res.status(429).json({ error: 'Troppi tentativi. Riprova tra 15 minuti.' });
            return next();
        }
        const key = req.ip;
        const stamp = Date.now();
        for (const [address, entry] of attempts)
            if (stamp - entry.start > 15 * 60000)
                attempts.delete(address);
        const entry = attempts.get(key) || { count: 0, start: stamp };
        entry.count++;
        attempts.set(key, entry);
        if (entry.count > 30)
            return res.status(429).json({ error: 'Troppi tentativi. Riprova tra 15 minuti.' });
        next();
    });
    const recovery = createRecovery({ run, one, atomic, fail, text, passwordHash, mailer: resetMailer, appUrl, scheduleDelivery: scheduleResetDelivery });
    app.get('/api/auth/recovery-status', (req, res) => res.json({ available: !!resetMailer }));
    app.post('/api/auth/forgot-password', recovery.forgot);
    app.post('/api/auth/reset-password', recovery.reset);
    const bank = installBank(app, { db, one, all, run, atomic, fail, getSession }, { provider: bankProvider, redirectUrl: bankRedirectUrl, ...(clock ? { clock } : {}) });
    app.post('/api/auth/register', async (req, res) => {
        const name = text(req.body.name, 'Nome', 80);
        const email = text(req.body.email, 'Email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            fail('Email non valida.');
        const password = text(req.body.password, 'Password', 128);
        if (password.length < 10)
            fail('Usa una password di almeno 10 caratteri.');
        if (await one('SELECT id FROM users WHERE email = ?', email))
            fail('Questa email è già registrata.', 409);
        let household;
        let role = 'admin';
        if (req.body.inviteCode) {
            const code = text(req.body.inviteCode, 'Codice invito', 30).replace(/[\s-]/g, '').toUpperCase();
            household = await one('SELECT * FROM households WHERE invite_hash = ? AND invite_expires > ?', hash(code), Date.now());
            if (!household)
                fail('Codice invito non valido o scaduto.');
            role = 'member';
        }
        else {
            household = { id: randomUUID(), name: text(req.body.householdName, 'Nome famiglia', 80) };
        }
        const user = { id: randomUUID(), name, email, role, household_id: household.id };
        const encodedPassword = passwordHash(password);
        await atomic(async () => {
            if (role === 'admin') {
                await run('INSERT INTO households (id, name) VALUES (?, ?)', household.id, household.name);
                const defaults = [['Casa e utenze', '#176854', 3500], ['Alimentari', '#e3a95c', 1500], ['Trasporti', '#8099b0', 1000], ['Salute', '#be879b', 500], ['Tempo libero', '#9b94c3', 1000], ['Risparmio', '#8da985', 2500]];
                for (const [i, [label, color, percentage]] of defaults.entries())
                    await run('INSERT INTO categories VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), household.id, label, color, percentage, i);
            }
            await run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', user.id, household.id, name, email, encodedPassword, role);
        });
        res.status(201).json(await issueSession(req, res, user));
    });
    app.post('/api/auth/login', async (req, res) => {
        const email = text(req.body.email, 'Email', 254).toLowerCase();
        const password = text(req.body.password, 'Password', 128);
        const user = await one('SELECT * FROM users WHERE email = ?', email);
        // Perform the password derivation for absent accounts as well.
        const dummy = '0'.repeat(32) + ':' + '0'.repeat(128);
        if (!passwordMatches(password, user?.password_hash || dummy) || !user)
            fail('Email o password non corretti.', 401);
        res.json(await issueSession(req, res, user));
    });
    app.use('/api', async (req, res, next) => {
        const session = await getSession(req);
        if (!session)
            return res.status(401).json({ error: 'Accedi per continuare.' });
        req.user = session;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-csrf-token') !== session.csrf)
            return res.status(403).json({ error: 'Sessione non valida. Aggiorna la pagina.' });
        next();
    });
    // Registered after sign-in so that changes know who made them.
    const notifications = installNotifications(app, { db, one, all, run, atomic, fail, exclusive }, { appUrl, schedule: scheduleBackground, ...(pushSender ? { sender: pushSender } : {}), ...(clock ? { clock } : {}) });
    notifications.routes();
    app.post('/api/logout', async (req, res) => {
        await run('DELETE FROM sessions WHERE token_hash = ?', req.user.token_hash);
        res.clearCookie('casa_session', { path: '/' });
        res.json({ ok: true });
    });
    app.put('/api/account', async (req, res) => {
        const name = text(req.body.name, 'Nome', 80);
        const email = text(req.body.email, 'Email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email non valida.');
        let updated;
        await atomic(async () => {
            const user = await one('SELECT * FROM users WHERE id = ?', req.user.id);
            if (email !== user.email) {
                if (!passwordMatches(text(req.body.currentPassword, 'Password attuale', 128), user.password_hash)) fail('Password attuale non corretta.', 400);
                if (await one('SELECT id FROM users WHERE email = ? AND id <> ?', email, user.id)) fail('Questa email è già registrata.', 409);
                await run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, req.user.token_hash);
                await recovery.invalidate(user.id);
            }
            await run('UPDATE users SET name = ?, email = ? WHERE id = ?', name, email, user.id);
            updated = publicUser({ ...user, name, email });
        });
        res.json({ user: updated });
    });
    app.put('/api/account/password', async (req, res) => {
        const current = text(req.body.currentPassword, 'Password attuale', 128);
        const password = text(req.body.newPassword, 'Nuova password', 128);
        if (password.length < 10) fail('Usa una password di almeno 10 caratteri.');
        const encoded = passwordHash(password);
        await atomic(async () => {
            const user = await one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
            if (!passwordMatches(current, user.password_hash)) fail('Password attuale non corretta.', 400);
            await run('UPDATE users SET password_hash = ? WHERE id = ?', encoded, req.user.id);
            await recovery.invalidate(req.user.id);
            await run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', req.user.id, req.user.token_hash);
        });
        res.json({ ok: true });
    });
    // Personal display choices; each account changes only its own.
    app.put('/api/preferences', async (req, res) => {
        await run('INSERT INTO user_preferences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET show_bank_balance = excluded.show_bank_balance', req.user.id, boolean(req.body.showBankBalance));
        res.json({ ok: true });
    });
    // The overview's cards, their order and the quick buttons, for this account only.
    app.put('/api/preferences/dashboard', async (req, res) => {
        const cards = list => {
            if (!Array.isArray(list) || list.some(id => !DASHBOARD_CARDS.includes(id)) || new Set(list).size !== list.length) fail('Scelta della Panoramica non valida.');
            return list;
        };
        const order = cards(req.body.order); const hidden = cards(req.body.hidden);
        await run(`INSERT INTO dashboard_preferences VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET quick_actions = excluded.quick_actions, cards = excluded.cards`,
            req.user.id, boolean(req.body.quickActions), JSON.stringify({ order, hidden }));
        res.json({ ok: true });
    });
    app.put('/api/household', async (req, res) => {
        if (req.user.role !== 'admin') fail('Solo l’amministratore può modificare il nome della casa.', 403);
        const name = text(req.body.name, 'Nome della casa', 80);
        await run('UPDATE households SET name = ? WHERE id = ?', name, req.user.household_id);
        res.json({ ok: true });
    });
    app.post('/api/invitation', async (req, res) => {
        if (req.user.role !== 'admin')
            fail('Solo chi ha creato lo spazio può generare inviti.', 403);
        const code = randomBytes(6).toString('hex').toUpperCase();
        const expires = Date.now() + 7 * 86400000;
        await run('UPDATE households SET invite_hash = ?, invite_expires = ? WHERE id = ?', hash(code), expires, req.user.household_id);
        res.json({ code, expiresAt: new Date(expires).toISOString() });
    });
    // The administrator removes a member after confirming with their own password:
    // shared records move to the administrator, the member's accesses are revoked.
    app.delete('/api/members/:id', async (req, res) => {
        if (req.user.role !== 'admin')
            fail('Solo chi ha creato lo spazio può rimuovere i membri.', 403);
        const current = text(req.body?.currentPassword, 'Password attuale', 128);
        const secrets = await atomic(async () => {
            const admin = await one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
            if (!passwordMatches(current, admin.password_hash))
                fail('Password attuale non corretta.', 400);
            const member = await one("SELECT id FROM users WHERE id = ? AND household_id = ? AND role = 'member'", req.params.id, req.user.household_id);
            if (!member)
                fail('Membro non trovato.', 404);
            const connections = await all('SELECT session_secret FROM bank_connections WHERE user_id = ? AND session_secret IS NOT NULL', member.id);
            await detachMember(run, member.id, req.user.id);
            await run("DELETE FROM users WHERE id = ? AND role = 'member'", member.id);
            return connections.map(c => c.session_secret);
        });
        await bank.endSessions(secrets);
        res.json({ ok: true });
    });
    const workflows = installWorkflows(app, { db, one, all, run, atomic, owned, fail, text, cents, date, now });
    const deadlines = installDeadlines(app, { db, one, all, run, atomic, owned, fail, text, cents, date, now });
    const planning = installPlanning(app, { db, one, all, run, atomic, owned, fail, text, cents, now, ...(clock ? { clock } : {}) });
    const waste = installWaste(app, { db, all, run, owned, fail, text });
    const advisor = installAdvisor(app, { db, one, all, run, atomic, fail, exclusive, splitFor: planning.splitFor, budgetBase, notifications }, { model: advisorModel, schedule: scheduleBackground, ...(clock ? { clock } : {}) });
    advisor.routes();
    const savings = installGoalSavings(app, { one, all, run, atomic, owned, fail, cents, now, reconcile: bank.reconcileSavings });
    bank.routes();
    const backups = cloudBackups || createBackupManager({ db, dataDir, backupDir, enabled: automaticBackups });
    app.get('/api/backups/export', async (req, res, next) => {
        if (req.user.role !== 'admin')
            return res.status(403).json({ error: 'Solo chi ha creato lo spazio può esportare il backup della famiglia.' });
        if (cloudBackups)
            await cloudBackups.exportFamily(req.user.household_id, res, next);
        else
            streamFamilyBackup(db, dataDir, req.user.household_id, res, next);
    });
    // Monthly totals of the six months up to the selected one, for the comparison
    // in Entrate, Uscite and the overview. Aggregates only: private records are never itemised.
    async function monthlyHistory(hid, month) {
        const months = Array.from({ length: 6 }, (_, index) => {
            const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 6 + index, 1));
            return date.toISOString().slice(0, 7);
        });
        const rows = await all(`SELECT substr(t.date, 1, 7) AS month, t.kind, t.category_id, CASE WHEN o.rule_id IS NULL THEN 0 ELSE 1 END AS recurring, SUM(t.amount) AS amount
            FROM transactions t LEFT JOIN recurring_occurrences o ON o.transaction_id = t.id
            WHERE t.household_id = ? AND t.date >= ? AND t.date < ? GROUP BY 1, 2, 3, 4`, hid, `${months[0]}-01`, `${month}-32`);
        return months.map(m => {
            const entry = { month: m, income: 0, budgetIncome: 0, expense: 0, categories: {} };
            for (const row of rows.filter(r => r.month === m)) {
                const amount = Number(row.amount);
                if (row.kind === 'income') { entry.income += amount; if (Number(row.recurring)) entry.budgetIncome += amount; continue; }
                entry.expense += amount;
                const key = row.category_id || '';
                entry.categories[key] = (entry.categories[key] || 0) + amount;
            }
            return entry;
        });
    }
    // Months before the first recurring income borrow that month's base, so
    // the split shows real amounts for history imported from the bank.
    async function budgetFallback(hid, month) {
        const first = await one(`SELECT substr(t.date, 1, 7) AS month, SUM(t.amount) AS amount FROM transactions t JOIN recurring_occurrences o ON o.transaction_id = t.id
            WHERE t.household_id = ? AND t.kind = 'income' GROUP BY 1 ORDER BY 1 LIMIT 1`, hid);
        return first && month < first.month ? { month: first.month, amount: Number(first.amount) } : null;
    }
    // Recurring incomes of the month, or the first month's when there are none yet.
    async function budgetBase(hid, month) {
        const own = Number((await one(`SELECT COALESCE(SUM(t.amount), 0) AS amount FROM transactions t JOIN recurring_occurrences o ON o.transaction_id = t.id
            WHERE t.household_id = ? AND t.kind = 'income' AND substr(t.date, 1, 7) = ?`, hid, month)).amount);
        return own || (await budgetFallback(hid, month))?.amount || 0;
    }
    app.get('/api/state', async (req, res) => {
        const month = req.query.month;
        if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > '2199-12')
            fail('Mese non valido.');
        const hid = req.user.household_id;
        await planning.materialize(hid, month);
        const notes = await all('SELECT n.*, u.name AS author FROM notes n JOIN users u ON u.id = n.author_id WHERE n.household_id = ? ORDER BY pinned DESC, updated_at DESC', hid);
        const attachments = await all('SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.household_id = ?', hid);
        res.json({
            deadlines: await deadlines.state(req.user, month),
            waste: await waste.state(hid),
            ...await planning.state(req.user, month),
            ...await workflows.state(req.user, month, req.query.week),
            backups: req.user.role === 'admin' ? await backups.status() : null,
            bank: await bank.state(req.user),
            notifications: await notifications.state(req.user),
            preferences: { showBankBalance: !!(await one('SELECT show_bank_balance FROM user_preferences WHERE user_id = ?', req.user.id))?.show_bank_balance, ...dashboardPreferences(await one('SELECT quick_actions, cards FROM dashboard_preferences WHERE user_id = ?', req.user.id)) },
            household: await one('SELECT id, name FROM households WHERE id = ?', hid),
            members: await all('SELECT id, name, role FROM users WHERE household_id = ? ORDER BY role, name', hid),
            categories: await all('SELECT * FROM categories WHERE household_id = ? ORDER BY position', hid),
            transactions: presentTransactions(await all(`SELECT t.*, u.name AS author, o.rule_id AS recurring_id, p.owner_id AS private_owner, (SELECT a.name FROM bank_movements m JOIN bank_accounts a ON a.id = m.account_id WHERE m.transaction_id = t.id) AS bank_account FROM transactions t JOIN users u ON u.id = t.author_id LEFT JOIN recurring_occurrences o ON o.transaction_id = t.id LEFT JOIN private_transactions p ON p.transaction_id = t.id WHERE t.household_id = ? AND substr(t.date, 1, 7) = ? ORDER BY t.date DESC, t.created_at DESC`, hid, month), req.user.id),
            history: await monthlyHistory(hid, month),
            budgetFallback: await budgetFallback(hid, month),
            budgetSplit: await planning.splitFor(hid, month),
            advisor: await advisor.state(req.user, month),
            ...await savings.state(hid),
            shopping: await all('SELECT s.*, u.name AS author FROM shopping s JOIN users u ON u.id = s.author_id WHERE s.household_id = ? ORDER BY s.checked, s.created_at DESC', hid),
            notes: notes.map(note => ({ ...note, attachments: attachments.filter(a => a.note_id === note.id).map(({ storage_name, ...a }) => a) })),
        });
    });
    async function owned(table, id, user) {
        const record = await one(`SELECT * FROM ${table} WHERE id = ? AND household_id = ?`, id, user.household_id);
        if (!record)
            fail('Elemento non trovato.', 404);
        return record;
    }
    // Records imported from another member's balance-only account stay theirs.
    async function editableTransaction(id, user) {
        await owned('transactions', id, user);
        const privacy = await one('SELECT owner_id FROM private_transactions WHERE transaction_id = ?', id);
        if (privacy && privacy.owner_id !== user.id) fail('Elemento non trovato.', 404);
    }
    async function transactionInput(body, user) {
        if (!['income', 'expense'].includes(body.kind))
            fail('Tipo di movimento non valido.');
        const categoryId = body.kind === 'expense' ? text(body.categoryId, 'Categoria', 100) : null;
        if (categoryId)
            await owned('categories', categoryId, user);
        return [body.kind, cents(body.amount), categoryId, text(body.description, 'Descrizione', 200), date(body.date)];
    }
    app.post('/api/transactions', async (req, res) => {
        const values = await transactionInput(req.body, req.user);
        const id = randomUUID();
        await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...values, req.user.id, now());
        res.status(201).json({ id });
    });
    app.put('/api/transactions/:id', async (req, res) => {
        await editableTransaction(req.params.id, req.user);
        const values = await transactionInput(req.body, req.user);
        if (values[0] !== 'expense' && await one('SELECT id FROM bill_payments WHERE transaction_id = ?', req.params.id))
            fail('Il pagamento di una bolletta deve rimanere un’uscita.');
        await atomic(async () => {
            if (values[0] !== 'expense' && await one('SELECT id FROM deadline_receipts WHERE transaction_id = ?', req.params.id)) fail('Il pagamento di una scadenza deve rimanere un’uscita.');
            const occurrence = await one('SELECT o.*, r.kind FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id WHERE o.transaction_id = ?', req.params.id);
            if (occurrence && (values[0] !== occurrence.kind || values[4].slice(0, 7) !== occurrence.month)) fail('Un movimento ricorrente deve conservare il tipo e il mese di origine.');
            await run('UPDATE transactions SET kind = ?, amount = ?, category_id = ?, description = ?, date = ? WHERE id = ? AND household_id = ?', ...values, req.params.id, req.user.household_id);
            if (occurrence) await run('UPDATE recurring_occurrences SET overridden = 1 WHERE id = ?', occurrence.id);
            await bank.syncSavings(req.params.id, req.user.household_id);
        });
        res.json({ ok: true });
    });
    app.delete('/api/transactions/:id', async (req, res) => {
        await editableTransaction(req.params.id, req.user);
        // A savings transfer also leaves its goal, in the same transaction.
        await atomic(async () => {
            await bank.releaseSavings(req.params.id);
            await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
            await bank.reconcileSavings(req.user.household_id);
        });
        res.json({ ok: true });
    });
    app.put('/api/budget', async (req, res) => {
        const input = req.body.categories;
        const existing = await all('SELECT id FROM categories WHERE household_id = ?', req.user.household_id);
        if (!Array.isArray(input) || input.length !== existing.length || new Set(input.map(c => c.id)).size !== existing.length)
            fail('Schema delle categorie non valido.');
        const rows = input.map(c => {
            if (!existing.some(e => e.id === c.id))
                fail('Categoria non valida.');
            if (!Number.isInteger(c.percentage) || c.percentage < 0 || c.percentage > 10000)
                fail('Percentuale non valida.');
            return { id: c.id, name: text(c.name, 'Categoria', 60), percentage: c.percentage };
        });
        if (rows.reduce((sum, c) => sum + c.percentage, 0) !== 10000)
            fail('Le percentuali devono sommare esattamente il 100%.');
        await atomic(async () => {
            await planning.changeSplit(req.user.household_id, async () => {
                for (const c of rows) await run('UPDATE categories SET name = ?, percentage = ? WHERE id = ? AND household_id = ?', c.name, c.percentage, c.id, req.user.household_id);
            });
            await planning.saveCustom(req.user.household_id, rows);
        });
        res.json({ ok: true });
    });
    // Monthly quota and primary flag drive the automatic split of bank savings;
    // only one goal per family is primary.
    function goalPlan(body) {
        if (body.primary !== undefined && typeof body.primary !== 'boolean') fail('Valore non valido.');
        return body.monthly === undefined && body.primary === undefined ? null : { monthly: body.monthly ? cents(body.monthly) : 0, primary: body.primary ? 1 : 0 };
    }
    async function savePlan(goalId, plan, hid) {
        if (!plan) return;
        if (plan.primary) await run('UPDATE goal_plans SET is_primary = 0 WHERE goal_id IN (SELECT id FROM goals WHERE household_id = ?)', hid);
        await run('INSERT INTO goal_plans VALUES (?, ?, ?) ON CONFLICT(goal_id) DO UPDATE SET monthly = excluded.monthly, is_primary = excluded.is_primary', goalId, plan.monthly, plan.primary);
    }
    app.post('/api/goals', async (req, res) => {
        const { title, horizon, target, saved = 0, dueDate } = req.body;
        if (!['short', 'medium', 'long'].includes(horizon))
            fail('Orizzonte dell’obiettivo non valido.');
        const id = randomUUID();
        const plan = goalPlan(req.body);
        await atomic(async () => {
            await run('INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, text(title, 'Obiettivo', 120), horizon, cents(target), cents(saved, true), dueDate ? date(dueDate) : null, now());
            await savePlan(id, plan, req.user.household_id);
            await bank.reconcileSavings(req.user.household_id);
        });
        res.status(201).json({ id });
    });
    app.put('/api/goals/:id', async (req, res) => {
        await owned('goals', req.params.id, req.user);
        const { title, horizon, target, dueDate } = req.body;
        if (!['short', 'medium', 'long'].includes(horizon))
            fail('Orizzonte dell’obiettivo non valido.');
        const plan = goalPlan(req.body);
        await atomic(async () => {
            await run('UPDATE goals SET title = ?, horizon = ?, target = ?, due_date = ? WHERE id = ? AND household_id = ?', text(title, 'Obiettivo', 120), horizon, cents(target), dueDate ? date(dueDate) : null, req.params.id, req.user.household_id);
            await savePlan(req.params.id, plan, req.user.household_id);
            await bank.reconcileSavings(req.user.household_id);
        });
        res.json({ ok: true });
    });
    app.delete('/api/goals/:id', async (req, res) => {
        await owned('goals', req.params.id, req.user);
        // The balance shares of a deleted goal go to the others.
        await atomic(async () => {
            await run('DELETE FROM goals WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
            await bank.reconcileSavings(req.user.household_id);
        });
        res.json({ ok: true });
    });
    app.post('/api/shopping', async (req, res) => {
        const id = randomUUID();
        await run('INSERT INTO shopping VALUES (?, ?, ?, ?, ?, 0, ?, ?)', id, req.user.household_id, text(req.body.name, 'Prodotto', 120), text(req.body.quantity, 'Quantità', 40, true), text(req.body.section, 'Reparto', 60), req.user.id, now());
        res.status(201).json({ id });
    });
    app.patch('/api/shopping/:id', async (req, res) => {
        await owned('shopping', req.params.id, req.user);
        await run('UPDATE shopping SET checked = ? WHERE id = ? AND household_id = ?', boolean(req.body.checked), req.params.id, req.user.household_id);
        res.json({ ok: true });
    });
    app.delete('/api/shopping/checked', async (req, res) => {
        await run('DELETE FROM shopping WHERE household_id = ? AND checked = 1', req.user.household_id);
        res.json({ ok: true });
    });
    app.delete('/api/shopping/:id', async (req, res) => {
        await owned('shopping', req.params.id, req.user);
        await run('DELETE FROM shopping WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
        res.json({ ok: true });
    });
    function noteInput(body) {
        const title = text(body.title, 'Titolo', 120);
        const content = text(body.content, 'Appunto', 10000, true);
        if (!COLORS.includes(body.color))
            fail('Colore non valido.');
        return [title, content, body.color, boolean(body.pinned ?? false)];
    }
    app.post('/api/notes', async (req, res) => {
        const values = noteInput(req.body);
        const id = randomUUID();
        await run('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...values, req.user.id, now());
        res.status(201).json({ id });
    });
    app.put('/api/notes/:id', async (req, res) => {
        await owned('notes', req.params.id, req.user);
        const values = noteInput(req.body);
        await run('UPDATE notes SET title = ?, content = ?, color = ?, pinned = ?, updated_at = ? WHERE id = ? AND household_id = ?', ...values, now(), req.params.id, req.user.household_id);
        res.json({ ok: true });
    });
    app.patch('/api/notes/:id/pin', async (req, res) => {
        await owned('notes', req.params.id, req.user);
        await run('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ? AND household_id = ?', boolean(req.body.pinned), now(), req.params.id, req.user.household_id);
        res.json({ ok: true });
    });
    app.delete('/api/notes/:id', async (req, res) => {
        await owned('notes', req.params.id, req.user);
        const files = await all('SELECT storage_name FROM attachments WHERE note_id = ?', req.params.id);
        await run('DELETE FROM notes WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
        for (const file of files) {
            if (database)
                await database.files.remove(file.storage_name);
            else {
                const p = path.join(uploadDir, file.storage_name);
                if (existsSync(p))
                    unlinkSync(p);
            }
        }
        res.json({ ok: true });
    });
    installChunkUploads(app, { db, atomic, owned, fail, dataDir });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });
    app.post('/api/notes/:id/attachments', async (req, res, next) => {
        try {
            await owned('notes', req.params.id, req.user);
            if ((await one('SELECT COUNT(*) AS count FROM attachments WHERE note_id = ?', req.params.id)).count >= 5)
                fail('Puoi aggiungere al massimo 5 file a un appunto.');
            next();
        }
        catch (error) {
            next(error);
        }
    }, upload.single('file'), async (req, res, next) => {
        try {
            if (!req.file)
                fail('Seleziona un file.');
            const id = randomUUID();
            const filename = path.basename(req.file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'allegato';
            const { writeFile, unlink } = await import('node:fs/promises');
            const p = path.join(uploadDir, id);
            if (database)
                await database.files.put(id, req.file.buffer);
            else
                await writeFile(p, req.file.buffer, { mode: 0o600, flag: 'wx' });
            try {
                await atomic(async () => {
                    // Recheck under the cross-instance lock after storing the bytes.
                    await owned('notes', req.params.id, req.user);
                    if ((await one('SELECT COUNT(*) AS count FROM attachments WHERE note_id = ?', req.params.id)).count >= 5)
                        fail('Puoi aggiungere al massimo 5 file a un appunto.');
                    await run('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)', id, req.params.id, filename, id, req.file.mimetype, req.file.size);
                });
            }
            catch (error) {
                if (database)
                    await database.files.remove(id);
                else
                    await unlink(p);
                throw error;
            }
            res.status(201).json({ id });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/attachments/:id', async (req, res) => {
        const file = await one('SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.id = ? AND n.household_id = ?', req.params.id, req.user.household_id);
        if (!file)
            fail('File non trovato.', 404);
        res.set('Content-Type', 'application/octet-stream');
        if (database) {
            const bytes = await database.files.get(file.storage_name);
            res.attachment(file.original_name).type('application/octet-stream');
            for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) res.write(bytes.subarray(offset, offset + 1024 * 1024));
            res.end();
        }
        else
            res.download(path.join(uploadDir, file.storage_name), file.original_name);
    });
    app.delete('/api/attachments/:id', async (req, res) => {
        const file = await one('SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.id = ? AND n.household_id = ?', req.params.id, req.user.household_id);
        if (!file)
            fail('File non trovato.', 404);
        await run('DELETE FROM attachments WHERE id = ?', file.id);
        const p = path.join(uploadDir, file.storage_name);
        if (database)
            await database.files.remove(file.storage_name);
        else if (existsSync(p))
            unlinkSync(p);
        res.json({ ok: true });
    });
    app.get('/api/export', async (req, res) => {
        const hid = req.user.household_id;
        const escape = value => {
            let str = String(value ?? '');
            if (/^[=+\-@\t\r]/.test(str))
                str = "'" + str;
            return '"' + str.replaceAll('"', '""') + '"';
        };
        const rows = presentTransactions(await all(`SELECT t.date, t.kind, t.description, t.amount, t.category_id, c.name AS category, u.name AS author, p.owner_id AS private_owner FROM transactions t JOIN users u ON u.id = t.author_id LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN private_transactions p ON p.transaction_id = t.id WHERE t.household_id = ? ORDER BY t.date DESC`, hid), req.user.id);
        const csv = [['Data', 'Tipo', 'Descrizione', 'Importo EUR', 'Categoria'], ...rows.map(t => [t.date, t.kind === 'income' ? 'Entrata' : 'Uscita', t.description, (t.amount / 100).toFixed(2).replace('.', ','), t.category])].map(row => row.map(escape).join(';')).join('\r\n');
        res.attachment('movimenti-casa.csv').type('text/csv; charset=utf-8').send('\uFEFF' + csv);
    });
    app.use('/api', (req, res) => res.status(404).json({ error: 'Risorsa non trovata.' }));
    if (production && distDir) {
        app.use(express.static(distDir));
        app.get('/{*path}', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
    }
    app.use((error, req, res, next) => {
        if (res.headersSent)
            return next(error);
        if (error instanceof multer.MulterError)
            return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Il file supera il limite di 10 MB.' : 'Caricamento non valido.' });
        if (error.type === 'entity.parse.failed')
            return res.status(400).json({ error: 'Richiesta non valida.' });
        if (error.type === 'entity.too.large')
            return res.status(413).json({ error: 'Richiesta troppo grande.' });
        if (!error.status)
            console.error('Server error:', error.message);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Si è verificato un errore. Riprova.' });
    });
    return { app, db, backups, bank: { configured: bank.configured, synchronizeAll: async () => { await exclusive(() => bank.synchronizeAll()); await notifications.afterBankSync(); } },
        notifications: { evening: () => notifications.evening(), idle: () => notifications.idle() },
        advisor: { scheduled: () => advisor.scheduled(), idle: () => advisor.idle() }, close: () => { backups.stop(); return db.close(); } };
}
