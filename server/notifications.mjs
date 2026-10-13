import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { NOTIFICATION_SCHEMA } from './schema.mjs';
import { addDays, romeToday } from './bank.mjs';
import { occurrenceDate } from './deadlines.mjs';
import { occurrenceOn } from './calendar.mjs';

export const NOTIFICATION_TYPES = ['notes', 'shopping', 'meals', 'deadlines', 'budget', 'waste', 'calendar', 'bank'];
// The server only posts to the browsers' push services, never to an address of
// the client's choosing.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
const FAMILY_WINDOW = 15 * 60000;
const FAMILY_ROUTES = [[/^\/api\/meals\/[^/]+\/shopping$/, 'shopping'], [/^\/api\/shopping(\/|$)/, 'shopping'], [/^\/api\/notes(\/|$)/, 'notes'], [/^\/api\/meals(\/|$)/, 'meals'], [/^\/api\/calendar(\/|$)/, 'calendar']];
const euro = cents => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const day = value => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
const weekday = value => (new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7;
export const romeHour = ms => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));

// Same rounding as the interface: the category budgets add up to the income.
export function allocateBudget(income, categories) {
  const rows = categories.map((c, index) => ({ id: c.id, amount: Math.floor(income * c.percentage / 10000), remainder: income * c.percentage % 10000, index }));
  let left = income - rows.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) { if (left <= 0) break; row.amount++; left--; }
  return Object.fromEntries(rows.map(row => [row.id, row.amount]));
}

export function webPushSender() {
  return (subscription, payload, keys) => webpush.sendNotification(subscription, payload, { vapidDetails: keys, TTL: 12 * 3600, timeout: 10000 });
}

