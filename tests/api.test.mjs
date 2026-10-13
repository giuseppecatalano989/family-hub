import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { verifyInstanceBackup, restoreInstanceBackup, createBackupManager } from '../server/backups.mjs';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { unzipSync } from 'fflate';

let instance, server, base, dataDir;
beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-api-'));
  instance = createApp({ dataDir });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  instance.close(); rmSync(dataDir, { recursive: true, force: true });
});
async function request(route, { method = 'GET', body, session, headers = {} } = {}) {
  const multipart = body instanceof FormData;
  return fetch(base + route, {
    method,
    headers: {
      ...(body && !multipart ? { 'content-type': 'application/json' } : {}),
      'x-requested-with': 'Casa',
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
      ...headers,
    },
    body: body ? multipart ? body : JSON.stringify(body) : undefined,
  });
}
async function register(email = 'alice@example.it', extra = {}) {
  const response = await request('/auth/register', { method: 'POST', body: { name: 'Alice', email, password: 'password-test-123', householdName: 'Casa Rossi', ...extra } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: result.csrf, user: result.user };
}
async function state(session, month = '2026-10', week = '2026-10-05') {
  const response = await request(`/state?month=${month}&week=${week}`, { session });
  assert.equal(response.status, 200); return response.json();
}
async function create(route, body, session) {
  const response = await request(route, { method: 'POST', body, session });
  assert.equal(response.status, 201, await response.clone().text()); return response.json();
}

test('registration, login, secure cookie flags and logout persist server-side sessions', async () => {
  const anonymous = await request('/state?month=2026-10'); assert.equal(anonymous.status, 401);
  const owner = await register();
  assert.equal(owner.user.role, 'admin');
  assert.equal('password_hash' in owner.user, false);
  assert.equal((await state(owner)).categories.reduce((sum, c) => sum + c.percentage, 0), 10000);
  const wrong = await request('/auth/login', { method: 'POST', body: { email: 'alice@example.it', password: 'wrong-password' } }); assert.equal(wrong.status, 401);
  const loggedIn = await request('/auth/login', { method: 'POST', body: { email: 'ALICE@example.it', password: 'password-test-123' } });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly/);
  assert.match(loggedIn.headers.get('set-cookie'), /SameSite=Lax/);
  const duplicate = await request('/auth/register', { method: 'POST', body: { name: 'Other', email: 'alice@example.it', password: 'password-test-123', householdName: 'Casa B' } }); assert.equal(duplicate.status, 409);
  assert.equal((await request('/logout', { method: 'POST', session: owner })).status, 200);
  assert.equal((await request('/state?month=2026-10', { session: owner })).status, 401);
});

test('invited members share updates; a separate family cannot read or modify them', async () => {
  const owner = await register();
  const invitation = await (await request('/invitation', { method: 'POST', session: owner })).json();
  const bob = await register('bob@example.it', { name: 'Bob', inviteCode: invitation.code });
  assert.equal(bob.user.householdId, owner.user.householdId);
  assert.equal(bob.user.role, 'member');
  const eve = await register('eve@example.it');
  const item = await create('/shopping', { name: 'Latte', quantity: '2 litri', section: 'Frigo e freschi' }, owner);
  assert.equal((await state(bob)).shopping[0].name, 'Latte');
  assert.equal((await request(`/shopping/${item.id}`, { method: 'PATCH', body: { checked: true }, session: bob })).status, 200);
  assert.equal((await state(owner)).shopping[0].checked, 1);
  assert.equal((await state(eve)).shopping.length, 0);
  assert.equal((await request(`/shopping/${item.id}`, { method: 'DELETE', session: eve })).status, 404);
  assert.equal((await request('/invitation', { method: 'POST', session: bob })).status, 403);
  const rotated = await request('/invitation', { method: 'POST', session: owner }); assert.equal(rotated.status, 200);
  const stale = await request('/auth/register', { method: 'POST', body: { name: 'Carl', email: 'carl@example.it', password: 'password-test-123', inviteCode: invitation.code } }); assert.equal(stale.status, 400);
});

test('CSRF, cross-origin mutations, invalid invitation and input validation are rejected', async () => {
  const owner = await register();
  assert.equal((await request('/notes', { method: 'POST', session: owner, headers: { 'x-csrf-token': '' }, body: {} })).status, 403);
  assert.equal((await request('/notes', { method: 'POST', session: owner, headers: { origin: 'https://another-site.example' }, body: {} })).status, 403);
  assert.equal((await request('/notes', { method: 'POST', session: owner, headers: { 'x-requested-with': '' }, body: {} })).status, 403);
  assert.equal((await request('/auth/register', { method: 'POST', body: { name: 'Carl', email: 'carl@example.it', password: 'password-test-123', inviteCode: 'NONVALIDO' } })).status, 400);
  assert.equal((await request('/state?month=2026-13', { session: owner })).status, 400);
});

