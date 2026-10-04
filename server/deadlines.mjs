import { randomUUID } from 'node:crypto';
import { DEADLINE_SCHEMA } from './schema.mjs';
import { dueDate } from './workflows.mjs';

export function occurrenceDate(deadline, period) {
  const start = deadline.start_date;
  if (period < start.slice(0, 7)) return null;
  if (deadline.frequency === 'once') return period === start.slice(0, 7) ? start : null;
  if (deadline.frequency === 'yearly' && period.slice(5) !== start.slice(5, 7)) return null;
  return dueDate(period, deadline.due_day);
}

export function installDeadlines(app, { db, one, all, run, atomic, owned, fail, text, cents, date, now }) {
  if (!db.cloud) db.exec(DEADLINE_SCHEMA);
  function month(value) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12') fail('Mese non valido.');
    return value;
  }
  async function input(body, user) {
    if (!['once', 'monthly', 'yearly'].includes(body.frequency)) fail('Ripetizione non valida.');
    if (typeof body.requiresPayment !== 'boolean') fail('Indica se è previsto un pagamento.');
    if (!Number.isInteger(body.reminderDays) || body.reminderDays < 0 || body.reminderDays > 30) fail('Il promemoria deve essere tra 0 e 30 giorni prima.');
    const amount = body.requiresPayment ? cents(body.amount) : null;
    const category = body.requiresPayment ? text(body.categoryId, 'Categoria', 100) : null;
    if (category) await owned('categories', category, user);
    const startDate = date(body.startDate);
    const dueDay = body.frequency === 'monthly' ? body.dueDay : Number(startDate.slice(8));
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) fail('Il giorno deve essere tra 1 e 31.');
    return [text(body.name, 'Scadenza', 120), startDate, dueDay, body.frequency, Number(body.requiresPayment), amount, category, body.reminderDays];
  }
  // Import once per family. Existing payments retain their transaction IDs;
  // later undo operations must never re-import a receipt from the legacy tables.
  async function migrate(householdId) {
    if (await one('SELECT household_id FROM deadline_migrations WHERE household_id = ?', householdId)) return;
    await atomic(async () => {
      if (await one('SELECT household_id FROM deadline_migrations WHERE household_id = ?', householdId)) return;
      for (const bill of await all('SELECT * FROM bills WHERE household_id = ?', householdId)) {
        await run('INSERT INTO deadlines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING', bill.id, householdId, bill.name,
          dueDate(bill.start_month, bill.due_day), bill.due_day, 'monthly', 1, bill.amount, bill.category_id, bill.reminder_days, bill.active, bill.created_at);
        for (const receipt of await all('SELECT p.*, t.date, t.author_id FROM bill_payments p JOIN transactions t ON t.id = p.transaction_id WHERE p.bill_id = ?', bill.id)) {
          await run('INSERT INTO deadline_receipts VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deadline_id, month) DO NOTHING', receipt.id, bill.id, receipt.month, receipt.due_date, receipt.date, receipt.author_id, receipt.transaction_id);
        }
      }
      await run('INSERT INTO deadline_migrations VALUES (?)', householdId);
    });
  }
  app.post('/api/deadlines', async (req, res) => {
    const values = await input(req.body, req.user); const id = randomUUID();
    await run('INSERT INTO deadlines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', id, req.user.household_id, ...values, now());
    res.status(201).json({ id });
  });
  app.put('/api/deadlines/:id', async (req, res) => {
    await owned('deadlines', req.params.id, req.user); const values = await input(req.body, req.user);
    await run('UPDATE deadlines SET name = ?, start_date = ?, due_day = ?, frequency = ?, requires_payment = ?, amount = ?, category_id = ?, reminder_days = ? WHERE id = ? AND household_id = ?', ...values, req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  app.delete('/api/deadlines/:id', async (req, res) => {
    await owned('deadlines', req.params.id, req.user);
    await run('UPDATE deadlines SET active = 0 WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  app.post('/api/deadlines/:id/manage', async (req, res) => {
    const period = month(req.body.month); const handledDate = date(req.body.handledDate);
    let transactionId = null;
    await atomic(async () => {
      const deadline = await owned('deadlines', req.params.id, req.user);
      const due = occurrenceDate(deadline, period);
      if (!deadline.active || !due) fail('Questa scadenza non è attiva nel mese scelto.');
      if (await one('SELECT id FROM deadline_receipts WHERE deadline_id = ? AND month = ?', deadline.id, period)) fail('Questa scadenza risulta già gestita.', 409);
      if (deadline.requires_payment) {
        const amount = cents(req.body.amount ?? deadline.amount); transactionId = randomUUID();
        await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', transactionId, req.user.household_id, 'expense', amount, deadline.category_id, `${deadline.name} · ${due}`, handledDate, req.user.id, now());
      }
      await run('INSERT INTO deadline_receipts VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), deadline.id, period, due, handledDate, req.user.id, transactionId);
    });
    res.status(201).json({ transactionId });
  });
  app.delete('/api/deadlines/:id/manage/:month', async (req, res) => {
    const period = month(req.params.month);
    await atomic(async () => {
      const deadline = await owned('deadlines', req.params.id, req.user);
      const receipt = await one('SELECT * FROM deadline_receipts WHERE deadline_id = ? AND month = ?', deadline.id, period);
      if (!receipt) fail('Scadenza gestita non trovata.', 404);
      await run('DELETE FROM deadline_receipts WHERE id = ?', receipt.id);
      if (receipt.transaction_id) await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', receipt.transaction_id, req.user.household_id);
    });
    res.json({ ok: true });
  });
  return { async state(user, period) {
    await migrate(user.household_id);
    const rows = await all('SELECT * FROM deadlines WHERE household_id = ? ORDER BY name', user.household_id);
    const receipts = await all(`SELECT r.*, t.amount, t.category_id, u.name AS author FROM deadline_receipts r JOIN deadlines d ON d.id = r.deadline_id
      LEFT JOIN transactions t ON t.id = r.transaction_id JOIN users u ON u.id = r.author_id WHERE d.household_id = ? AND r.month = ?`, user.household_id, period);
    return rows.flatMap(d => {
      const managed = receipts.find(r => r.deadline_id === d.id) || null;
      const due = managed?.due_date || occurrenceDate(d, period);
      return due && (d.active || managed) ? [{ ...d, due_date: due, managed }] : [];
    }).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.name.localeCompare(b.name));
  } };
}
