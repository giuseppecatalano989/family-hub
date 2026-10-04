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
