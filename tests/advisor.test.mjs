import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createApp } from '../server/app.mjs';
import { analyze, sanitizeAdvice, scrub, merchantKey, modelInput } from '../server/advisor.mjs';

const categories = [
  { id: 'home', name: 'Casa', percentage: 3500 }, { id: 'food', name: 'Alimentari', percentage: 1500 }, { id: 'car', name: 'Trasporti', percentage: 1000 },
  { id: 'health', name: 'Salute', percentage: 500 }, { id: 'fun', name: 'Svago', percentage: 1000 }, { id: 'save', name: 'Risparmio', percentage: 2500 },
];
const row = (id, date, amount, category_id, description, extra = {}) => ({ id, kind: 'expense', date, amount, category_id, description, private: 0, recurring: 0, scheduled: 0, ...extra });

test('descriptions lose IBANs, long codes and emails; merchants ignore payment words', () => {
  assert.equal(scrub('Bonifico a IT60X0542811101000000123456 rif 2026100412345'), 'Bonifico a [IBAN] rif …');
  assert.equal(scrub('Ordine mario@example.it'), 'Ordine [email]');
  assert.equal(merchantKey('PAGAMENTO POS NETFLIX.COM 04/10'), 'netflix com');
  assert.equal(merchantKey('Pagamento carta Netflix.com 05/09'), 'netflix com');
});