test('transactions are exact integer cents, scoped by month, editable and removable', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const expense = await create('/transactions', { kind: 'expense', amount: 1050, categoryId, description: 'Bollette', date: '2026-10-03' }, owner);
  await create('/transactions', { kind: 'income', amount: 250000, description: 'Stipendio', date: '2026-10-01' }, owner);
  await create('/transactions', { kind: 'income', amount: 10000, description: 'Settembre', date: '2026-09-01' }, owner);
  let current = await state(owner); assert.equal(current.transactions.length, 2);
  assert.equal(current.transactions.reduce((sum, t) => sum + (t.kind === 'income' ? t.amount : -t.amount), 0), 248950);
  const invalid = { kind: 'expense', categoryId, description: 'Test', date: '2026-10-01' };
  for (const amount of [0, -1, 10.5, '1200', 1_000_000_001]) assert.equal((await request('/transactions', { method: 'POST', session: owner, body: { ...invalid, amount } })).status, 400);
  assert.equal((await request('/transactions', { method: 'POST', session: owner, body: { ...invalid, amount: 100, date: '2026-02-30' } })).status, 400);
  assert.equal((await request(`/transactions/${expense.id}`, { method: 'PUT', session: owner, body: { ...invalid, amount: 2000, description: 'Bolletta aggiornata' } })).status, 200);
  current = await state(owner); assert.equal(current.transactions.find(t => t.id === expense.id).amount, 2000);
  assert.equal((await request(`/transactions/${expense.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).transactions.length, 1);
  assert.equal((await state(owner, '2026-09')).transactions.length, 1);
});

test('budget updates are atomic and require all owned categories and exactly 100 percent', async () => {
  const owner = await register(); const { categories } = await state(owner);
  const invalid = categories.map(c => ({ ...c, percentage: 1000 }));
  assert.equal((await request('/budget', { method: 'PUT', body: { categories: invalid }, session: owner })).status, 400);
  assert.deepEqual((await state(owner)).categories, categories);
  const updated = categories.map((c, i) => ({ ...c, name: i === 0 ? 'Affitto e bollette' : c.name, percentage: [3000, 2000, 1000, 500, 1000, 2500][i] }));
  assert.equal((await request('/budget', { method: 'PUT', body: { categories: updated }, session: owner })).status, 200);
  assert.equal((await state(owner)).categories[0].name, 'Affitto e bollette');
  const other = await register('eve@example.it');
  assert.equal((await request('/transactions', { method: 'POST', session: other, body: { kind: 'expense', categoryId: categories[0].id, amount: 100, description: 'Wrong', date: '2026-10-01' } })).status, 404);
  const duplicated = updated.map(() => updated[0]);
  assert.equal((await request('/budget', { method: 'PUT', body: { categories: duplicated }, session: owner })).status, 400);
});

test('short, medium and long term goals retain initial savings and add contributions without changing movements', async () => {
  const owner = await register();
  for (const horizon of ['short', 'medium', 'long']) await create('/goals', { title: horizon, horizon, target: 100000, saved: 5000, dueDate: '2027-10-01' }, owner);
  const goals = (await state(owner)).goals;
  const goal = goals[0];
  const responses = await Promise.all([2500, 3000].map(amount => request(`/goals/${goal.id}/contributions`, { method: 'POST', body: { amount }, session: owner })));
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  const current = await state(owner); assert.equal(current.goals.find(g => g.id === goal.id).saved, 10500);
  assert.equal(current.transactions.length, 0);
  assert.equal((await request(`/goals/${goal.id}`, { method: 'PUT', body: { title: 'Progetto aggiornato', horizon: 'long', target: 200000, dueDate: '2030-01-01' }, session: owner })).status, 200);
  const edited = (await state(owner)).goals.find(g => g.id === goal.id); assert.equal(edited.title, 'Progetto aggiornato'); assert.equal(edited.saved, 10500); assert.equal(edited.target, 200000);
  assert.equal((await request(`/goals/${goal.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).goals.length, 2);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM contributions').get().count, 0);
});

test('initial savings and individual contributions can be corrected or removed without changing other goals or family movements', async () => {
  const owner = await register();
  const invitation = await (await request('/invitation', { method: 'POST', session: owner })).json();
  const member = await register('member@example.it', { name: 'Bob', inviteCode: invitation.code });
  const stranger = await register('stranger@example.it');
  const goal = await create('/goals', { title: 'Viaggio', horizon: 'medium', target: 100000, saved: 5000 }, owner);
  const other = await create('/goals', { title: 'Fondo', horizon: 'short', target: 50000, saved: 1000 }, owner);
  const first = await create(`/goals/${goal.id}/contributions`, { amount: 2500 }, owner);
  const second = await create(`/goals/${goal.id}/contributions`, { amount: 3000 }, member);
  const unrelated = await create(`/goals/${other.id}/contributions`, { amount: 500 }, owner);
  const view = await state(member);
  assert.equal(view.goals.find(item => item.id === goal.id).initial_saved, 5000);
  assert.equal(view.contributions.find(item => item.id === second.id).author, 'Bob');
  assert.equal((await state(stranger)).contributions.length, 0);
  const path = `/goals/${goal.id}/contributions/${first.id}`;
  for (const amount of [0, -1, 5.5, '100', 1_000_000_001]) assert.equal((await request(path, { method: 'PUT', body: { amount }, session: owner })).status, 400);
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request(path, { method, body: method === 'PUT' ? { amount: 1000 } : undefined, session: stranger })).status, 404);
    assert.equal((await request(`/goals/${goal.id}/initial-savings`, { method, body: method === 'PUT' ? { amount: 1000 } : undefined, session: stranger })).status, 404);
    assert.equal((await request(`/goals/${goal.id}/contributions/${unrelated.id}`, { method, body: method === 'PUT' ? { amount: 1000 } : undefined, session: owner })).status, 404);
  }
  assert.equal((await request(path, { method: 'PUT', body: { amount: 1500 }, session: member })).status, 200);
  assert.equal((await state(owner)).goals.find(item => item.id === goal.id).saved, 9500);
  // Overflow must roll back both the total and the affected entry.
  assert.equal((await request(path, { method: 'PUT', body: { amount: 1_000_000_000 }, session: owner })).status, 400);
  assert.equal((await request(`/goals/${goal.id}/initial-savings`, { method: 'PUT', body: { amount: 1_000_000_000 }, session: owner })).status, 400);
  assert.equal((await state(owner)).contributions.find(item => item.id === first.id).amount, 1500);
  assert.equal((await request(`/goals/${goal.id}/initial-savings`, { method: 'DELETE', session: member })).status, 200);
  let current = await state(owner);
  assert.equal(current.goals.find(item => item.id === goal.id).saved, 4500);
  assert.equal(current.goals.find(item => item.id === goal.id).initial_saved, 0);
  assert.equal((await request(`/goals/${goal.id}/contributions/${second.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await request(`/goals/${goal.id}/contributions/${second.id}`, { method: 'DELETE', session: owner })).status, 404);
  assert.equal((await request(`/goals/${goal.id}/initial-savings`, { method: 'PUT', body: { amount: 700 }, session: owner })).status, 200);
  assert.equal((await request(path, { method: 'DELETE', session: member })).status, 200);
  current = await state(owner);
  assert.equal(current.goals.find(item => item.id === goal.id).saved, 700);
  assert.equal(current.goals.find(item => item.id === goal.id).initial_saved, 700);
  assert.equal(current.goals.find(item => item.id === other.id).saved, 1500);
  assert.equal(current.transactions.length, 0);
  assert.equal(current.contributions.filter(item => item.goal_id === goal.id).length, 0);
  const exported = await request('/backups/export', { session: owner });
  const payload = JSON.parse(Buffer.from(unzipSync(new Uint8Array(await exported.arrayBuffer()))['casa.json']));
  assert.equal(payload.data.goals.find(item => item.id === goal.id).saved, 700);
  assert.equal(payload.data.contributions.length, 1);
});

test('shared notes support pinning, editing and private attachments with deletion cleanup', async () => {
  const owner = await register(); const other = await register('eve@example.it');
  const note = await create('/notes', { title: 'Documenti', content: 'Per le vacanze', color: 'mint', pinned: true }, owner);
  const form = new FormData(); form.append('file', new Blob(['contenuto del documento'], { type: 'text/plain' }), 'viaggio.txt');
  const attachment = await create(`/notes/${note.id}/attachments`, form, owner);
  const file = await request(`/attachments/${attachment.id}`, { session: owner });
  assert.equal(file.status, 200); assert.equal(await file.text(), 'contenuto del documento');
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request(`/attachments/${attachment.id}`, { session: other })).status, 404);
  assert.equal((await request(`/attachments/${attachment.id}`)).status, 401);
  let current = await state(owner); assert.equal(current.notes[0].attachments.length, 1);
  assert.equal('storage_name' in current.notes[0].attachments[0], false);
  assert.equal((await request(`/notes/${note.id}/pin`, { method: 'PATCH', body: { pinned: false }, session: owner })).status, 200);
  assert.equal((await request(`/notes/${note.id}`, { method: 'PUT', body: { title: 'Nuovo titolo', content: 'Nuovo testo', color: 'blue', pinned: false }, session: owner })).status, 200);
  current = await state(owner); assert.equal(current.notes[0].title, 'Nuovo titolo'); assert.equal(current.notes[0].pinned, 0);
  assert.equal(readFileSync(path.join(dataDir, 'uploads', attachment.id), 'utf8'), 'contenuto del documento');
  assert.equal((await request(`/notes/${note.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.throws(() => readFileSync(path.join(dataDir, 'uploads', attachment.id)));
  assert.equal((await request(`/attachments/${attachment.id}`, { session: owner })).status, 404);
});

test('attachment size and per-note count limits reject uploads without changing existing files', async () => {
  const owner = await register(); const note = await create('/notes', { title: 'Allegati', content: '', color: 'amber', pinned: false }, owner);
  const big = new FormData(); big.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'grande.bin');
  assert.equal((await request(`/notes/${note.id}/attachments`, { method: 'POST', body: big, session: owner })).status, 400);
  for (let i = 0; i < 5; i++) { const form = new FormData(); form.append('file', new Blob(['test']), `${i}.txt`); await create(`/notes/${note.id}/attachments`, form, owner); }
  const sixth = new FormData(); sixth.append('file', new Blob(['test']), '6.txt');
  assert.equal((await request(`/notes/${note.id}/attachments`, { method: 'POST', body: sixth, session: owner })).status, 400);
  assert.equal((await state(owner)).notes[0].attachments.length, 5);
});

test('CSV export includes all months, escapes delimiters and neutralizes spreadsheet formulas', async () => {
  const owner = await register();
  await create('/transactions', { kind: 'income', amount: 12345, description: '=SUM(1;2) "test"', date: '2026-09-01' }, owner);
  const response = await request('/export', { session: owner }); assert.equal(response.status, 200);
  const csv = await response.text(); assert.match(csv, /2026-09-01/); assert.match(csv, /123,45/); assert.match(csv, /'=SUM\(1;2\) ""test""/);
});

test('database, saved data and session survive closing and reopening the application', async () => {
  const owner = await register(); await create('/shopping', { name: 'Pane', section: 'Dispensa', quantity: '1' }, owner);
  await new Promise(resolve => server.close(resolve)); instance.close();
  instance = createApp({ dataDir }); server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/api`;
  const restored = await state(owner); assert.equal(restored.shopping[0].name, 'Pane'); assert.equal(restored.household.name, 'Casa Rossi');
});

test('recurring bills clamp the due day and recording payment creates exactly one linked expense', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const bill = await create('/bills', { name: 'Internet', amount: 2990, categoryId, dueDay: 31, startMonth: '2026-01', reminderDays: 3 }, owner);
  assert.equal((await state(owner, '2026-02')).bills[0].due_date, '2026-02-28');
  assert.equal((await state(owner, '2028-02')).bills[0].due_date, '2028-02-29');
  assert.equal((await state(owner, '2025-12')).bills.length, 0);
  assert.equal((await state(owner)).transactions.length, 0);
  const responses = await Promise.all([1, 2].map(() => request(`/bills/${bill.id}/payments`, { method: 'POST', session: owner, body: { month: '2026-10', amount: 3000, paymentDate: '2026-10-30' } })));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  let current = await state(owner); assert.equal(current.transactions.length, 1); assert.equal(current.transactions[0].amount, 3000);
  assert.equal(current.bills[0].payment.amount, 3000);
  const tx = current.transactions[0];
  assert.equal((await request(`/transactions/${tx.id}`, { method: 'PUT', session: owner, body: { kind: 'income', amount: 3000, description: 'Wrong', date: '2026-10-30' } })).status, 400);
  assert.equal((await request(`/transactions/${tx.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).bills[0].payment, null);
  await create(`/bills/${bill.id}/payments`, { month: '2026-10', amount: 3000, paymentDate: '2026-10-30' }, owner);
  assert.equal((await request(`/bills/${bill.id}/payments/2026-10`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).transactions.length, 0);
});

test('bill edits preserve receipts, archives preserve paid history and access remains scoped', async () => {
  const owner = await register(); const other = await register('eve@example.it'); const categoryId = (await state(owner)).categories[0].id;
  const input = { name: 'Affitto', amount: 80000, categoryId, dueDay: 5, startMonth: '2026-01', reminderDays: 5 };
  const bill = await create('/bills', input, owner);
  await create(`/bills/${bill.id}/payments`, { month: '2026-10', amount: 80000, paymentDate: '2026-10-05' }, owner);
  assert.equal((await request(`/bills/${bill.id}`, { method: 'PUT', session: owner, body: { ...input, amount: 90000, dueDay: 10 } })).status, 200);
  assert.equal((await state(owner)).bills[0].payment.amount, 80000);
  assert.equal((await state(owner)).bills[0].due_date, '2026-10-05');
  assert.equal((await request(`/bills/${bill.id}/payments`, { method: 'POST', session: other, body: { month: '2026-11', amount: 90000, paymentDate: '2026-11-10' } })).status, 404);
  assert.equal((await state(other)).bills.length, 0);
  assert.equal((await request('/bills', { method: 'POST', session: owner, body: { ...input, dueDay: 32 } })).status, 400);
  assert.equal((await request(`/bills/${bill.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).bills.length, 1); assert.equal((await state(owner)).transactions.length, 1);
  assert.equal((await state(owner, '2026-11')).bills.length, 0);
});

test('weekly meals enforce one lunch and dinner per day and preserve checked shopping on edits', async () => {
  const owner = await register(); const other = await register('eve@example.it');
  const input = { date: '2026-10-05', slot: 'dinner', title: 'Pasta al pomodoro', servings: 3, notes: 'Preparare il sugo', ingredients: [{ name: 'Pasta', quantity: '300 g', section: 'Dispensa' }, { name: 'Pomodori', quantity: '500 g', section: 'Frutta e verdura' }] };
  const meal = await create('/meals', input, owner);
  assert.equal((await request('/meals', { method: 'POST', session: owner, body: input })).status, 409);
  assert.equal((await state(owner, '2026-10', '2026-10-12')).meals.length, 0);
  assert.equal((await state(other)).meals.length, 0);
  assert.equal((await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: other })).status, 404);
  let added = await (await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: owner })).json(); assert.equal(added.added, 2);
  added = await (await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: owner })).json(); assert.equal(added.added, 0);
  let current = await state(owner); assert.equal(current.shopping.length, 2);
  const pasta = current.shopping.find(s => s.name === 'Pasta');
  await request(`/shopping/${pasta.id}`, { method: 'PATCH', session: owner, body: { checked: true } });
  const recipe = current.meals[0]; recipe.ingredients[0].quantity = '400 g'; recipe.ingredients[1].quantity = '800 g';
  assert.equal((await request(`/meals/${meal.id}`, { method: 'PUT', session: owner, body: { ...input, ingredients: recipe.ingredients } })).status, 200);
  current = await state(owner); assert.equal(current.shopping.find(s => s.name === 'Pasta').quantity, '300 g'); assert.equal(current.shopping.find(s => s.name === 'Pomodori').quantity, '800 g');
  const tomatoes = current.shopping.find(s => s.name === 'Pomodori'); await request(`/shopping/${tomatoes.id}`, { method: 'DELETE', session: owner });
  added = await (await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: owner })).json(); assert.equal(added.added, 1);
  assert.equal((await request(`/meals/${meal.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).shopping.length, 2); assert.equal((await state(owner)).meals.length, 0);
  assert.equal((await request('/meals', { method: 'POST', session: owner, body: { ...input, servings: 0 } })).status, 400);
});

test('family ZIP backup contains owned data and attachments without credentials or other families', async () => {
  const owner = await register(); const other = await register('eve@example.it', { householdName: 'Spazio di un’altra famiglia' });
  const invitation = await (await request('/invitation', { method: 'POST', session: owner })).json();
  const member = await register('bob@example.it', { name: 'Bob', inviteCode: invitation.code });
  const note = await create('/notes', { title: 'Un documento', content: 'Test', color: 'mint', pinned: true }, owner);
  const form = new FormData(); form.append('file', new Blob(['allegato riservato']), 'documento.txt');
  const attachment = await create(`/notes/${note.id}/attachments`, form, owner);
  await create('/notes', { title: 'Segreto dell’altra famiglia', content: 'Contenuto isolato', color: 'mint', pinned: false }, other);
  const response = await request('/backups/export', { session: owner }); assert.equal(response.status, 200);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const jsonText = new TextDecoder().decode(archive['casa.json']); const payload = JSON.parse(jsonText);
  assert.equal(payload.household.id, owner.user.householdId); assert.equal(payload.data.notes.length, 1);
  assert.equal(new TextDecoder().decode(archive[`allegati/${attachment.id}`]), 'allegato riservato');
  for (const forbidden of ['password_hash', 'token_hash', 'invite_hash', 'csrf', 'Segreto dell’altra famiglia', 'eve@example.it']) assert.equal(jsonText.includes(forbidden), false);
  assert.equal((await request('/backups/export', { session: member })).status, 403);
  assert.equal((await request('/backups/export')).status, 401);
  assert.equal((await state(member)).backups, null);
});

test('automatic snapshots verify and restore database, new workflows and exact attachment bytes', async () => {
  const owner = await register();
  const note = await create('/notes', { title: 'Da conservare', content: 'Appunto', color: 'blue', pinned: true }, owner);
  const form = new FormData(); form.append('file', new Blob(['backup completo']), 'test.txt'); const attachment = await create(`/notes/${note.id}/attachments`, form, owner);
  await create('/meals', { title: 'Cena', date: '2026-10-05', slot: 'dinner', servings: 2, ingredients: [], notes: '' }, owner);
  const { directory } = createBackupManager({ db: instance.db, dataDir, backupDir: path.join(dataDir, 'test-backups'), enabled: true }).take();
  const verified = verifyInstanceBackup(directory); assert.equal(verified.files.length, 1);
  const restoredDir = path.join(dataDir, 'restored'); restoreInstanceBackup(directory, restoredDir);
  const restored = createApp({ dataDir: restoredDir });
  try {
    assert.equal(restored.db.prepare('SELECT title FROM notes').get().title, 'Da conservare');
    assert.equal(restored.db.prepare('SELECT title FROM meals').get().title, 'Cena');
    assert.equal(readFileSync(path.join(restoredDir, 'uploads', attachment.id), 'utf8'), 'backup completo');
    assert.equal(restored.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { restored.close(); }
  assert.throws(() => restoreInstanceBackup(directory, restoredDir), /esiste già/);
  writeFileSync(path.join(directory, 'uploads', attachment.id), 'alterato');
  assert.throws(() => verifyInstanceBackup(directory), /Integrità/);
  const rejectedDir = path.join(dataDir, 'should-not-exist'); assert.throws(() => restoreInstanceBackup(directory, rejectedDir)); assert.equal(existsSync(rejectedDir), false);
});

test('automatic backup scheduling resumes from history and retains only its last seven snapshots', async () => {
  const owner = await register(); await create('/shopping', { name: 'Pane', section: 'Dispensa', quantity: '1' }, owner);
  let timestamp = Date.UTC(2026, 9, 4); const backupDir = path.join(dataDir, 'history');
  const options = { db: instance.db, dataDir, backupDir, enabled: true, clock: () => timestamp };
  const manager = createBackupManager(options);
  manager.runIfDue(); const first = manager.status().lastAt; assert.ok(first);
  manager.runIfDue(); assert.equal(readdirSync(backupDir).length, 1);
  for (let day = 1; day <= 9; day++) { timestamp += 86400_000; manager.runIfDue(); }
  assert.equal(readdirSync(backupDir).length, 7);
  const resumed = createBackupManager(options); resumed.runIfDue(); assert.equal(readdirSync(backupDir).length, 7);
  assert.equal(resumed.status().nextAt, new Date(timestamp + 86400_000).toISOString());
  assert.equal(resumed.status().error, null); manager.stop(); resumed.stop();
});

test('a failed automatic backup is reported and preserves the live application data', async () => {
  const owner = await register(); await create('/shopping', { name: 'Dati da preservare', quantity: '1', section: 'Altro' }, owner);
  const blocked = path.join(dataDir, 'not-a-directory'); writeFileSync(blocked, 'file preesistente');
  const manager = createBackupManager({ db: instance.db, dataDir, backupDir: blocked, enabled: true });
  const originalError = console.error; console.error = () => {};
  try { manager.runIfDue(); }
  finally { console.error = originalError; }
  assert.ok(manager.status().error); assert.equal(manager.status().lastAt, null);
  assert.equal((await state(owner)).shopping[0].name, 'Dati da preservare');
  assert.equal(readFileSync(blocked, 'utf8'), 'file preesistente'); manager.stop();
});

const periodToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).format(new Date());
function periodShift(value, delta) { const [y,m] = value.split('-').map(Number); return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7); }

test('monthly income sources and expenses produce exact balances without duplicate occurrences', async () => {
  const owner = await register(); const current = periodToday(); const first = periodShift(current,-2);
  const categoryId = (await state(owner,current)).categories[0].id;
  await create('/recurring', { kind:'income', name:'Stipendio Sara', amount:210001, startMonth:first, day:31, enabled:true }, owner);
  await create('/recurring', { kind:'income', name:'Pensione', amount:90000, startMonth:current, day:1, enabled:true }, owner);
  await create('/recurring', { kind:'expense', name:'Affitto', amount:85000, categoryId, startMonth:first, day:1, enabled:true }, owner);
  const views = await Promise.all(Array.from({length:4},()=>state(owner,current)));
  for(const view of views) {
    assert.equal(view.transactions.length,3);
    assert.equal(view.transactions.reduce((sum,t)=>sum+(t.kind==='income'?t.amount:-t.amount),0),215001);
    assert.equal(view.recurring.length,3); assert.ok(view.transactions.every(t=>t.recurring_id));
  }
  const past = await state(owner,first); assert.equal(past.transactions.length,2);
  const [y,m] = first.split('-').map(Number); assert.equal(past.transactions.find(t=>t.kind==='income').date,`${first}-${new Date(Date.UTC(y,m,0)).getUTCDate()}`);
  const future=await state(owner,periodShift(current,2));assert.equal(future.transactions.length,3);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM recurring_occurrences').get().n,10);
});

test('dated recurring edits preserve history, manual adjustments and skipped monthly movements', async () => {
  const owner = await register(); const current=periodToday();const first=periodShift(current,-2);
  const rule = await create('/recurring',{kind:'income',name:'Stipendio',amount:100000,day:5,startMonth:first,enabled:true},owner);
  const currentRecord=(await state(owner,current)).transactions[0];
  assert.equal((await request(`/transactions/${currentRecord.id}`,{method:'PUT',session:owner,body:{kind:'income',description:'Premio + stipendio',amount:120000,date:`${current}-05`}})).status,200);
  assert.equal((await request(`/recurring/${rule.id}`,{method:'PUT',session:owner,body:{name:'Stipendio aggiornato',amount:110000,day:8,effectiveMonth:periodShift(current,-1),enabled:true}})).status,200);
  assert.equal((await state(owner,first)).transactions[0].amount,100000);
  assert.equal((await state(owner,periodShift(current,-1))).transactions[0].amount,110000);
  assert.equal((await state(owner,current)).transactions[0].amount,120000);
  const futureMonth=periodShift(current,1);const future=(await state(owner,futureMonth)).transactions[0];
  assert.equal(future.amount,110000);
  await request(`/transactions/${future.id}`,{method:'DELETE',session:owner});
  assert.equal((await state(owner,futureMonth)).transactions.length,0);
  assert.equal((await state(owner,futureMonth)).transactions.length,0);
  await request(`/recurring/${rule.id}/stop`,{method:'POST',session:owner,body:{effectiveMonth:current}});
  assert.equal((await state(owner,current)).transactions[0].amount,120000);
  assert.equal((await state(owner,periodShift(current,2))).transactions.length,0);
  // Resuming a source still must not resurrect a manually skipped month.
  await request(`/recurring/${rule.id}`,{method:'PUT',session:owner,body:{name:'Ripresa',amount:130000,day:1,effectiveMonth:futureMonth,enabled:true}});
  assert.equal((await state(owner,futureMonth)).transactions.length,0);
  assert.equal((await state(owner,periodShift(current,2))).transactions[0].amount,130000);
});

test('recurring records validate dates, categories and family ownership and stop automatic costs', async () => {
  const owner=await register();const stranger=await register('other@example.it');const current=periodToday();
  const categoryId=(await state(owner,current)).categories[0].id;
  const body={kind:'expense',name:'Bollette',amount:10001,categoryId,day:1,startMonth:current,enabled:true};
  const rule=await create('/recurring',body,owner);
  assert.equal((await request(`/recurring/${rule.id}`,{method:'PUT',session:stranger,body:{...body,effectiveMonth:current}})).status,404);
  assert.equal((await request('/recurring',{method:'POST',session:stranger,body})).status,404);
  for(const change of [{day:32},{amount:0},{endMonth:periodShift(current,-1)},{enabled:'yes'},{startMonth:'bad'},{amount:1.1}])assert.equal((await request('/recurring',{method:'POST',session:owner,body:{...body,...change}})).status,400);
  const movement=(await state(owner,current)).transactions[0];
  assert.equal((await request(`/transactions/${movement.id}`,{method:'PUT',session:owner,body:{kind:'income',description:'No',amount:10,date:`${current}-01`}})).status,400);
  await request(`/recurring/${rule.id}/stop`,{method:'POST',session:owner,body:{effectiveMonth:current}});
  assert.equal((await state(owner,current)).transactions.length,0);
  assert.equal((await state(stranger,current)).recurring.length,0);
});

test('budget presets stay fixed, custom remains editable and applying presets preserves the custom schema', async () => {
  const owner=await register();const stranger=await register('other@example.it');let view=await state(owner);
  assert.equal(view.budgetTemplates.length,5); assert.equal(view.budgetTemplates.some(t=>t.template_key==='50-30-20'),false);
  for(const t of view.budgetTemplates)assert.equal(t.entries.reduce((sum,e)=>sum+e.percentage,0),10000);
  const custom=view.budgetTemplates.find(t=>t.template_key==='custom');const conservative=view.budgetTemplates.find(t=>t.template_key==='conservative');
  const customEntries=custom.entries.map((e,i)=>({...e,name:i===0?'La nostra casa':e.name,percentage:[4000,2000,1000,1000,1000,1000][i]}));
  assert.equal((await request(`/budget-templates/${custom.id}`,{method:'PUT',session:owner,body:{entries:customEntries}})).status,200);
  const changed=conservative.entries.map((e,i)=>({...e,percentage:[2000,1500,1000,500,500,4500][i]}));
  assert.equal((await request(`/budget-templates/${conservative.id}`,{method:'PUT',session:owner,body:{entries:changed}})).status,403);
  assert.equal((await request(`/budget-templates/${conservative.id}/apply`,{method:'POST',session:stranger})).status,404);
  assert.equal((await request(`/budget-templates/${custom.id}`,{method:'PUT',session:owner,body:{entries:changed.map(e=>({...e,percentage:100}))}})).status,400);
  const previousCategories=view.categories;
  // Previously edited presets become factory defaults without overwriting the active budget.
  instance.db.prepare('UPDATE budget_templates SET entries = ? WHERE id = ?').run(JSON.stringify(changed),conservative.id);
  view=await state(owner);assert.deepEqual(view.categories,previousCategories);
  assert.deepEqual(view.budgetTemplates.find(t=>t.id===conservative.id).entries,conservative.entries);
  assert.equal((await request(`/budget-templates/${conservative.id}/apply`,{method:'POST',session:owner})).status,200);
  view=await state(owner);assert.deepEqual(view.categories.map(c=>c.percentage),[3000,1500,1000,500,500,3500]);
  assert.deepEqual(view.budgetTemplates.find(t=>t.template_key==='custom').entries,customEntries);
  assert.equal((await request(`/budget-templates/${custom.id}/apply`,{method:'POST',session:owner})).status,200);
  view=await state(owner);assert.equal(view.categories[0].name,'La nostra casa');assert.equal(view.categories[0].percentage,4000);
  await request('/budget-templates/reset',{method:'POST',session:owner});view=await state(owner);
  assert.deepEqual(view.budgetTemplates.find(t=>t.template_key==='custom').entries,customEntries);assert.equal(view.activeTemplateId,custom.id);
  const exported=await request('/backups/export',{session:owner});const zip=unzipSync(new Uint8Array(await exported.arrayBuffer()));const payload=JSON.parse(Buffer.from(zip['casa.json']));
  assert.equal(payload.data.budget_templates.length,5);assert.equal(payload.data.recurring_versions.length,0);
});

test('waste schedules support multiple days, validation, family sharing and private backup exports', async () => {
  const owner = await register(); const invitation = await (await request('/invitation', { method:'POST', session:owner })).json();
  const member = await register('waste-member@example.it', { inviteCode:invitation.code }); const stranger = await register('waste-stranger@example.it');
  const body = { name:'Organico', days:[6,0,2], timeWindow:'20:00–22:00', notes:'Sacchetti compostabili', color:'#176854' };
  const schedule = await create('/waste', body, owner);
  assert.deepEqual((await state(member)).waste[0].days,[0,2,6]);
  assert.equal((await state(stranger)).waste.length,0);
  assert.equal((await request(`/waste/${schedule.id}`,{method:'PUT',session:stranger,body})).status,404);
  assert.equal((await request(`/waste/${schedule.id}`,{method:'DELETE',session:stranger})).status,404);
  for(const days of [[],[7],[-1],[0,0],[1.5],['1'],null]) assert.equal((await request('/waste',{method:'POST',session:owner,body:{...body,days}})).status,400);
  assert.equal((await request('/waste',{method:'POST',session:owner,body:{...body,color:'invalid'}})).status,400);
  assert.equal((await request('/waste',{method:'POST',session:owner,body:{...body,name:' '}})).status,400);
  assert.equal((await request(`/waste/${schedule.id}`,{method:'PUT',session:member,body:{...body,name:'Carta',days:[1,4],timeWindow:'Entro le 6:00',notes:''}})).status,200);
  const changed=(await state(owner)).waste[0];assert.equal(changed.name,'Carta');assert.deepEqual(changed.days,[1,4]);assert.equal(changed.time_window,'Entro le 6:00');
  const exported=await request('/backups/export',{session:owner});const zip=unzipSync(new Uint8Array(await exported.arrayBuffer()));const payload=JSON.parse(Buffer.from(zip['casa.json']));
  assert.equal(payload.data.waste_schedules.length,1);assert.equal(payload.data.waste_schedules[0].name,'Carta');
  assert.equal((await request(`/waste/${schedule.id}`,{method:'DELETE',session:member})).status,200);assert.equal((await state(owner)).waste.length,0);
});

test('the family calendar validates events, shares them only with the family and follows member removal', async () => {
  const owner = await register(); const invitation = await (await request('/invitation', { method:'POST', session:owner })).json();
  const member = await register('calendar-member@example.it', { inviteCode:invitation.code }); const stranger = await register('calendar-stranger@example.it');
  const body = { title:'Colloquio a scuola', startDate:'2026-10-20', startTime:'17:00', endTime:'18:00', recurrence:'none', location:'Scuola Verdi', notes:'Portare la pagella', personal:false };
  const created = await create('/calendar', body, member);
  const shared = await state(owner);
  assert.equal(shared.calendar.length,1); assert.equal(shared.calendar[0].end_date,'2026-10-20'); assert.equal(shared.calendar[0].author,'Alice'); assert.equal(shared.calendar[0].owner_id,null); assert.equal('household_id' in shared.calendar[0],false);
  assert.equal((await state(stranger)).calendar.length,0);
  assert.equal((await request(`/calendar/${created.id}`,{method:'PUT',session:stranger,body})).status,404);
  assert.equal((await request(`/calendar/${created.id}`,{method:'DELETE',session:stranger})).status,404);
  for (const invalid of [{title:' '},{startDate:'2026-02-30'},{endDate:'2026-10-19'},{startTime:'25:00'},{endTime:'16:00'},{startTime:'',endTime:'18:00'},{recurrence:'daily'},{personal:'yes'},
    {endDate:'2026-12-31'},{recurrence:'weekly',endDate:'2026-10-27'},{recurrence:'monthly',recurrenceUntil:'2026-10-01'}])
    assert.equal((await request('/calendar',{method:'POST',session:owner,body:{...body,...invalid}})).status,400,JSON.stringify(invalid));
  // Members get distinct colours; each changes only their own.
  const colors = shared.calendarColors; assert.equal(Object.keys(colors).length,2); assert.notEqual(colors[owner.user.id],colors[member.user.id]);
  assert.equal((await request('/calendar/color',{method:'PUT',session:owner,body:{color:colors[member.user.id]}})).status,409);
  assert.equal((await request('/calendar/color',{method:'PUT',session:owner,body:{color:'#000000'}})).status,400);
  assert.equal((await request('/calendar/color',{method:'PUT',session:owner,body:{color:'#d1495b'}})).status,200);
  assert.equal((await state(member)).calendarColors[owner.user.id],'#d1495b');
  // A personal event stays its member's when someone else edits it.
  assert.equal((await request(`/calendar/${created.id}`,{method:'PUT',session:member,body:{...body,personal:true}})).status,200);
  assert.equal((await request(`/calendar/${created.id}`,{method:'PUT',session:owner,body:{...body,title:'Colloquio',personal:true}})).status,200);
  assert.equal((await state(owner)).calendar[0].owner_id,member.user.id);
  assert.equal((await request(`/calendar/${created.id}`,{method:'PUT',session:owner,body:{...body,title:'Compleanno della nonna',startDate:'2026-10-25',startTime:'',endTime:'',recurrence:'yearly',recurrenceUntil:'',location:'',notes:'',personal:true}})).status,200);
  const changed=(await state(member)).calendar[0];
  assert.deepEqual([changed.title,changed.start_date,changed.start_time,changed.recurrence,changed.recurrence_until,changed.owner_id],['Compleanno della nonna','2026-10-25','','yearly',null,member.user.id]);
  const exported=await request('/backups/export',{session:owner});const zip=unzipSync(new Uint8Array(await exported.arrayBuffer()));const payload=JSON.parse(Buffer.from(zip['casa.json']));
  assert.equal(payload.data.calendar_events.length,1);assert.equal(payload.data.calendar_owners.length,1);assert.equal(payload.data.member_colors.length,2);
  assert.equal((await request(`/members/${member.user.id}`,{method:'DELETE',session:owner,body:{currentPassword:'password-test-123'}})).status,200);
  const kept=(await state(owner)).calendar[0]; assert.equal(kept.title,'Compleanno della nonna','the member’s events stay with the family'); assert.equal(kept.owner_id,null);
  assert.equal((await request(`/calendar/${created.id}`,{method:'DELETE',session:owner})).status,200);assert.equal((await state(owner)).calendar.length,0);
});

test('a repeating event loses one occurrence or the following ones', async () => {
  const owner = await register(); const stranger = await register('calendar-other@example.it');
  const weekly = await create('/calendar', { title:'Calcetto', startDate:'2026-10-06', recurrence:'weekly', personal:false }, owner);
  const remove = (id, body, session = owner) => request(`/calendar/${id}`,{method:'DELETE',session,body});
  assert.equal((await remove(weekly.id,{scope:'one',date:'2026-10-14'})).status,400,'not an occurrence');
  assert.equal((await remove(weekly.id,{scope:'sometimes',date:'2026-10-13'})).status,400);
  assert.equal((await remove(weekly.id,{scope:'one',date:'2026-10-13'},stranger)).status,404);
  assert.equal((await remove(weekly.id,{scope:'one',date:'2026-10-13'})).status,200);
  let event=(await state(owner)).calendar[0]; assert.deepEqual(event.skipped,['2026-10-13']);
  assert.equal((await remove(weekly.id,{scope:'one',date:'2026-10-13'})).status,400,'already removed');
  assert.equal((await remove(weekly.id,{scope:'following',date:'2026-10-27'})).status,200);
  event=(await state(owner)).calendar[0]; assert.equal(event.recurrence_until,'2026-10-26'); assert.deepEqual(event.skipped,['2026-10-13']);
  assert.equal((await remove(weekly.id,{scope:'one',date:'2026-10-06'})).status,200);
  event=(await state(owner)).calendar[0]; assert.deepEqual([event.start_date,event.skipped.sort()],['2026-10-06',['2026-10-06','2026-10-13']]);
  assert.equal((await remove(weekly.id,{scope:'following',date:'2026-10-20'})).status,200,'from the first remaining occurrence on removes the series');
  assert.equal((await state(owner)).calendar.length,0);
});

test('deadlines support optional payments, safe undo, expense deletion and family isolation', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const stranger = await register('stranger@example.it');
  const free = await create('/deadlines', { name: 'Rinnovo documento', startDate: '2026-10-14', frequency: 'once', requiresPayment: false, reminderDays: 3, amount: 9000, categoryId }, owner);
  let deadline = (await state(owner)).deadlines[0]; assert.equal(deadline.amount, null); assert.equal(deadline.category_id, null);
  const handled = await create(`/deadlines/${free.id}/manage`, { month: '2026-10', handledDate: '2026-10-14', amount: 9000 }, owner);
  assert.equal(handled.transactionId, null); assert.equal((await state(owner)).transactions.length, 0);
  assert.ok((await state(owner)).deadlines[0].managed);
  assert.equal((await request(`/deadlines/${free.id}/manage`, { method: 'POST', body: { month: '2026-10', handledDate: '2026-10-14' }, session: owner })).status, 409);
  assert.equal((await request(`/deadlines/${free.id}/manage/2026-10`, { method: 'DELETE', session: stranger })).status, 404);
  assert.equal((await state(stranger)).deadlines.length, 0);
  assert.equal((await request(`/deadlines/${free.id}/manage/2026-10`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).deadlines[0].managed, null);
  assert.equal((await state(owner, '2026-11')).deadlines.length, 0);
  const paid = await create('/deadlines', { name: 'Revisione auto', startDate: '2026-10-31', frequency: 'monthly', dueDay: 31, requiresPayment: true, amount: 7990, categoryId, reminderDays: 3 }, owner);
  assert.equal((await request(`/deadlines/${paid.id}/manage`, { method: 'POST', body: { month: '2026-10', handledDate: '2026-10-14', amount: 0 }, session: owner })).status, 400);
  assert.equal((await state(owner)).deadlines.find(d => d.id === paid.id).managed, null);
  const payments = await Promise.all([1,2].map(() => request(`/deadlines/${paid.id}/manage`, { method: 'POST', body: { month: '2026-10', handledDate: '2026-11-02', amount: 8000 }, session: owner })));
  assert.deepEqual(payments.map(p => p.status).sort(), [201,409]);
  const transactionId = (await payments.find(p => p.status === 201).json()).transactionId;
  assert.equal((await state(owner)).transactions.length, 0);
  assert.equal((await state(owner, '2026-11')).transactions[0].amount, 8000);
  assert.equal((await state(owner)).deadlines.find(d => d.id === paid.id).managed.amount, 8000);
  assert.equal((await request(`/transactions/${transactionId}`, { method: 'PUT', body: { kind: 'income', amount: 8000, description: 'No', date: '2026-11-02' }, session: owner })).status, 400);
  assert.equal((await request(`/deadlines/${paid.id}/manage/2026-10`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner, '2026-11')).transactions.length, 0);
  const again = await create(`/deadlines/${paid.id}/manage`, { month: '2026-10', handledDate: '2026-10-30' }, owner);
  assert.equal((await request(`/transactions/${again.transactionId}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).deadlines.find(d => d.id === paid.id).managed, null);
  assert.equal((await request(`/deadlines/${paid.id}`, { method: 'DELETE', session: owner })).status, 200);
  assert.equal((await state(owner)).deadlines.some(d => d.id === paid.id), false);
});

test('deadlines validate payment data, clamp recurring dates and preserve managed history on edits', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const stranger = await register('elsewhere@example.it'); const otherCategory = (await state(stranger)).categories[0].id;
  const input = { name: 'Rinnovo', startDate: '2028-02-29', frequency: 'yearly', requiresPayment: true, amount: 1000, categoryId, reminderDays: 3 };
  for (const change of [{ amount: 0 }, { amount: 1.5 }, { startDate: '2028-02-30' }, { reminderDays: 31 }, { frequency: 'weekly' }, { requiresPayment: 'false' }]) {
    assert.equal((await request('/deadlines', { method: 'POST', body: { ...input, ...change }, session: owner })).status, 400);
  }
  assert.equal((await request('/deadlines', { method: 'POST', body: { ...input, categoryId: otherCategory }, session: owner })).status, 404);
  const annual = await create('/deadlines', input, owner);
  assert.equal((await state(owner, '2027-02')).deadlines.length, 0);
  assert.equal((await state(owner, '2029-03')).deadlines.length, 0);
  assert.equal((await state(owner, '2029-02')).deadlines[0].due_date, '2029-02-28');
  const payment = await create(`/deadlines/${annual.id}/manage`, { month: '2029-02', handledDate: '2029-02-28' }, owner);
  assert.equal((await request(`/deadlines/${annual.id}`, { method: 'PUT', body: { ...input, requiresPayment: false, startDate: '2029-03-01' }, session: owner })).status, 200);
  const history = (await state(owner, '2029-02')).deadlines[0]; assert.equal(history.due_date, '2029-02-28'); assert.equal(history.managed.amount, 1000);
  assert.equal(history.managed.transaction_id, payment.transactionId); assert.equal(history.managed.category_id, categoryId);
  assert.equal((await request(`/deadlines/${annual.id}/manage`, { method: 'POST', body: { month: '2029-04', handledDate: '2029-04-01' }, session: owner })).status, 400);
});

test('existing bills migrate once without duplicating expenses or resurrecting undone receipts', async () => {
  const owner = await register(); const categoryId = instance.db.prepare('SELECT id FROM categories WHERE household_id = ? ORDER BY position').get(owner.user.householdId).id;
  const bill = await create('/bills', { name: 'Storica', amount: 2500, categoryId, dueDay: 31, startMonth: '2026-02', reminderDays: 3 }, owner);
  const payment = await create(`/bills/${bill.id}/payments`, { month: '2026-10', paymentDate: '2026-10-30', amount: 2490 }, owner);
  // Simulate a pre-upgrade database containing only the legacy record/receipt.
  instance.db.prepare('DELETE FROM deadline_receipts WHERE deadline_id = ?').run(bill.id);
  instance.db.prepare('DELETE FROM deadlines WHERE id = ?').run(bill.id);
  let current = await state(owner); assert.equal(current.deadlines.length, 1); assert.equal(current.transactions.length, 1);
  assert.equal(current.deadlines[0].managed.transaction_id, payment.transactionId);
  assert.equal(current.deadlines[0].start_date, '2026-02-28'); assert.equal(current.deadlines[0].due_day, 31);
  assert.equal((await state(owner, '2026-03')).deadlines[0].due_date, '2026-03-31');
  const exported = await request('/backups/export', { session: owner });
  const zip = unzipSync(new Uint8Array(await exported.arrayBuffer())); const data = JSON.parse(Buffer.from(zip['casa.json'])).data;
  assert.equal(data.deadlines.length, 1); assert.equal(data.deadline_receipts[0].transaction_id, payment.transactionId);
  assert.equal((await request(`/deadlines/${bill.id}/manage/2026-10`, { method: 'DELETE', session: owner })).status, 200);
  current = await state(owner); assert.equal(current.deadlines[0].managed, null); assert.equal(current.transactions.length, 0);
  assert.equal((await state(owner)).deadlines[0].managed, null);
});

test('old and new browser tabs share deadline writes and cannot record the same payment twice', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const input = { name:'Scheda precedente', amount:2500, categoryId, dueDay:31, startMonth:'2026-10', reminderDays:3 };
  const legacy = await create('/bills', input, owner);
  assert.equal((await state(owner)).deadlines[0].id,legacy.id);
  assert.equal((await request(`/bills/${legacy.id}`,{method:'PUT',body:{...input, amount:2600},session:owner})).status,200);
  assert.equal((await state(owner)).deadlines[0].amount,2600);
  await create(`/deadlines/${legacy.id}/manage`,{month:'2026-10',handledDate:'2026-10-31'},owner);
  assert.equal((await request(`/bills/${legacy.id}/payments`,{method:'POST',body:{month:'2026-10',paymentDate:'2026-10-31',amount:2600},session:owner})).status,409);
  assert.equal((await state(owner)).transactions.length,1);
  assert.equal((await request(`/deadlines/${legacy.id}/manage/2026-10`,{method:'DELETE',session:owner})).status,200);
  const oldPayment = await create(`/bills/${legacy.id}/payments`,{month:'2026-10',paymentDate:'2026-10-31',amount:2700},owner);
  assert.equal((await state(owner)).deadlines[0].managed.transaction_id,oldPayment.transactionId);
  assert.equal((await request(`/deadlines/${legacy.id}/manage`,{method:'POST',body:{month:'2026-10',handledDate:'2026-10-31'},session:owner})).status,409);
  assert.equal((await request(`/bills/${legacy.id}/payments/2026-10`,{method:'DELETE',session:owner})).status,200);
  assert.equal((await state(owner)).deadlines[0].managed,null);
  assert.equal((await request(`/bills/${legacy.id}`,{method:'DELETE',session:owner})).status,200);
  assert.equal((await state(owner)).deadlines.length,0);
});

test('account and household settings update only the authenticated user and authorized family', async () => {
  const owner = await register(); const stranger = await register('stranger@example.it');
  const invitation = await (await request('/invitation', { method:'POST',session:owner })).json();
  const member = await register('member@example.it', { inviteCode:invitation.code });
  const profile = await request('/account',{method:'PUT',session:owner,body:{name:'Giuseppe Catalano',email:'alice@example.it',id:stranger.user.id}});
  assert.equal(profile.status,200);assert.equal((await profile.json()).user.name,'Giuseppe Catalano');
  assert.equal((await (await request('/session',{session:owner})).json()).user.name,'Giuseppe Catalano');
  assert.equal((await (await request('/session',{session:stranger})).json()).user.name,'Alice');
  assert.equal((await request('/household',{method:'PUT',session:member,body:{name:'Non autorizzata'}})).status,403);
  assert.equal((await request('/household',{method:'PUT',session:owner,body:{name:'Casa Catalano',id:stranger.user.householdId}})).status,200);
  assert.equal((await state(member)).household.name,'Casa Catalano');assert.equal((await state(stranger)).household.name,'Casa Rossi');
  assert.equal((await request('/account',{method:'PUT',session:owner,body:{name:'',email:'alice@example.it'}})).status,400);
  assert.equal((await request('/household',{method:'PUT',session:owner,body:{name:' '}})).status,400);
});

test('email and password changes require the current password and revoke other sessions', async () => {
  const owner = await register();await register('taken@example.it');
  const login = async email => { const response=await request('/auth/login',{method:'POST',body:{email,password:'password-test-123'}});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf}; };
  let other = await login('alice@example.it');
  const body = {name:'Alice',email:'updated@example.it'};
  assert.equal((await request('/account',{method:'PUT',session:owner,body})).status,400);
  assert.equal((await request('/account',{method:'PUT',session:owner,body:{...body,currentPassword:'incorrect'}})).status,400);
  assert.equal((await request('/account',{method:'PUT',session:owner,body:{...body,email:'taken@example.it',currentPassword:'password-test-123'}})).status,409);
  assert.equal((await request('/account',{method:'PUT',session:owner,body:{...body,currentPassword:'password-test-123'}})).status,200);
  assert.equal((await request('/state?month=2026-10',{session:other})).status,401);
  other = await login('updated@example.it');
  assert.equal((await request('/account/password',{method:'PUT',session:owner,body:{currentPassword:'wrong',newPassword:'new-password-456'}})).status,400);
  assert.equal((await request('/account/password',{method:'PUT',session:owner,body:{currentPassword:'password-test-123',newPassword:'short'}})).status,400);
  assert.equal((await request('/account/password',{method:'PUT',session:owner,body:{currentPassword:'password-test-123',newPassword:'new-password-456'}})).status,200);
  assert.equal((await request('/state?month=2026-10',{session:other})).status,401);assert.equal((await request('/state?month=2026-10',{session:owner})).status,200);
  assert.equal((await request('/auth/login',{method:'POST',body:{email:'updated@example.it',password:'password-test-123'}})).status,401);
  assert.equal((await request('/auth/login',{method:'POST',body:{email:'updated@example.it',password:'new-password-456'}})).status,200);
});

test('deleting mistaken recurring rules removes their history and occurrences without affecting other records', async () => {
  const owner=await register();const stranger=await register('stranger@example.it');const categoryId=(await state(owner)).categories[0].id;
  const rule=await create('/recurring',{kind:'expense',name:'Errore',amount:1000,day:1,startMonth:'2026-09',categoryId,enabled:true},owner);
  const occasional=await create('/transactions',{kind:'expense',description:'Da conservare',amount:500,categoryId,date:'2026-10-05'},owner);
  await state(owner,'2026-11');
  const transaction=(await state(owner)).transactions.find(t=>t.recurring_id===rule.id);
  await request(`/transactions/${transaction.id}`,{method:'PUT',session:owner,body:{kind:'expense',description:'Correzione',amount:1200,categoryId,date:'2026-10-05'}});
  assert.equal((await request(`/recurring/${rule.id}`,{method:'DELETE',session:stranger})).status,404);
  assert.equal((await request(`/recurring/${rule.id}`,{method:'DELETE',session:owner})).status,200);
  const view=await state(owner);assert.equal(view.recurring.length,0);assert.deepEqual(view.transactions.map(t=>t.id),[occasional.id]);
  assert.equal((await state(owner,'2026-09')).transactions.length,0);assert.equal((await state(owner,'2026-11')).transactions.length,0);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM recurring_versions').get().count,0);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM recurring_occurrences').get().count,0);
  assert.equal((await request(`/recurring/${rule.id}`,{method:'DELETE',session:owner})).status,404);
});

test('quarterly and semiannual deadlines repeat from the starting month and old databases accept them', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const input = { name: 'Condominio', startDate: '2026-11-30', frequency: 'quarterly', requiresPayment: true, amount: 15000, categoryId, reminderDays: 3 };
  const quarterly = await create('/deadlines', input, owner);
  const semiannual = await create('/deadlines', { ...input, name: 'Assicurazione casa', frequency: 'semiannual' }, owner);
  const due = async period => Object.fromEntries((await state(owner, period)).deadlines.map(d => [d.name, d.due_date]));
  assert.deepEqual(await due('2026-10'), {});
  assert.deepEqual(await due('2026-11'), { 'Assicurazione casa': '2026-11-30', Condominio: '2026-11-30' });
  assert.deepEqual(await due('2027-02'), { Condominio: '2027-02-28' });
  assert.deepEqual(await due('2027-03'), {});
  assert.deepEqual(await due('2027-05'), { 'Assicurazione casa': '2027-05-30', Condominio: '2027-05-30' });
  assert.deepEqual(await due('2027-08'), { Condominio: '2027-08-30' });
  assert.equal((await create(`/deadlines/${quarterly.id}/manage`, { month: '2027-02', handledDate: '2027-02-27' }, owner)).transactionId.length > 0, true);
  assert.equal((await request(`/deadlines/${semiannual.id}/manage`, { method: 'POST', body: { month: '2027-02', handledDate: '2027-02-27' }, session: owner })).status, 400);

  const once = await create('/deadlines', { ...input, name: 'Bollo', frequency: 'once' }, owner);
  const receipt = await create(`/deadlines/${once.id}/manage`, { month: '2026-11', handledDate: '2026-11-20' }, owner);
  // Recreate the table with the CHECK used before these frequencies existed, then restart.
  await new Promise(resolve => server.close(resolve)); instance.close();
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(path.join(dataDir, 'casa.sqlite'));
  const sql = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'deadlines'").get().sql;
  legacy.exec(`DELETE FROM deadline_receipts WHERE deadline_id IN ('${quarterly.id}', '${semiannual.id}'); DELETE FROM deadlines WHERE id IN ('${quarterly.id}', '${semiannual.id}')`);
  legacy.exec('PRAGMA foreign_keys = OFF');
  legacy.exec(`${sql.replace('CREATE TABLE deadlines', 'CREATE TABLE deadlines_old').replace("'once','monthly','quarterly','semiannual','yearly'", "'once','monthly','yearly'")};
    INSERT INTO deadlines_old SELECT * FROM deadlines; DROP TABLE deadlines; ALTER TABLE deadlines_old RENAME TO deadlines;`);
  assert.throws(() => legacy.prepare("UPDATE deadlines SET frequency = 'quarterly'").run(), /CHECK constraint/);
  legacy.close();
  instance = createApp({ dataDir }); server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const legacyQuarterly = await create('/deadlines', input, owner);
  assert.equal((await state(owner, '2027-02')).deadlines.find(d => d.id === legacyQuarterly.id).due_date, '2027-02-28');
  assert.deepEqual((await state(owner, '2026-11')).deadlines.map(d => d.name), ['Bollo', 'Condominio']);
  const migrated = new DatabaseSync(path.join(dataDir, 'casa.sqlite'), { readOnly: true });
  assert.equal(migrated.prepare('SELECT transaction_id FROM deadline_receipts').get().transaction_id, receipt.transactionId);
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  migrated.close();
});

test('the administrator removes a member with their password, keeping shared records in the family', async () => {
  const owner = await register(); const categoryId = (await state(owner)).categories[0].id;
  const invitation = await (await request('/invitation', { method: 'POST', session: owner })).json();
  const bob = await register('bob@example.it', { name: 'Bob', inviteCode: invitation.code });
  const stranger = await register('eve@example.it', { name: 'Eve' });
  const expense = await create('/transactions', { kind: 'expense', amount: 1250, categoryId, description: 'Pane', date: '2026-10-05' }, bob);
  const remove = (id, session, currentPassword = 'password-test-123') => request(`/members/${id}`, { method: 'DELETE', body: { currentPassword }, session });
  assert.equal((await remove(owner.user.id, bob)).status, 403);
  assert.equal((await remove(bob.user.id, owner, 'password-errata-1')).status, 400);
  assert.equal((await remove(owner.user.id, owner)).status, 404);
  assert.equal((await remove(stranger.user.id, owner)).status, 404);
  assert.equal((await request('/state?month=2026-10', { session: bob })).status, 200);
  assert.equal((await remove(bob.user.id, owner)).status, 200);
  assert.equal((await request('/state?month=2026-10', { session: bob })).status, 401);
  const after = await state(owner);
  assert.deepEqual(after.members.map(m => m.name), ['Alice']);
  const kept = after.transactions.find(t => t.id === expense.id);
  assert.equal(kept.amount, 1250);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'bob@example.it', password: 'password-test-123' } })).status, 401);
  assert.equal((await remove(bob.user.id, owner)).status, 404);
});

test('the state compares the last six months with totals by category, without itemising private records', async () => {
  const owner = await register(); const [home, food] = (await state(owner)).categories;
  await create('/transactions', { kind: 'expense', amount: 10000, categoryId: home.id, description: 'Affitto', date: '2026-09-02' }, owner);
  await create('/transactions', { kind: 'expense', amount: 2550, categoryId: food.id, description: 'Spesa', date: '2026-10-30' }, owner);
  await create('/transactions', { kind: 'expense', amount: 450, categoryId: food.id, description: 'Mercato', date: '2026-10-01' }, owner);
  await create('/transactions', { kind: 'income', amount: 5000, description: 'Vendita', date: '2026-10-12' }, owner);
  await create('/transactions', { kind: 'expense', amount: 999, categoryId: food.id, description: 'Troppo vecchia', date: '2026-04-30' }, owner);
  await create('/transactions', { kind: 'expense', amount: 777, categoryId: food.id, description: 'Futura', date: '2026-11-01' }, owner);
  const { history } = await state(owner, '2026-10');
  assert.deepEqual(history.map(m => m.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(history[4], { month: '2026-09', income: 0, budgetIncome: 0, expense: 10000, categories: { [home.id]: 10000 } });
  assert.deepEqual(history[5], { month: '2026-10', income: 5000, budgetIncome: 0, expense: 3000, categories: { [food.id]: 3000 } });
  assert.equal((await state(owner, '2027-01')).history[0].month, '2026-08');
});

test('months before the first recurring income borrow its budget base', async () => {
  const owner = await register();
  await create('/recurring', { kind: 'income', name: 'Stipendio', amount: 200000, startMonth: '2026-10', day: 27, enabled: true }, owner);
  await create('/recurring', { kind: 'income', name: 'Affitto box', amount: 5000, startMonth: '2026-10', day: 1, enabled: true }, owner);
  assert.equal((await state(owner, '2026-10')).budgetFallback, null);
  assert.deepEqual((await state(owner, '2026-08')).budgetFallback, { month: '2026-10', amount: 205000 });
  assert.equal((await state(owner, '2026-11')).budgetFallback, null);
  assert.equal((await state(await register('altro@example.it'), '2026-08')).budgetFallback, null);
});

test('each month keeps the budget split in force when it closed', async () => {
  await new Promise(resolve => server.close(resolve)); instance.close();
  let time = Date.parse('2026-10-08T10:00:00Z');
  instance = createApp({ dataDir, clock: () => time });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const owner = await register();
  const original = (await state(owner)).categories;
  const split = data => data.categories.map(c => data.budgetSplit?.[c.id] ?? c.percentage);
  assert.equal((await state(owner, '2026-08')).budgetSplit, null, 'without changes every month uses the current split');
  const save = percentages => request('/budget', { method: 'PUT', session: owner, body: { categories: original.map((c, i) => ({ id: c.id, name: c.name, percentage: percentages[i] })) } });
  assert.equal((await save([4000, 2000, 1000, 1000, 1000, 1000])).status, 200);
  assert.equal((await save([3000, 2000, 1000, 1000, 2000, 1000])).status, 200);
  const before = original.map(c => c.percentage);
  assert.deepEqual(split(await state(owner, '2026-09')), before, 'earlier months keep the split used until the first change');
  assert.deepEqual(split(await state(owner, '2026-10')), [3000, 2000, 1000, 1000, 2000, 1000], 'the last change of the month wins');
  time = Date.parse('2026-11-03T10:00:00Z');
  const presets = (await state(owner)).budgetTemplates;
  assert.equal((await request(`/budget-templates/${presets.find(t => t.template_key === 'leisure').id}/apply`, { method: 'POST', session: owner })).status, 200);
  assert.deepEqual(split(await state(owner, '2026-10')), [3000, 2000, 1000, 1000, 2000, 1000], 'October keeps its split');
  assert.deepEqual(split(await state(owner, '2026-11')), [3000, 1500, 1000, 500, 3000, 1000]);
  assert.deepEqual(split(await state(owner, '2027-02')), [3000, 1500, 1000, 500, 3000, 1000]);
  assert.deepEqual(split(await state(owner, '2026-09')), before);
  assert.deepEqual((await state(owner, '2026-09')).categories.map(c => c.percentage), [3000, 1500, 1000, 500, 3000, 1000], 'categories carry the current split for editing');
});