export function installNotifications(app, { db, one, all, run, atomic, fail, exclusive }, { sender = webPushSender(), env = process.env, appUrl, schedule, clock = Date.now } = {}) {
  if (!db.cloud) db.exec(NOTIFICATION_SCHEMA);
  const now = () => new Date(clock()).toISOString();
  let keys = null;
  async function vapid() {
    if (keys) return keys;
    const subject = env.VAPID_SUBJECT || (appUrl?.startsWith('https://') ? appUrl : 'mailto:notifiche@family-hub.invalid');
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return (keys = { subject, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
    // Without keys in the environment, one pair is created once and kept in the
    // database, shared by every instance.
    let row = await one('SELECT public_key, private_key FROM push_keys WHERE id = 1');
    if (!row) {
      const created = webpush.generateVAPIDKeys();
      await run('INSERT INTO push_keys VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING', created.publicKey, created.privateKey, now());
      row = await one('SELECT public_key, private_key FROM push_keys WHERE id = 1');
    }
    return (keys = { subject, publicKey: row.public_key, privateKey: row.private_key });
  }
  async function preferences(userId) {
    const row = await one('SELECT types FROM notification_preferences WHERE user_id = ?', userId);
    let saved = {};
    try { saved = row ? JSON.parse(row.types) : {}; } catch { saved = {}; }
    return Object.fromEntries(NOTIFICATION_TYPES.map(type => [type, saved[type] !== false]));
  }
  // Each notice reaches a person once: the log entry is written before sending.
  async function claim(userId, key) {
    const result = await run('INSERT INTO notification_log VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING', userId, key, now());
    return Number(result?.changes ?? result?.rowCount ?? 0) > 0;
  }
  async function recipients(householdId, type, { except, only } = {}) {
    const users = await all(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.household_id = ?`, householdId);
    const chosen = [];
    for (const { id } of users) if (id !== except && (!only || only === id) && (await preferences(id))[type]) chosen.push(id);
    return chosen;
  }
  // Messages are collected inside the request queue and sent outside it.
  async function deliver(messages) {
    if (!messages.length) return;
    const details = await vapid();
    for (const { userId, title, body, url, tag } of messages) {
      for (const subscription of await all('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId)) {
        try { await sender({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ title, body, url, tag }), details); }
        catch (error) {
          // A device that unsubscribed or no longer accepts these keys is forgotten.
          if ([401, 403, 404, 410].includes(error?.statusCode)) await run('DELETE FROM push_subscriptions WHERE id = ?', subscription.id);
          else console.error('Notifica non inviata:', error?.statusCode || error?.code || 'errore di rete');
        }
      }
    }
  }
  const pending = new Set();
  const later = work => {
    const task = work().catch(error => console.error('Notifiche non inviate:', error.message)).finally(() => pending.delete(task));
    pending.add(task); if (schedule) schedule(task); return task;
  };

  async function familyChange(user, type) {
    const messages = [];
    const bucket = Math.floor(clock() / FAMILY_WINDOW);
    const copy = { shopping: ['Lista della spesa', 'ha aggiornato la lista della spesa.', '#shopping'], notes: ['Lavagna di famiglia', 'ha scritto sulla lavagna.', '#notes'], meals: ['Menu settimanale', 'ha aggiornato i pasti programmati.', '#meals'], calendar: ['Calendario di famiglia', 'ha aggiornato il calendario.', '#calendar'] }[type];
    for (const userId of await recipients(user.household_id, type, { except: user.id })) {
      if (await claim(userId, `${type}:${user.id}:${bucket}`)) messages.push({ userId, title: copy[0], body: `${user.name} ${copy[1]}`, url: copy[2], tag: `${type}-${user.id}` });
    }
    return messages;
  }

  // Checks that follow changes to the budget and bank imports.
  async function scan(householdId) {
    const messages = [];
    // Families without devices skip the checks altogether.
    if (!(await one('SELECT s.id FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.household_id = ? LIMIT 1', householdId))) return messages;
    const today = romeToday(clock()); const month = today.slice(0, 7);
    const budgetPeople = await recipients(householdId, 'budget');
    if (budgetPeople.length) {
      const income = Number((await one(`SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN recurring_occurrences o ON o.transaction_id = t.id
        WHERE t.household_id = ? AND t.kind = 'income' AND substr(t.date, 1, 7) = ?`, householdId, month)).total);
      if (income > 0) {
        // A split suggested for this month only replaces the usual one.
        const override = await one('SELECT entries FROM budget_month_overrides WHERE household_id = ? AND month = ?', householdId, month);
        const split = override ? JSON.parse(override.entries) : {};
        const categories = (await all('SELECT id, name, percentage FROM categories WHERE household_id = ? ORDER BY position', householdId)).map(c => ({ ...c, percentage: split[c.id] ?? c.percentage }));
        const limits = allocateBudget(income, categories);
        const spent = new Map((await all(`SELECT category_id, SUM(amount) AS total FROM transactions WHERE household_id = ? AND kind = 'expense' AND substr(date, 1, 7) = ? AND category_id IS NOT NULL GROUP BY category_id`, householdId, month)).map(r => [r.category_id, Number(r.total)]));
        for (const category of categories) {
          const total = spent.get(category.id) || 0;
          if (total <= limits[category.id]) continue;
          for (const userId of budgetPeople) if (await claim(userId, `budget:${category.id}:${month}`))
            messages.push({ userId, title: `Budget superato: ${category.name}`, body: `Questo mese ${euro(total)} su ${euro(limits[category.id])}.`, url: '#budget', tag: `budget-${category.id}` });
        }
      }
    }
    // Bank expenses imported in the last two days and still without a category;
    // private ones reach only their owner.
    const since = new Date(clock() - 2 * 86400000).toISOString();
    const fresh = await all(`SELECT t.id, t.description, p.owner_id FROM transactions t JOIN bank_movements m ON m.transaction_id = t.id LEFT JOIN private_transactions p ON p.transaction_id = t.id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.category_id IS NULL AND m.status = 'imported' AND t.created_at >= ? ORDER BY t.date, t.id`, householdId, since);
    if (fresh.length) {
      const bankPeople = await recipients(householdId, 'bank');
      for (const userId of bankPeople) {
        const visible = fresh.filter(t => !t.owner_id || t.owner_id === userId);
        const unseen = [];
        for (const t of visible) if (await claim(userId, `bank:uncategorized:${t.id}`)) unseen.push(t);
        if (unseen.length) messages.push({ userId, title: unseen.length === 1 ? 'Un’uscita da classificare' : `${unseen.length} uscite da classificare`,
          body: `${unseen.slice(0, 3).map(t => t.description).join(', ')}${unseen.length > 3 ? '…' : ''}. Scegli la categoria in Uscite.`, url: '#expenses', tag: 'bank-uncategorized' });
      }
    }
    for (const connection of await all("SELECT id, user_id, aspsp_name, status FROM bank_connections WHERE household_id = ? AND status IN ('error', 'expired')", householdId)) {
      if (!(await recipients(householdId, 'bank', { only: connection.user_id })).length) continue;
      if (await claim(connection.user_id, `bank:${connection.status}:${connection.id}:${today}`))
        messages.push({ userId: connection.user_id, title: connection.aspsp_name, body: connection.status === 'expired' ? 'Il consenso è scaduto: rinnova il collegamento.' : 'L’aggiornamento dei conti non è riuscito. Riprova o rinnova il collegamento.', url: '#settings/conti', tag: `bank-${connection.id}` });
    }
    return messages;
  }

  // The evening round: tomorrow's waste collection and events, deadlines and bank consents.
  async function evening(householdId) {
    const messages = [];
    const today = romeToday(clock()); const tomorrow = addDays(today, 1);
    const collections = (await all('SELECT name, days, time_window FROM waste_schedules WHERE household_id = ? ORDER BY name', householdId)).filter(w => JSON.parse(w.days).includes(weekday(tomorrow)));
    if (collections.length) for (const userId of await recipients(householdId, 'waste')) {
      if (await claim(userId, `waste:${tomorrow}`)) messages.push({ userId, title: `Domani: ${collections.map(w => w.name).join(', ')}`,
        body: collections.map(w => w.time_window ? `${w.name}: ${w.time_window}` : w.name).join(' · '), url: '#waste', tag: 'waste' });
    }
    const events = (await all('SELECT * FROM calendar_events WHERE household_id = ? AND start_date <= ? ORDER BY start_time, title', householdId, tomorrow)).filter(e => occurrenceOn(e, tomorrow) === tomorrow);
    if (events.length) for (const userId of await recipients(householdId, 'calendar')) {
      if (await claim(userId, `calendar:${tomorrow}`)) messages.push({ userId, title: events.length === 1 ? `Domani: ${events[0].title}` : `Domani: ${events.length} eventi in calendario`,
        body: events.map(e => `${e.start_time ? `${e.start_time} ` : ''}${e.title}${e.location ? ` (${e.location})` : ''}`).join(' · '), url: '#calendar', tag: 'calendar' });
    }
    const deadlinePeople = await recipients(householdId, 'deadlines');
    if (deadlinePeople.length) {
      for (const deadline of await all('SELECT * FROM deadlines WHERE household_id = ? AND active = 1', householdId)) {
        for (const period of [today.slice(0, 7), addDays(`${today.slice(0, 7)}-28`, 7).slice(0, 7)]) {
          const due = occurrenceDate(deadline, period);
          if (!due || await one('SELECT id FROM deadline_receipts WHERE deadline_id = ? AND month = ?', deadline.id, period)) continue;
          const days = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
          const kind = days < 0 ? 'overdue' : days <= deadline.reminder_days ? 'soon' : null;
          // Overdue notices are for the current month only.
          if (!kind || (kind === 'overdue' && period !== today.slice(0, 7))) continue;
          for (const userId of deadlinePeople) if (await claim(userId, `deadline:${deadline.id}:${due}:${kind}`))
            messages.push({ userId, title: kind === 'overdue' ? `Scaduta: ${deadline.name}` : days === 0 ? `Scade oggi: ${deadline.name}` : `In scadenza: ${deadline.name}`,
              body: `${kind === 'overdue' ? 'Era prevista per il' : 'Scadenza:'} ${day(due)}${deadline.requires_payment && deadline.amount ? ` · ${euro(Number(deadline.amount))}` : ''}.`, url: '#bills', tag: `deadline-${deadline.id}` });
        }
      }
    }
    for (const connection of await all("SELECT id, user_id, aspsp_name, valid_until FROM bank_connections WHERE household_id = ? AND status = 'active'", householdId)) {
      const left = Math.floor((Date.parse(connection.valid_until) - clock()) / 86400000);
      if (left > 7 || left < 0 || !(await recipients(householdId, 'bank', { only: connection.user_id })).length) continue;
      if (await claim(connection.user_id, `bank:expiring:${connection.id}:${connection.valid_until}`))
        messages.push({ userId: connection.user_id, title: connection.aspsp_name, body: `Il consenso scade il ${day(connection.valid_until.slice(0, 10))}: rinnovalo da Impostazioni, Conti bancari.`, url: '#settings/conti', tag: `bank-${connection.id}` });
    }
    return [...messages, ...await scan(householdId)];
  }
  const households = async () => (await all('SELECT DISTINCT u.household_id FROM users u JOIN push_subscriptions s ON s.user_id = u.id')).map(r => r.household_id);

  // After a change by a member: family notices and the budget and bank checks.
  app.use('/api', (req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || path.startsWith('/api/notifications') || path === '/api/logout') return next();
    const user = { id: req.user.id, name: req.user.name, household_id: req.user.household_id };
    res.once('finish', () => {
      if (res.statusCode >= 400) return;
      const type = FAMILY_ROUTES.find(([pattern]) => pattern.test(path))?.[1];
      void later(async () => {
        const messages = await exclusive(async () => [...(type ? await familyChange(user, type) : []), ...await scan(user.household_id)]);
        await deliver(messages);
      });
    });
    next();
  });

  return {
    async state(user) {
      const { publicKey } = await vapid();
      return { publicKey, types: await preferences(user.id), devices: Number((await one('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?', user.id)).count) };
    },
    routes() {
      app.post('/api/notifications/subscriptions', async (req, res) => {
        const { endpoint, keys: subscriptionKeys } = req.body || {};
        let url;
        try { url = new URL(String(endpoint)); } catch { fail('Dispositivo non valido.'); }
        if (url.protocol !== 'https:' || String(endpoint).length > 1000 || !PUSH_HOSTS.some(host => host.test(url.hostname))) fail('Servizio di notifica non supportato.');
        const p256dh = String(subscriptionKeys?.p256dh || ''); const auth = String(subscriptionKeys?.auth || '');
        if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) fail('Dispositivo non valido.');
        await atomic(async () => {
          if ((await one('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ? AND endpoint <> ?', req.user.id, url.href)).count >= 10) fail('Puoi attivare le notifiche su 10 dispositivi al massimo.');
          // A device moves to the account that activates it last.
          await run(`INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
            randomUUID(), req.user.id, url.href, p256dh, auth, now());
        });
        res.status(201).json({ ok: true });
      });
      app.delete('/api/notifications/subscriptions', async (req, res) => {
        await run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', req.user.id, String(req.body?.endpoint || ''));
        res.json({ ok: true });
      });
      app.put('/api/notifications/preferences', async (req, res) => {
        const types = req.body?.types;
        if (!types || typeof types !== 'object' || Array.isArray(types) || Object.keys(types).some(type => !NOTIFICATION_TYPES.includes(type)) || Object.values(types).some(value => typeof value !== 'boolean')) fail('Scelta delle notifiche non valida.');
        const merged = { ...await preferences(req.user.id), ...types };
        await run('INSERT INTO notification_preferences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET types = excluded.types', req.user.id, JSON.stringify(merged));
        res.json({ ok: true });
      });
      app.post('/api/notifications/test', async (req, res) => {
        if (!(await one('SELECT id FROM push_subscriptions WHERE user_id = ?', req.user.id))) fail('Attiva prima le notifiche su questo dispositivo.');
        await deliver([{ userId: req.user.id, title: 'Family Hub', body: 'Le notifiche funzionano su questo dispositivo.', url: '#settings/notifiche', tag: 'test' }]);
        res.json({ ok: true });
      });
    },
    // Called by the daily cron (already inside the request queue) and, locally,
    // by the server's timer.
    async evening({ queued = false } = {}) {
      const serial = queued ? work => work() : exclusive;
      for (const householdId of await households()) {
        try { await deliver(await serial(() => evening(householdId))); }
        catch (error) { console.error('Notifiche della sera non inviate:', error.message); }
      }
      await run('DELETE FROM notification_log WHERE created_at < ?', new Date(clock() - 60 * 86400000).toISOString());
    },
    deliver,
    // A new budget report reaches who wants budget notices, once per report.
    async reportReady(householdId, { kind, period, title, body }) {
      const messages = [];
      for (const userId of await recipients(householdId, 'budget')) if (await claim(userId, `advisor:${kind}:${period}`))
        messages.push({ userId, title, body, url: '#overview', tag: `advisor-${kind}` });
      return messages;
    },
    // Background deliveries still running (tests and graceful shutdown).
    async idle() { while (pending.size) await Promise.all([...pending]); },
    async afterBankSync({ queued = false } = {}) {
      const serial = queued ? work => work() : exclusive;
      for (const householdId of await households()) {
        try { await deliver(await serial(() => scan(householdId))); }
        catch (error) { console.error('Notifiche non inviate:', error.message); }
      }
    },
  };
}