test('the analysis projects variable spending, counts fixed costs once and finds repeated payments', () => {
  const rows = [
    row('rent', '2026-10-01', 80000, 'home', 'Affitto', { recurring: 1 }),
    row('f1', '2026-10-03', 6000, 'fun', 'Cinema'), row('f2', '2026-10-09', 9000, 'fun', 'Ristorante'),
    ...['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((date, i) => row(`n${i}`, date, i === 3 ? 1799 : 1599, 'fun', `PAGAMENTO POS NETFLIX.COM ${date}`)),
    ...[2, 4, 6, 8, 10].map(day => row(`b${day}`, `2026-10-${String(day).padStart(2, '0')}`, 350, 'food', 'Bar Centrale')),
    row('d1', '2026-10-11', 4500, 'food', 'Supermercato Sole'), row('d2', '2026-10-11', 4500, 'food', 'Supermercato Sole'),
    row('p1', '2026-10-06', 30000, 'fun', 'Regalo privato per Bob', { private: 1 }),
    row('u1', '2026-10-12', 2500, null, 'Farmacia IT60X0542811101000000123456'),
  ];
  const limits = { home: 105000, food: 45000, car: 30000, health: 15000, fun: 30000, save: 75000 };
  const facts = analyze({ kind: 'weekly', today: '2026-10-14', month: '2026-10', categories, limits, base: 300000, rows,
    deadlines: [{ id: 'ins', name: 'Assicurazione auto', start_date: '2026-11-20', due_day: 20, frequency: 'yearly', amount: 62000, category_id: 'car' }], handled: [], goals: [] });
  const fun = facts.categories.find(c => c.id === 'fun');
  assert.equal(fun.spent, 6000 + 9000 + 1799 + 30000, 'private records count in the totals');
  assert.equal(fun.fixed, 1799 + 30000, 'a monthly payee and a large single payment are counted once');
  assert.equal(fun.projected, 31799 + Math.round(15000 * 31 / 14), 'everyday spending follows the pace of the elapsed days');
  const home = facts.categories.find(c => c.id === 'home');
  assert.equal(home.projected, 80000, 'the rent is counted once, not projected');
  const alert = facts.alerts.find(a => a.categoryId === 'fun');
  assert.equal(alert.status, 'over');
  assert.deepEqual(facts.subscriptions.map(s => [s.key, s.monthly, s.increased]), [['netflix com', 1599, true]]);
  assert.deepEqual(facts.frequent.map(f => [f.key, f.count, f.total]), [['bar centrale', 5, 1750]]);
  assert.deepEqual(facts.duplicates.map(d => d.amount), [4500]);
  assert.deepEqual(facts.deadlines.map(d => [d.name, d.date]), [['Assicurazione auto', '2026-11-20']]);
  assert.deepEqual(facts.uncategorized, [{ id: 'u1', name: 'Farmacia [IBAN]', amount: 2500, date: '2026-10-12' }]);
  const input = modelInput(facts, { current: '2026-10', months: ['2026-10', '2026-11'] });
  assert.doesNotMatch(input, /Regalo privato|IT60X054/, 'private descriptions and IBANs never reach the model');
});

test('rent and bills paid without a rule are not judged on the pace of the days', () => {
  const rows = [
    row('r1', '2026-10-02', 75000, 'home', 'Bonifico a favore di Rossi Mario'),
    row('r0', '2026-09-02', 75000, 'home', 'Bonifico a favore di Rossi Mario'),
    row('e1', '2026-10-05', 9200, 'home', 'Addebito SDD Enel Energia'),
    row('w1', '2026-10-06', 4800, 'home', 'Bolletta acqua'),
    row('g1', '2026-10-03', 3000, 'food', 'Supermercato Sole'), row('g2', '2026-10-06', 2000, 'food', 'Forno'),
  ];
  const limits = { home: 105000, food: 45000, car: 30000, health: 15000, fun: 30000, save: 75000 };
  const facts = analyze({ kind: 'weekly', today: '2026-10-07', month: '2026-10', categories, limits, base: 300000, rows,
    deadlines: [{ id: 'luce', name: 'Bolletta luce', start_date: '2026-10-05', due_day: 5, frequency: 'monthly', amount: 9000, category_id: 'home' }], handled: [], goals: [] });
  const home = facts.categories.find(c => c.id === 'home');
  assert.equal(home.fixed, 75000 + 9200 + 4800);
  assert.equal(home.projected, 89000, 'the rent and the bills count once, and the bill paid by the bank is not due again');
  assert.equal(facts.alerts.find(a => a.categoryId === 'home'), undefined, 'a week with the rent is not overspending');
  assert.equal(facts.categories.find(c => c.id === 'food').projected, Math.round(5000 * 31 / 7));
  assert.equal(facts.week.total, 75000 + 9200 + 4800 + 5000);
  assert.equal(facts.week.everyday, 5000);
  assert.deepEqual(facts.week.everydayCategories.home, 0);
  assert.equal(facts.week.largest.find(r => r.amount === 75000).fixed, true);
  const input = JSON.parse(modelInput(facts, { current: '2026-10', months: ['2026-10', '2026-11'] }));
  assert.deepEqual(input.settimana.per_categoria.Casa, { totale: 890, di_cui_quotidiane: 0 });
  assert.equal(input.settimana.di_cui_spese_quotidiane, 50);
});

test('the model answer is bounded: valid splits only, hints only for the family’s records', () => {
  const facts = { categories: categories.map(c => ({ ...c })), uncategorized: [{ id: 'u1' }] };
  const percentages = [35, 15, 10, 5, 5, 30].map((percent, i) => ({ category_id: categories[i].id, percent }));
  const advice = sanitizeAdvice({ headline: 'x'.repeat(300), summary: 'Ok', tips: [{ kind: 'avoid', title: 'Netflix', detail: 'Valutate' }, { kind: 'wrong', title: 'No', detail: '' }],
    adjustment: { propose: true, month: '2026-11', reason: 'Assicurazione', percentages }, categories: [{ transaction_id: 'u1', category_id: 'health' }, { transaction_id: 'other', category_id: 'health' }, { transaction_id: 'u1', category_id: 'nope' }] }, facts, { months: ['2026-10', '2026-11'] });
  assert.equal(advice.headline.length, 140);
  assert.deepEqual(advice.tips.map(t => t.kind), ['avoid']);
  assert.deepEqual(advice.adjustment.split, { home: 3500, food: 1500, car: 1000, health: 500, fun: 500, save: 3000 });
  assert.deepEqual(advice.hints, [{ transactionId: 'u1', categoryId: 'health' }]);
  const rejected = [
    { propose: true, month: '2027-05', reason: '', percentages },
    { propose: true, month: '2026-11', reason: '', percentages: percentages.map((p, i) => i ? p : { ...p, percent: 36 }) },
    { propose: true, month: '2026-11', reason: '', percentages: percentages.slice(1) },
    { propose: true, month: '2026-11', reason: '', percentages: categories.map(c => ({ category_id: c.id, percent: c.percentage / 100 })) },
  ];
  for (const adjustment of rejected) assert.equal(sanitizeAdvice({ adjustment }, facts, { months: ['2026-10', '2026-11'] }).adjustment, null);
});

let instance, server, base, dataDir;
afterEach(async () => {
  if (!server) return;
  await new Promise(resolve => server.close(resolve)); instance.close(); rmSync(dataDir, { recursive: true, force: true }); server = undefined;
});
async function start(options) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-advisor-'));
  instance = createApp({ dataDir, ...options });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function request(route, { method = 'GET', body, session } = {}) {
  return fetch(base + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'Casa', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function register(email, extra = {}) {
  const response = await request('/auth/register', { method: 'POST', body: { name: email.split('@')[0], email, password: 'password-test-123', householdName: 'Casa Rossi', ...extra } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: result.csrf, user: result.user };
}
const state = async (session, month = '2026-10') => (await request(`/state?month=${month}&week=2026-10-12`, { session })).json();

test('reports are prepared by themselves, read per account, and a suggested split holds for one month', async () => {
  let time = Date.parse('2026-10-14T10:00:00Z');
  const calls = [];
  const model = { model: 'test', async advise({ input }) {
    calls.push(input);
    const facts = JSON.parse(input);
    const ids = facts.categorie.map(c => c.id);
    return { headline: `Report ${facts.tipo_report}`, summary: 'Svago è oltre il massimale.', tips: [{ kind: 'avoid', title: 'Rivedete gli abbonamenti', detail: 'Netflix è aumentato.' }],
      adjustment: { propose: true, month: facts.mese_corrente, reason: 'Rientrare in Svago', percentages: [35, 15, 10, 5, 5, 30].map((percent, i) => ({ category_id: ids[i], percent })) },
      categories: facts.uscite_da_classificare.map(u => ({ transaction_id: u.id, category_id: u.descrizione === 'Versamento' ? ids[5] : ids[3] })) };
  } };
  await start({ advisorModel: model, clock: () => time });
  const alice = await register('alice@example.it');
  const invite = await (await request('/invitation', { method: 'POST', session: alice })).json();
  const bob = await register('bob@example.it', { inviteCode: invite.code });
  const { categories: cats } = await state(alice);
  assert.equal((await request('/recurring', { method: 'POST', session: alice, body: { kind: 'income', startMonth: '2026-09', name: 'Stipendio', amount: 300000, day: 1, enabled: true } })).status, 201);
  for (const [date, amount, categoryId, description] of [['2026-10-03', 25000, cats[4].id, 'Ristorante'], ['2026-10-09', 12000, cats[4].id, 'Concerto'], ['2026-09-20', 5000, cats[1].id, 'Spesa']])
    assert.equal((await request('/transactions', { method: 'POST', session: alice, body: { kind: 'expense', amount, categoryId, description, date } })).status, 201);
  const uncategorized = await (await request('/transactions', { method: 'POST', session: alice, body: { kind: 'expense', amount: 2500, categoryId: cats[1].id, description: 'Farmacia', date: '2026-10-12' } })).json();
  const transfer = await (await request('/transactions', { method: 'POST', session: alice, body: { kind: 'expense', amount: 10000, categoryId: cats[1].id, description: 'Versamento', date: '2026-10-11' } })).json();
  for (const id of [uncategorized.id, transfer.id]) instance.db.prepare('UPDATE transactions SET category_id = NULL WHERE id = ?').run(id);
  const secret = await (await request('/transactions', { method: 'POST', session: bob, body: { kind: 'expense', amount: 9000, categoryId: cats[4].id, description: 'Regalo segreto', date: '2026-10-10' } })).json();
  instance.db.prepare('INSERT INTO private_transactions VALUES (?, ?)').run(secret.id, bob.user.id);

  let current = await state(alice);
  assert.deepEqual([current.advisor.configured, current.advisor.enabled, current.advisor.weekly], [true, false, null]);
  assert.equal((await request('/advisor/settings', { method: 'PUT', session: bob, body: { enabled: true } })).status, 403, 'only the administrator enables it');
  assert.equal((await request('/advisor/settings', { method: 'PUT', session: alice, body: { enabled: true } })).status, 200);
  assert.equal((await request('/advisor/reports', { method: 'POST', session: alice, body: { kind: 'weekly' } })).status, 404, 'no report by hand');
  // Turning it on prepares this week's report at once; mid-month, the report of
  // the closed month is not written late: the first one arrives on the 1st.
  await instance.advisor.idle();
  assert.deepEqual(calls.map(c => JSON.parse(c).tipo_report), ['settimanale']);
  assert.doesNotMatch(calls.join(' '), /Regalo segreto|alice|bob|Casa Rossi/, 'no private descriptions, names or household');
  current = await state(bob);
  assert.equal(current.advisor.monthly, null);
  assert.equal(current.advisor.unread, true);
  const weekly = current.advisor.weekly;
  assert.equal(weekly.headline, 'Report settimanale');
  assert.equal(weekly.alerts[0].categoryId, cats[4].id, 'the figures come from the server');
  assert.equal(weekly.alerts[0].spent, 25000 + 12000 + 9000);
  assert.deepEqual(current.advisor.hints, { [uncategorized.id]: cats[3].id, [transfer.id]: cats[5].id });
  assert.equal(current.advisor.automatic, false, 'categories are suggested by default');

  // Automatic assignment, chosen by the administrator, applies the pending
  // suggestions; a savings transfer stays to be confirmed.
  assert.equal((await request('/advisor/assignment', { method: 'PUT', session: bob, body: { automatic: true } })).status, 403);
  assert.equal((await request('/advisor/assignment', { method: 'PUT', session: alice, body: { automatic: 'yes' } })).status, 400);
  assert.equal((await request('/advisor/assignment', { method: 'PUT', session: alice, body: { automatic: true } })).status, 200);
  current = await state(bob);
  assert.equal(current.advisor.automatic, true);
  assert.equal(current.transactions.find(t => t.id === uncategorized.id).category_id, cats[3].id);
  assert.equal(current.transactions.find(t => t.id === transfer.id).category_id, null);
  assert.deepEqual(current.advisor.hints, { [transfer.id]: cats[5].id });

  // Opening the reports clears the highlight for that account only.
  assert.equal((await request('/advisor/reports/sconosciuto/read', { method: 'POST', session: alice })).status, 404);
  assert.equal((await request(`/advisor/reports/${weekly.id}/read`, { method: 'POST', session: alice })).status, 200);
  assert.equal((await state(alice)).advisor.unread, false);
  assert.equal((await state(bob)).advisor.unread, true);

  // The split applies to October only; November returns to the usual one.
  assert.equal((await request(`/advisor/reports/${weekly.id}/apply`, { method: 'POST', session: bob })).status, 200);
  current = await state(alice);
  assert.equal(current.budgetSplit[cats[4].id], 500);
  assert.equal(current.advisor.weekly.adjustment.applied, true);
  assert.deepEqual(current.advisor.override, { month: '2026-10', fromReport: true });
  assert.equal(current.categories[4].percentage, 1000, 'the usual split is untouched');
  assert.equal((await state(alice, '2026-11')).budgetSplit?.[cats[4].id] ?? 1000, 1000);
  assert.equal((await request('/budget/overrides/2026-10', { method: 'DELETE', session: alice })).status, 200);
  assert.equal((await state(alice)).advisor.override, null);
  assert.equal((await request(`/advisor/reports/${weekly.id}/apply`, { method: 'POST', session: alice })).status, 200);
  // A change by hand replaces this month's suggested split.
  assert.equal((await request('/budget', { method: 'PUT', session: alice, body: { categories: current.categories.map((c, i) => ({ id: c.id, name: c.name, percentage: [3000, 2000, 1000, 500, 1000, 2500][i] })) } })).status, 200);
  current = await state(alice);
  assert.equal(current.advisor.override, null);
  assert.equal(current.budgetSplit[cats[1].id], 2000);

  await instance.advisor.scheduled();
  assert.equal(calls.length, 1, 'each report once per period');
  time = Date.parse('2026-10-19T18:00:00Z');
  await instance.advisor.scheduled();
  assert.equal(calls.length, 2, 'a new week, a new report');
  current = await state(alice);
  assert.deepEqual([current.advisor.weekly.period, current.advisor.unread], ['2026-10-19', true], 'the new week replaces the previous one');

  // The monthly report of October starts November: last week's report goes,
  // and no weekly report is written for a Monday of the closed month.
  time = Date.parse('2026-11-01T18:00:00Z');
  await instance.advisor.scheduled();
  assert.deepEqual(calls.slice(2).map(c => JSON.parse(c).tipo_report), ['mensile']);
  current = await state(alice, '2026-11');
  assert.deepEqual([current.advisor.monthly.month, current.advisor.weekly], ['2026-10', null]);

  // Applying is refused once the month is closed.
  time = Date.parse('2026-11-02T10:00:00Z');
  assert.equal((await request(`/advisor/reports/${weekly.id}/apply`, { method: 'POST', session: alice })).status, 400);
  await instance.advisor.scheduled();
  current = await state(alice, '2026-11');
  assert.equal(current.advisor.weekly.period, '2026-11-02', 'the first week of November is shown with the monthly report');
  // Each report is read on its own: opening the monthly one leaves the weekly one new.
  assert.equal((await request(`/advisor/reports/${current.advisor.monthly.id}/read`, { method: 'POST', session: alice })).status, 200);
  current = await state(alice, '2026-11');
  assert.deepEqual([current.advisor.monthly.unread, current.advisor.weekly.unread, current.advisor.unread], [false, true, true]);

  // The family ZIP keeps reports and settings.
  const zip = unzipSync(new Uint8Array(await (await request('/backups/export', { session: alice })).arrayBuffer()));
  const payload = JSON.parse(new TextDecoder().decode(zip['casa.json']));
  assert.equal(payload.data.advisor_reports.length, 4);
  assert.equal(payload.data.advisor_settings[0].enabled, 1);

  // Turning it off hides reports and hints.
  assert.equal((await request('/advisor/settings', { method: 'PUT', session: alice, body: { enabled: false } })).status, 200);
  current = await state(alice);
  assert.deepEqual([current.advisor.weekly, current.advisor.hints], [null, {}]);
});

test('without an API key the advice cannot be enabled', async () => {
  await start({ advisorModel: null });
  const alice = await register('alice@example.it');
  assert.equal((await state(alice)).advisor.configured, false);
  assert.equal((await request('/advisor/settings', { method: 'PUT', session: alice, body: { enabled: true } })).status, 503);
});
