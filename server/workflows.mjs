import { randomUUID } from 'node:crypto';
import { WORKFLOW_SCHEMA } from './schema.mjs';
export function mondayOf(value) {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
}
export function dueDate(month, day) {
    const [year, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
export function installWorkflows(app, { db, one, all, run, atomic, owned, fail, text, cents, date, now }) {
    if (!db.cloud)
        db.exec(WORKFLOW_SCHEMA);
    function month(value) {
        if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12')
            fail('Mese non valido.');
        return value;
    }
    async function billInput(body, user) {
        const categoryId = text(body.categoryId, 'Categoria', 100);
        await owned('categories', categoryId, user);
        if (!Number.isInteger(body.dueDay) || body.dueDay < 1 || body.dueDay > 31)
            fail('Il giorno di scadenza deve essere tra 1 e 31.');
        if (!Number.isInteger(body.reminderDays) || body.reminderDays < 0 || body.reminderDays > 30)
            fail('Il promemoria deve essere tra 0 e 30 giorni prima.');
        return [text(body.name, 'Bolletta', 120), cents(body.amount), categoryId, body.dueDay, month(body.startMonth), body.reminderDays];
    }
    // Older browser tabs still call /bills. Keep their writes consistent with
    // the new scadenziario and share the same receipt uniqueness checks.
    async function syncLegacyBill(id, user) {
        const bill = await owned('bills', id, user);
        await run(`INSERT INTO deadlines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, start_date = excluded.start_date,
          due_day = excluded.due_day, frequency = excluded.frequency, requires_payment = excluded.requires_payment,
          amount = excluded.amount, category_id = excluded.category_id, reminder_days = excluded.reminder_days`,
          bill.id, user.household_id, bill.name, dueDate(bill.start_month, bill.due_day), bill.due_day, 'monthly', 1,
          bill.amount, bill.category_id, bill.reminder_days, bill.active, bill.created_at);
    }
    app.post('/api/bills', async (req, res) => {
        const input = await billInput(req.body, req.user);
        const id = randomUUID();
        await atomic(async () => {
            await run('INSERT INTO bills VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', id, req.user.household_id, ...input, now());
            await syncLegacyBill(id, req.user);
        });
        res.status(201).json({ id });
    });
    app.put('/api/bills/:id', async (req, res) => {
        await owned('bills', req.params.id, req.user);
        const input = await billInput(req.body, req.user);
        await atomic(async () => {
            await run('UPDATE bills SET name = ?, amount = ?, category_id = ?, due_day = ?, start_month = ?, reminder_days = ? WHERE id = ? AND household_id = ?', ...input, req.params.id, req.user.household_id);
            await syncLegacyBill(req.params.id, req.user);
        });
        res.json({ ok: true });
    });
    app.delete('/api/bills/:id', async (req, res) => {
        await owned('bills', req.params.id, req.user);
        await atomic(async () => {
            await run('UPDATE bills SET active = 0 WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
            await run('UPDATE deadlines SET active = 0 WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
        });
        res.json({ ok: true });
    });
    app.post('/api/bills/:id/payments', async (req, res) => {
        const period = month(req.body.month);
        const paymentDate = date(req.body.paymentDate);
        const amount = cents(req.body.amount);
        const transactionId = randomUUID();
        await atomic(async () => {
            let bill = await owned('bills', req.params.id, req.user);
            const deadline = await one('SELECT * FROM deadlines WHERE id = ? AND household_id = ?', bill.id, req.user.household_id);
            if (deadline && (deadline.frequency !== 'monthly' || !deadline.requires_payment)) fail('Questa voce è stata modificata nelle Scadenze. Aggiorna la pagina.', 409);
            if (deadline) bill = { ...bill, ...deadline, start_month: deadline.start_date.slice(0, 7) };
            if (await one('SELECT id FROM bill_payments WHERE bill_id = ? AND month = ?', bill.id, period) || await one('SELECT id FROM deadline_receipts WHERE deadline_id = ? AND month = ?', bill.id, period))
                fail('Questa bolletta risulta già pagata per il mese scelto.', 409);
            if (!bill.active || period < bill.start_month)
                fail('Questa scadenza non è attiva nel mese scelto.');
            await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', transactionId, req.user.household_id, 'expense', amount, bill.category_id, `${bill.name} · ${period}`, paymentDate, req.user.id, now());
            const receiptId = randomUUID();
            await run('INSERT INTO bill_payments VALUES (?, ?, ?, ?, ?)', receiptId, bill.id, period, dueDate(period, bill.due_day), transactionId);
            if (deadline) await run('INSERT INTO deadline_receipts VALUES (?, ?, ?, ?, ?, ?, ?)', receiptId, bill.id, period, dueDate(period, bill.due_day), paymentDate, req.user.id, transactionId);
        });
        res.status(201).json({ transactionId });
    });
    app.delete('/api/bills/:id/payments/:month', async (req, res) => {
        const bill = await owned('bills', req.params.id, req.user);
        const period = month(req.params.month);
        const payment = await one('SELECT transaction_id FROM bill_payments WHERE bill_id = ? AND month = ?', bill.id, period);
        if (!payment)
            fail('Pagamento non trovato.', 404);
        // The FK cascade also clears the payment receipt when a movement is removed.
        await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', payment.transaction_id, req.user.household_id);
        res.json({ ok: true });
    });
    const sections = ['Frutta e verdura', 'Dispensa', 'Frigo e freschi', 'Casa e igiene', 'Altro'];
    async function mealInput(body, user, previous) {
        const mealDate = date(body.date);
        if (!['lunch', 'dinner'].includes(body.slot))
            fail('Scegli pranzo o cena.');
        if (!Number.isInteger(body.servings) || body.servings < 1 || body.servings > 20)
            fail('Le porzioni devono essere tra 1 e 20.');
        if (!Array.isArray(body.ingredients) || body.ingredients.length > 30)
            fail('Puoi aggiungere al massimo 30 ingredienti.');
        const previousIds = new Set(previous ? JSON.parse(previous.ingredients).map(i => i.id) : []);
        const seen = new Set();
        const ingredients = body.ingredients.map(i => {
            if (!i || typeof i !== 'object' || !sections.includes(i.section))
                fail('Ingrediente non valido.');
            const id = previousIds.has(i.id) && !seen.has(i.id) ? i.id : randomUUID();
            seen.add(id);
            return { id, name: text(i.name, 'Ingrediente', 120), quantity: text(i.quantity, 'Quantità', 40, true), section: i.section };
        });
        const collision = await one('SELECT id FROM meals WHERE household_id = ? AND date = ? AND slot = ?', user.household_id, mealDate, body.slot);
        if (collision && collision.id !== previous?.id)
            fail('Questo pasto è già pianificato. Modifica la voce esistente.', 409);
        return [mealDate, body.slot, text(body.title, 'Pasto', 120), body.servings, JSON.stringify(ingredients), text(body.notes, 'Preparazione', 2000, true)];
    }
    app.post('/api/meals', async (req, res) => {
        const input = await mealInput(req.body, req.user);
        const id = randomUUID();
        await run('INSERT INTO meals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...input, req.user.id);
        res.status(201).json({ id });
    });
    app.put('/api/meals/:id', async (req, res) => {
        const previous = await owned('meals', req.params.id, req.user);
        const input = await mealInput(req.body, req.user, previous);
        await atomic(async () => {
            await run('UPDATE meals SET date = ?, slot = ?, title = ?, servings = ?, ingredients = ?, notes = ? WHERE id = ? AND household_id = ?', ...input, previous.id, req.user.household_id);
            for (const ingredient of JSON.parse(input[4])) {
                const linked = await one('SELECT shopping_id FROM meal_shopping WHERE meal_id = ? AND ingredient_id = ?', previous.id, ingredient.id);
                if (linked)
                    await run('UPDATE shopping SET name = ?, quantity = ?, section = ? WHERE id = ? AND household_id = ? AND checked = 0', ingredient.name, ingredient.quantity, ingredient.section, linked.shopping_id, req.user.household_id);
            }
        });
        res.json({ ok: true });
    });
    app.delete('/api/meals/:id', async (req, res) => {
        await owned('meals', req.params.id, req.user);
        await run('DELETE FROM meals WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
        res.json({ ok: true });
    });
    app.post('/api/meals/:id/shopping', async (req, res) => {
        const meal = await owned('meals', req.params.id, req.user);
        const ingredients = JSON.parse(meal.ingredients);
        if (!ingredients.length)
            fail('Aggiungi prima gli ingredienti del pasto.');
        let added = 0;
        await atomic(async () => {
            for (const ingredient of ingredients) {
                if (await one('SELECT shopping_id FROM meal_shopping WHERE meal_id = ? AND ingredient_id = ?', meal.id, ingredient.id))
                    continue;
                const id = randomUUID();
                await run('INSERT INTO shopping VALUES (?, ?, ?, ?, ?, 0, ?, ?)', id, req.user.household_id, ingredient.name, ingredient.quantity, ingredient.section, req.user.id, now());
                await run('INSERT INTO meal_shopping VALUES (?, ?, ?)', meal.id, ingredient.id, id);
                added++;
            }
        });
        res.json({ added });
    });
    return {
        async state(user, period, requestedWeek) {
            const week = mondayOf(date(requestedWeek || new Date().toISOString().slice(0, 10)));
            const end = new Date(`${week}T12:00:00Z`);
            end.setUTCDate(end.getUTCDate() + 6);
            const meals = await all('SELECT m.*, u.name AS author FROM meals m JOIN users u ON u.id = m.author_id WHERE m.household_id = ? AND m.date BETWEEN ? AND ? ORDER BY m.date, m.slot', user.household_id, week, end.toISOString().slice(0, 10));
            const links = await all('SELECT ms.meal_id, ms.ingredient_id FROM meal_shopping ms JOIN meals m ON m.id = ms.meal_id WHERE m.household_id = ?', user.household_id);
            const bills = await all(`SELECT b.* FROM bills b WHERE b.household_id = ? AND ((b.active = 1 AND b.start_month <= ?) OR EXISTS(SELECT 1 FROM bill_payments p WHERE p.bill_id = b.id AND p.month = ?)) ORDER BY b.due_day, b.name`, user.household_id, period, period);
            return { week,
                meals: meals.map(m => ({ ...m, ingredients: JSON.parse(m.ingredients), shoppingAdded: links.filter(l => l.meal_id === m.id).map(l => l.ingredient_id) })),
                bills: await Promise.all(bills.map(async (b) => {
                    const receipt = await one(`SELECT p.transaction_id, p.due_date, t.amount, t.date, u.name AS author FROM bill_payments p JOIN transactions t ON t.id = p.transaction_id JOIN users u ON u.id = t.author_id WHERE p.bill_id = ? AND p.month = ?`, b.id, period);
                    return { ...b, due_date: receipt?.due_date || dueDate(period, b.due_day), payment: receipt || null };
                })),
            };
        },
    };
}
