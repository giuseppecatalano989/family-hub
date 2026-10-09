import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createApp } from '../server/app.mjs';
import { enableBankingProvider, normalizeTransactions, parseAmount, pickBalance, ruleCategory, splitSavings } from '../server/bank.mjs';

const NOW = Date.parse('2026-10-15T10:00:00Z');
const IBAN_A = 'IT60X0542811101000000123456';
const IBAN_B = 'IT02A0301503200000003517230';
const tx = (ref, amount, indicator, date, extra = {}) => ({ entry_reference: ref, transaction_amount: { amount, currency: 'EUR' }, credit_debit_indicator: indicator, status: 'BOOK', booking_date: date, ...extra });

function fakeProvider() {
  const calls = [];
  const sessions = {
    alice: [{ uid: 'uid-a', iban: IBAN_A, name: 'Conto Alice', currency: 'EUR' }],
    bob: [{ uid: 'uid-b', iban: IBAN_B, name: 'Conto Bob', currency: 'EUR' }],
  };
  const data = {
    sessions,
    balances: { 'uid-a': [{ balance_type: 'CLBD', balance_amount: { amount: '1500.00', currency: 'EUR' } }, { balance_type: 'ITAV', balance_amount: { amount: '1450.55', currency: 'EUR' } }],
      'uid-b': [{ balance_type: 'CLBD', balance_amount: { amount: '-20.10', currency: 'EUR' } }] },
    transactions: {
      'uid-a': [
        tx('a1', '42.30', 'DBIT', '2026-10-03', { creditor: { name: 'CONAD SUPERSTORE' } }),
        tx('a2', '2100.00', 'CRDT', '2026-10-01', { debtor: { name: 'Azienda Srl' }, remittance_information: ['Stipendio ottobre'] }),
        tx('a3', '80.00', 'DBIT', '2026-10-05', { remittance_information: ['Bonifico a Bob'], creditor_account: { iban: IBAN_B } }),
        tx('a4', '15.00', 'DBIT', '2026-09-20', { creditor: { name: 'Farmacia Centrale' } }),
        tx('a5', '60.00', 'DBIT', '2026-10-08', { creditor: { name: 'Negozio Vario' } }),
        tx('a6', '9.99', 'DBIT', '2026-10-09', { status: 'PDNG', creditor: { name: 'In attesa' } }),
      ],
      'uid-b': [
        tx('b1', '80.00', 'CRDT', '2026-10-05', { debtor_account: { iban: IBAN_A }, remittance_information: ['Da Alice'] }),
        tx('b2', '33.00', 'DBIT', '2026-10-06', { creditor: { name: 'Pizzeria Da Mario' } }),
      ],
    },
  };
  return { calls, data, secret: Buffer.alloc(32, 7),
    async banks(country) { calls.push(['banks', country]); return [{ name: 'Intesa Sanpaolo', country: 'IT', maxConsentSeconds: 15552000 }, { name: 'Banca Due', country: 'IT', maxConsentSeconds: null }]; },
    async startAuthorization(options) { calls.push(['start', options]); return `https://bank.example/auth?state=${options.state}`; },
    async createSession(code) { calls.push(['session', code]); return { sessionId: `sess-${code}`, validUntil: '2027-04-10T10:00:00Z', accounts: data.sessions[code] || [] }; },
    async balances(uid) { return data.balances[uid] || []; },
    async transactions(uid, from) { calls.push(['transactions', uid, from]); return data.transactions[uid] || []; },
    async endSession(id) { calls.push(['end', id]); },
  };
}

let instance, server, base, dataDir, provider;
async function start(options = {}) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-bank-'));
  instance = createApp({ dataDir, clock: () => NOW, bankRedirectUrl: 'https://casa.example/api/bank/callback', ...options });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
beforeEach(async () => { provider = fakeProvider(); });
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  instance?.close(); if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  server = instance = dataDir = undefined;
});
async function request(route, { method = 'GET', body, session } = {}) {
  return fetch(base + route, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'Casa', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function register(email, extra = {}) {
  const response = await request('/auth/register', { method: 'POST', body: { name: email.split('@')[0], email, password: 'password-test-123', householdName: 'Casa Rossi', ...extra } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: result.csrf, user: result.user };
}
async function family() {
  const alice = await register('alice@example.it');
  const invitation = await (await request('/invitation', { method: 'POST', session: alice })).json();
  const bob = await register('bob@example.it', { inviteCode: invitation.code });
  return { alice, bob };
}
const movements = (where = '1 = 1', ...args) => instance.db.prepare(`SELECT * FROM bank_movements m WHERE ${where} ORDER BY m.date DESC, m.external_id`).all(...args);
const unclassified = data => data.transactions.filter(t => t.kind === 'expense' && !t.category_id && t.privacy !== 'others');
const state = async (session, month = '2026-10') => (await request(`/state?month=${month}&week=2026-10-12`, { session })).json();
async function link(session, code, visibility, bank = 'Intesa Sanpaolo') {
  const started = await request('/bank/connections', { method: 'POST', session, body: { bank, visibility } });
  assert.equal(started.status, 201, await started.clone().text());
  const stateValue = new URL((await started.json()).url).searchParams.get('state');
  return request(`/bank/callback?code=${code}&state=${stateValue}`, { session });
}

test('bank amounts, balances, movements and category rules are parsed without floating point', () => {
  assert.equal(parseAmount('12.34'), 1234); assert.equal(parseAmount('-0.1'), -10); assert.equal(parseAmount('7'), 700); assert.equal(parseAmount('1.005'), 101);
  assert.equal(parseAmount('1e3'), null); assert.equal(parseAmount(''), null);
  assert.deepEqual(pickBalance(provider.data.balances['uid-a']), { amount: 145055, kind: 'available' });
  assert.deepEqual(pickBalance([{ balance_type: 'CLBD', balance_amount: { amount: '-20.10', currency: 'EUR' } }]), { amount: -2010, kind: 'booked' });
  assert.equal(pickBalance([{ balance_type: 'CLBD', balance_amount: { amount: '5', currency: 'USD' } }]), null);
  const rows = normalizeTransactions([...provider.data.transactions['uid-a'], tx(null, '5.00', 'DBIT', '2026-10-10', { remittance_information: ['Caffè'] }), tx(null, '5.00', 'DBIT', '2026-10-10', { remittance_information: ['Caffè'] })]);
  assert.equal(rows.length, 7, 'pending movements are skipped');
  assert.deepEqual(rows[0], { ...rows[0], externalId: 'e:a1', kind: 'expense', amount: 4230, date: '2026-10-03', description: 'CONAD SUPERSTORE' });
  assert.equal(rows[1].kind, 'income'); assert.equal(rows[1].description, 'Azienda Srl');
  assert.notEqual(rows[5].externalId, rows[6].externalId, 'identical movements without references stay distinct');
  assert.equal(ruleCategory('CONAD SUPERSTORE'), 1); assert.equal(ruleCategory('Farmacia Centrale'), 3); assert.equal(ruleCategory('Pizzeria Da Mario'), 4); assert.equal(ruleCategory('Negozio Vario'), null);
});

test('Enable Banking client signs RS256 tokens, sends PSU headers and never requests payments', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), ...options });
    const route = new URL(url).pathname;
    const body = route === '/aspsps' ? { aspsps: [{ name: 'Intesa Sanpaolo', country: 'IT', psu_types: ['personal'], maximum_consent_validity: 15552000 }, { name: 'Solo Aziende', country: 'IT', psu_types: ['business'] }] }
      : route === '/auth' ? { url: 'https://auth.example/start' }
      : route.endsWith('/transactions') ? (new URL(url).searchParams.get('continuation_key') ? { transactions: [{ entry_reference: '2' }] } : { transactions: [{ entry_reference: '1' }], continuation_key: 'next' })
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = enableBankingProvider({ appId: 'app-123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).replaceAll('\n', '\\n'), baseUrl: 'https://api.test', fetcher });
  assert.deepEqual(await client.banks('IT'), [{ name: 'Intesa Sanpaolo', country: 'IT', maxConsentSeconds: 15552000 }]);
  const [header, payload, signature] = requests[0].headers.Authorization.slice(7).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'RS256', kid: 'app-123' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, 'enablebanking.com'); assert.equal(claims.aud, 'api.enablebanking.com'); assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(await client.startAuthorization({ bank: { name: 'Intesa Sanpaolo', country: 'IT' }, state: 's', redirectUrl: 'https://casa.example/cb', validUntil: '2027-01-01T00:00:00.000Z', psu: { ip: '203.0.113.5', userAgent: 'Test' } }), 'https://auth.example/start');
  const auth = requests.at(-1);
  assert.equal(auth.headers['Psu-Ip-Address'], '203.0.113.5');
  assert.deepEqual(JSON.parse(auth.body), { access: { valid_until: '2027-01-01T00:00:00.000Z' }, aspsp: { name: 'Intesa Sanpaolo', country: 'IT' }, state: 's', redirect_url: 'https://casa.example/cb', psu_type: 'personal' });
  assert.equal((await client.transactions('uid/1', '2026-07-01')).length, 2);
  assert.match(requests.at(-1).url, /accounts\/uid%2F1\/transactions\?date_from=2026-07-01&continuation_key=next/);
  assert.ok(requests.every(r => !/payments/.test(r.url)));
  const failing = enableBankingProvider({ appId: 'app-123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), baseUrl: 'https://api.test', fetcher: async () => new Response('{"error":"secret details"}', { status: 401 }) });
  await assert.rejects(failing.balances('x'), error => error.code === 'access' && !/secret/.test(error.message));
  assert.equal(enableBankingProvider({ appId: '', privateKey: '' }), null);
});

test('without configuration the bank section is disabled', async () => {
  await start({ bankProvider: null });
  const { alice } = await family();
  assert.equal((await request('/bank/banks', { session: alice })).status, 503);
  const data = await state(alice);
  assert.deepEqual(data.bank, { configured: false, total: 0, savingsTotal: 0, accounts: [], connections: [], savingsStrategy: 'proportional', savingsUnassigned: 0 });
});

test('linking shared and balance-only accounts builds a family total, imports and reconciles shared movements', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  assert.equal((await request('/bank/banks')).status, 401);
  assert.deepEqual((await (await request('/bank/banks', { session: alice })).json()).banks.map(b => b.name), ['Banca Due', 'Intesa Sanpaolo']);
  assert.equal((await request('/bank/banks?country=DE', { session: alice })).status, 200, 'banks registered abroad, like Trade Republic, are listed by country');
  assert.deepEqual(provider.calls.filter(c => c[0] === 'banks').map(c => c[1]).slice(-2), ['IT', 'DE']);
  assert.equal((await request('/bank/banks?country=XX', { session: alice })).status, 400);
  assert.equal((await request('/bank/connections', { method: 'POST', session: alice, body: { bank: 'Banca Inventata', visibility: 'shared' } })).status, 400);

  // A state started by Alice cannot be completed by Bob's browser and is single use.
  const started = await request('/bank/connections', { method: 'POST', session: alice, body: { bank: 'Intesa Sanpaolo', visibility: 'shared' } });
  const stolen = new URL((await started.json()).url).searchParams.get('state');
  const hijack = await request(`/bank/callback?code=alice&state=${stolen}`, { session: bob });
  assert.equal(hijack.status, 303); assert.equal(hijack.headers.get('location'), '/?banca=errore#bank');
  assert.equal((await request(`/bank/callback?code=alice&state=${stolen}`, { session: alice })).headers.get('location'), '/?banca=errore#bank');
  assert.equal(provider.calls.filter(c => c[0] === 'session').length, 0);
  const startCall = provider.calls.find(c => c[0] === 'start')[1];
  assert.equal(startCall.redirectUrl, 'https://casa.example/api/bank/callback');
  assert.equal(startCall.validUntil, new Date(NOW + (15552000 - 3600) * 1000).toISOString());

  // Alice's manual entry for the same purchase is linked instead of duplicated.
  const groceries = (await state(alice)).categories[1];
  await request('/transactions', { method: 'POST', session: alice, body: { kind: 'expense', amount: 4230, categoryId: groceries.id, description: 'Spesa settimanale', date: '2026-10-02' } });
  const linked = await link(alice, 'alice', 'shared');
  assert.equal(linked.headers.get('location'), '/?banca=collegato#bank');
  let data = await state(alice);
  assert.equal(data.bank.total, 145055);
  assert.equal(data.bank.accounts[0].iban_last4, '3456'); assert.equal(data.bank.accounts[0].mine, true);
  assert.equal(data.transactions.filter(t => t.description === 'Spesa settimanale').length, 1);
  assert.equal(data.transactions.find(t => t.description === 'Spesa settimanale').bank_account, 'Conto Alice');
  assert.equal(data.transactions.some(t => t.description === 'CONAD SUPERSTORE'), false);
  const salary = data.transactions.find(t => t.description === 'Azienda Srl');
  assert.equal(salary.kind, 'income'); assert.equal(salary.amount, 210000); assert.equal(salary.author, 'alice');
  const unknown = data.transactions.find(t => t.description === 'Negozio Vario');
  assert.equal(unknown.category_id, null, 'unknown merchants are left to classify');
  assert.equal(data.transactions.find(t => t.description === 'Bonifico a Bob').amount, 8000, 'Bob is not linked yet: the transfer is an expense');
  // Linked on 15 October: the 90 days fetched start on 17 July, so imports begin with August.
  assert.equal(data.bank.accounts[0].import_from, '2026-08-01');
  const september = (await state(alice, '2026-09')).transactions;
  assert.deepEqual(september.map(t => [t.description, t.amount]), [['Farmacia Centrale', 1500]], 'the history fetched before the link is imported too');
  assert.equal(september[0].category_id, data.categories[3].id);
  const conad = movements().find(m => m.description === 'CONAD SUPERSTORE');
  assert.deepEqual([conad.status, conad.transaction_id], ['matched', data.transactions.find(t => t.description === 'Spesa settimanale').id]);
  assert.equal(movements().some(m => m.description === 'In attesa'), false);
  assert.deepEqual(movements().filter(m => m.description === 'Farmacia Centrale').map(m => [m.status, m.transaction_id]), [['imported', september[0].id]]);
  assert.deepEqual(unclassified(data).map(t => [t.description, t.amount]).sort(), [['Bonifico a Bob', 8000], ['Negozio Vario', 6000]], 'expenses to classify in Uscite');

  // Bob keeps his movements private: they count in the budget, Alice only sees totals.
  assert.equal((await link(bob, 'bob', 'balance')).headers.get('location'), '/?banca=collegato#bank');
  data = await state(alice);
  assert.equal(data.bank.total, 145055 - 2010);
  const bobAccount = data.bank.accounts.find(a => a.name === 'Conto Bob');
  assert.equal(bobAccount.mine, false); assert.equal(bobAccount.balance, -2010);
  assert.equal(JSON.stringify(data.bank).includes('Pizzeria'), false);
  assert.equal(data.transactions.some(t => t.description === 'Pizzeria Da Mario'), false);
  const totals = data.transactions.find(t => t.privacy === 'others');
  assert.deepEqual({ description: totals.description, amount: totals.amount, category: totals.category_id, kind: totals.kind }, { description: 'Spese di bob', amount: 3300, category: data.categories[4].id, kind: 'expense' });
  assert.equal(JSON.stringify(data.transactions).includes('Pizzeria'), false);
  assert.equal(data.transactions.some(t => t.description === 'Bonifico a Bob' || t.description === 'Da Alice'), false, 'transfers between family accounts are giroconti, even when private');
  const bobView = await state(bob);
  const pizza = bobView.transactions.find(t => t.description === 'Pizzeria Da Mario');
  assert.equal(pizza.privacy, 'mine'); assert.equal(pizza.author, 'bob');
  assert.equal(movements('m.account_id = ?', bobAccount.id).length, 2);
  assert.equal((await request(`/transactions/${pizza.id}`, { method: 'PUT', session: alice, body: { kind: 'expense', amount: 1, categoryId: data.categories[0].id, description: 'x', date: '2026-10-06' } })).status, 404);
  assert.equal((await request(`/transactions/${pizza.id}`, { method: 'DELETE', session: alice })).status, 404);
  assert.equal((await request(`/transactions/${encodeURIComponent(totals.id)}`, { method: 'DELETE', session: alice })).status, 404);
  const csv = await (await request('/export', { session: alice })).text();
  assert.match(csv, /Spese di bob/); assert.doesNotMatch(csv, /Pizzeria/);
  assert.match(await (await request('/export', { session: bob })).text(), /Pizzeria Da Mario/);
  assert.equal((await request(`/bank/accounts/${bobAccount.id}`, { method: 'PATCH', session: alice, body: { visibility: 'shared' } })).status, 404);
  assert.equal((await request(`/bank/connections/${bobAccount.connection_id}`, { method: 'DELETE', session: alice })).status, 404);

  // Sharing Bob's account reveals the records already counted in the budget.
  assert.equal((await request(`/bank/accounts/${bobAccount.id}`, { method: 'PATCH', session: bob, body: { visibility: 'shared' } })).status, 200);
  data = await state(alice);
  assert.equal(data.transactions.find(t => t.description === 'Pizzeria Da Mario').category_id, data.categories[4].id);
  assert.equal(data.transactions.some(t => t.privacy), false);
  assert.equal(data.transactions.some(t => t.description === 'Bonifico a Bob' || t.description === 'Da Alice'), false);
  assert.deepEqual(movements("m.status = 'transfer'").map(m => m.description).sort(), ['Bonifico a Bob', 'Da Alice']);

  // Corrections teach the category; deleted imports are not imported again.
  await request(`/transactions/${unknown.id}`, { method: 'PUT', session: alice, body: { kind: 'expense', amount: 6000, categoryId: data.categories[0].id, description: 'Negozio Vario', date: '2026-10-08' } });
  await request(`/transactions/${salary.id}`, { method: 'DELETE', session: alice });
  provider.data.transactions['uid-a'].push(tx('a7', '25.00', 'DBIT', '2026-10-12', { creditor: { name: 'NEGOZIO VARIO' } }));
  const aliceAccount = data.bank.accounts.find(a => a.name === 'Conto Alice');
  const throttled = await request(`/bank/connections/${aliceAccount.connection_id}/sync`, { method: 'POST', session: alice });
  assert.equal(throttled.status, 429);
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = ?').run('2026-10-15T09:54:00.000Z');
  assert.equal((await request(`/bank/connections/${aliceAccount.connection_id}/sync`, { method: 'POST', session: alice })).status, 200);
  data = await state(alice);
  assert.equal(data.transactions.some(t => t.description === 'Azienda Srl'), false);
  assert.equal(data.transactions.find(t => t.amount === 2500).category_id, data.categories[0].id);
  assert.equal(provider.calls.filter(c => c[0] === 'transactions' && c[1] === 'uid-a').at(-1)[2], '2026-09-28', 'refetches ten days before the last booked movement');

  // Provider sessions are encrypted at rest and removed on disconnection.
  const secrets = instance.db.prepare('SELECT session_secret FROM bank_connections').all();
  assert.ok(secrets.every(s => s.session_secret.startsWith('v1.') && !s.session_secret.includes('sess-')));
  const before = data.transactions.length;
  assert.equal((await request(`/bank/connections/${aliceAccount.connection_id}`, { method: 'DELETE', session: alice })).status, 200);
  assert.deepEqual(provider.calls.find(c => c[0] === 'end'), ['end', 'sess-alice']);
  data = await state(alice);
  assert.equal(data.bank.accounts.length, 1); assert.equal(data.transactions.length, before);
});

test('renewing a consent keeps the account; background sync respects limits; exports omit secrets and private movements', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  await link(alice, 'alice', 'shared');
  await link(bob, 'bob', 'balance');
  const first = (await state(alice)).bank.accounts.find(a => a.name === 'Conto Alice');
  await request(`/bank/accounts/${first.id}`, { method: 'PATCH', session: alice, body: { visibility: 'balance' } });
  assert.equal((await link(alice, 'alice', 'shared')).headers.get('location'), '/?banca=collegato#bank');
  const renewed = (await state(alice)).bank.accounts.find(a => a.name === 'Conto Alice');
  assert.equal(renewed.id, first.id); assert.notEqual(renewed.connection_id, first.connection_id);
  assert.equal(renewed.visibility, 'balance', 'renewal keeps the chosen visibility');
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM bank_connections').get().count, 2);
  assert.ok(provider.calls.some(c => c[0] === 'end' && c[1] === 'sess-alice'));

  const transactionCalls = () => provider.calls.filter(c => c[0] === 'transactions').length;
  const calls = transactionCalls();
  await instance.bank.synchronizeAll();
  assert.equal(transactionCalls(), calls, 'recent connections are not polled again');
  // Open apps refresh their owner's accounts every 5 minutes, others' only every 6 hours.
  const setAttempt = value => instance.db.prepare('UPDATE bank_connections SET last_attempt_at = ?').run(value);
  assert.deepEqual(await (await request('/bank/refresh', { method: 'POST', session: alice })).json(), { synced: 0 });
  setAttempt('2026-10-15T09:54:00.000Z');
  assert.deepEqual(await (await request('/bank/refresh', { method: 'POST', session: alice })).json(), { synced: 1 });
  assert.equal(transactionCalls(), calls + 1);
  setAttempt('2026-10-15T05:00:00.000Z');
  await instance.bank.synchronizeAll();
  assert.equal(transactionCalls(), calls + 1, 'unattended reads wait six hours');
  setAttempt('2026-10-15T03:59:00.000Z');
  await instance.bank.synchronizeAll();
  assert.equal(transactionCalls(), calls + 3);
  instance.db.prepare("UPDATE bank_connections SET valid_until = '2026-10-01T00:00:00.000Z', last_attempt_at = NULL").run();
  await instance.bank.synchronizeAll();
  assert.equal(transactionCalls(), calls + 3);
  assert.deepEqual(instance.db.prepare('SELECT DISTINCT status FROM bank_connections').all().map(r => r.status), ['expired']);

  const exported = await request('/backups/export', { session: alice });
  assert.equal(exported.status, 200);
  const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  const json = Buffer.from(files['casa.json']).toString('utf8');
  const payload = JSON.parse(json).data;
  assert.equal(payload.bank_accounts.length, 2);
  assert.equal(json.includes('session_secret'), false); assert.equal(json.includes('iban_hash'), false);
  assert.equal(payload.bank_movements.length, 0, 'no shared accounts left: private movements are not exported');
  assert.equal(json.includes('Pizzeria') || json.includes('CONAD') || json.includes('Azienda Srl'), false);
  assert.ok(payload.transactions.filter(t => t.description === 'Movimento bancario privato').length >= 4, 'private records stay in the budget without details');
});

test('planned salaries silently become real only with salary credits, never with sales or refunds', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  const plan = async (session, name, amount, day) => assert.equal((await request('/recurring', { method: 'POST', session, body: { kind: 'income', name, amount, day, startMonth: '2026-10', enabled: true } })).status, 201);
  await plan(alice, 'Stipendio Alice', 180000, 27);
  await plan(bob, 'Stipendio Bob', 185000, 25);
  provider.data.transactions = { 'uid-a': [], 'uid-b': [] };
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  const income = name => data.transactions.find(t => t.description === name);
  assert.equal(data.transactions.filter(t => t.kind === 'income').reduce((s, t) => s + t.amount, 0), 365000, 'planned salaries count from the first day');
  assert.equal('expected' in income('Stipendio Alice'), false, 'no planned label is exposed');

  // A sale of a similar amount, or of exactly the planned amount, is a separate income.
  provider.data.transactions['uid-a'] = [
    tx('v1', '1750.00', 'CRDT', '2026-10-22', { debtor: { name: 'Mario Rossi' }, remittance_information: ['Vendita bicicletta usata'] }),
    tx('v2', '1800.00', 'CRDT', '2026-10-26', { debtor: { name: 'Luca Bianchi' }, remittance_information: ['Saldo divano'] }),
    tx('r1', '50.00', 'CRDT', '2026-10-20', { debtor: { name: 'Rimborso spese' } }),
    tx('s1', '1856.30', 'CRDT', '2026-10-24', { debtor: { name: 'Azienda Srl' }, debtor_account: { iban: 'IT40S0542811101000000123456' }, remittance_information: ['Emolumenti ottobre 2026'] }),
  ];
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  data = await state(alice);
  assert.deepEqual([income('Stipendio Alice').amount, income('Stipendio Alice').date, income('Stipendio Alice').bank_account], [185630, '2026-10-24', 'Conto Alice'], 'the salary reason identifies the credit; Alice\'s own plan wins over Bob\'s closer amount');
  assert.equal(data.transactions.some(t => t.description === 'Azienda Srl'), false, 'no duplicate of the salary');
  assert.equal(income('Mario Rossi').amount, 175000); assert.equal(income('Luca Bianchi').amount, 180000); assert.equal(income('Rimborso spese').amount, 5000);
  assert.equal(income('Stipendio Bob').amount, 185000);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM salary_payers').get().count, 1, 'the employer is remembered');

  // Bob's employer is recognised from previous months; a late credit stays in the planned month.
  provider.data.transactions['uid-b'] = [
    tx('h1', '1790.00', 'CRDT', '2026-09-25', { debtor: { name: 'Ditta Bob' }, debtor_account: { iban: 'IT21Q0300203280000000000001' } }),
    tx('s2', '1799.99', 'CRDT', '2026-11-02', { debtor: { name: 'Ditta Bob' }, debtor_account: { iban: 'IT21Q0300203280000000000001' } }),
  ];
  await link(bob, 'bob', 'balance');
  data = await state(alice);
  assert.deepEqual([income('Stipendio Bob').amount, income('Stipendio Bob').date], [179999, '2026-10-25']);
  assert.equal((await state(alice, '2026-11')).transactions.some(t => t.amount === 179999), false);
});

test('a known employer replaces the planned salary even with a bonus month', async () => {
  await start({ bankProvider: provider });
  const { alice } = await family();
  assert.equal((await request('/recurring', { method: 'POST', session: alice, body: { kind: 'income', name: 'Stipendio Alice', amount: 180000, day: 27, startMonth: '2026-10', enabled: true } })).status, 201);
  const rule = instance.db.prepare('SELECT id FROM recurring_rules').get();
  const iban = 'IT40S0542811101000000123456';
  instance.db.prepare('INSERT INTO salary_payers VALUES (?, ?)').run(rule.id, `iban:${createHash('sha256').update(`iban:${iban}`).digest('hex')}`);
  provider.data.transactions = { 'uid-a': [tx('s1', '3600.00', 'CRDT', '2026-10-23', { debtor: { name: 'Azienda Srl' }, debtor_account: { iban } })] };
  await link(alice, 'alice', 'shared');
  const incomes = (await state(alice)).transactions.filter(t => t.kind === 'income');
  assert.deepEqual(incomes.map(t => [t.description, t.amount, t.date]), [['Stipendio Alice', 360000, '2026-10-23']]);
});

test('savings are split among goal quotas, by priority or in proportion, in integer cents', () => {
  const goals = () => [{ id: 'emergenze', monthly: 30000, need: 30000, room: 500000, primary: false }, { id: 'vacanze', monthly: 10000, need: 10000, room: 100000, primary: true }];
  const split = (amount, strategy, list = goals()) => Object.fromEntries(splitSavings(amount, list, strategy).map(p => [p.id, p.amount]));
  assert.deepEqual(split(40000, 'proportional'), { emergenze: 30000, vacanze: 10000 }, 'enough savings cover every quota');
  assert.deepEqual(split(20000, 'proportional'), { emergenze: 15000, vacanze: 5000 }, 'a short month is shared 75/25');
  assert.deepEqual(split(20000, 'primary'), { emergenze: 10000, vacanze: 10000 }, 'the primary goal is filled first');
  assert.deepEqual(split(5000, 'primary'), { vacanze: 5000 });
  assert.deepEqual(split(50000, 'primary'), { emergenze: 30000, vacanze: 20000 }, 'the excess goes to the primary goal');
  assert.deepEqual(split(50000, 'proportional'), { emergenze: 37500, vacanze: 12500 }, 'the excess follows the quotas');
  assert.deepEqual(split(1, 'proportional'), { emergenze: 1 }, 'cents are never lost');
  assert.deepEqual(split(20000, 'primary', goals().map(g => ({ ...g, primary: false }))), { emergenze: 15000, vacanze: 5000 }, 'without a primary goal the split is proportional');
  assert.deepEqual(split(900000, 'proportional'), { emergenze: 500000, vacanze: 100000 }, 'never beyond the target');
  for (const amount of [1, 999, 33333, 123457]) assert.equal(splitSavings(amount, goals(), 'proportional').reduce((s, p) => s + p.amount, 0), amount);
});

test('bank deposits to savings fill Risparmio and are shared among goals automatically, consistently on edits', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  const TR = 'IT55T0300203280000000000777';
  const goal = async (session, title, monthly, target, primary = false) => (await (await request('/goals', { method: 'POST', session, body: { title, horizon: 'short', target, monthly, primary } })).json()).id;
  const emergenze = await goal(bob, 'Fondo emergenze', 30000, 500000);
  const vacanze = await goal(alice, 'Vacanze', 10000, 100000);
  provider.data.transactions = { 'uid-a': [
    tx('p1', '200.00', 'DBIT', '2026-10-02', { creditor: { name: 'Trade Republic Bank GmbH' }, creditor_account: { iban: TR }, remittance_information: ['PAC ottobre'] }),
    tx('p2', '120.00', 'DBIT', '2026-10-03', { creditor: { name: 'Cassa di Risparmio di Asti' }, remittance_information: ['Bonifico a Mario'] }),
  ], 'uid-b': [] };
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  const savingsCategory = data.categories[5].id;
  const saved = () => Object.fromEntries(data.goals.map(g => [g.title, g.saved]));
  assert.equal(data.transactions.find(t => t.description === 'Trade Republic Bank GmbH').category_id, savingsCategory);
  assert.notEqual(data.transactions.find(t => t.description === 'Cassa di Risparmio di Asti').category_id, savingsCategory, 'bank names with "risparmio" are not savings');
  assert.deepEqual(saved(), { 'Fondo emergenze': 15000, Vacanze: 5000 }, 'by default a short month is shared in proportion');
  assert.equal(data.bank.savingsStrategy, 'proportional');

  // Primary goal and priority: the next deposits fill Vacanze first, then the excess goes to it.
  assert.equal((await request('/savings/strategy', { method: 'PUT', session: bob, body: { strategy: 'everything' } })).status, 400);
  assert.equal((await request('/savings/strategy', { method: 'PUT', session: bob, body: { strategy: 'primary' } })).status, 200);
  assert.equal((await request(`/goals/${vacanze}`, { method: 'PUT', session: alice, body: { title: 'Vacanze', horizon: 'short', target: 100000, monthly: 10000, primary: true } })).status, 200);
  const sync = async () => { instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run(); await request('/bank/refresh', { method: 'POST', session: alice }); data = await state(alice); };
  provider.data.transactions['uid-a'].push(tx('p3', '150.00', 'DBIT', '2026-10-12', { creditor: { name: 'TRB GmbH' }, creditor_account: { iban: TR } }));
  await sync();
  assert.deepEqual(saved(), { 'Fondo emergenze': 25000, Vacanze: 10000 }, 'the same IBAN is recognised; the primary quota is filled first');
  provider.data.transactions['uid-a'].push(tx('p4', '300.00', 'DBIT', '2026-10-13', { creditor: { name: 'TRB GmbH' }, creditor_account: { iban: TR } }));
  await sync();
  assert.deepEqual(saved(), { 'Fondo emergenze': 30000, Vacanze: 35000 });
  assert.deepEqual(data.goals.map(g => [g.title, g.monthly, g.is_primary]).sort(), [['Fondo emergenze', 30000, 0], ['Vacanze', 10000, 1]]);

  // Editing the amount re-splits; deleting removes the contributions; only one goal is primary.
  const deposit = data.transactions.find(t => t.amount === 30000 && t.category_id === savingsCategory);
  await request(`/transactions/${deposit.id}`, { method: 'PUT', session: alice, body: { kind: 'expense', amount: 20000, categoryId: savingsCategory, description: deposit.description, date: deposit.date } });
  data = await state(alice); assert.deepEqual(saved(), { 'Fondo emergenze': 30000, Vacanze: 25000 });
  await request(`/transactions/${deposit.id}`, { method: 'DELETE', session: alice });
  data = await state(alice); assert.deepEqual(saved(), { 'Fondo emergenze': 25000, Vacanze: 10000 });
  assert.equal(data.contributions.length, 4);
  await request(`/goals/${emergenze}`, { method: 'PUT', session: bob, body: { title: 'Fondo emergenze', horizon: 'short', target: 500000, monthly: 30000, primary: true } });
  data = await state(alice); assert.deepEqual(data.goals.filter(g => g.is_primary).map(g => g.title), ['Fondo emergenze']);

  // Filing a payee under Risparmio teaches it; moving it out stops it and releases the goals.
  const other = data.transactions.find(t => t.description === 'Cassa di Risparmio di Asti');
  await request(`/transactions/${other.id}`, { method: 'PUT', session: alice, body: { kind: 'expense', amount: 12000, categoryId: savingsCategory, description: other.description, date: other.date } });
  data = await state(alice); assert.deepEqual(saved(), { 'Fondo emergenze': 37000, Vacanze: 10000 }, 'the primary quota first, then the excess to the primary goal');
  provider.data.transactions['uid-a'].push(tx('p5', '80.00', 'DBIT', '2026-10-14', { creditor: { name: 'Cassa di Risparmio di Asti' }, remittance_information: ['Libretto'] }));
  await sync();
  const libretto = data.transactions.find(t => t.amount === 8000);
  assert.equal(libretto.category_id, savingsCategory);
  assert.equal(data.goals.find(g => g.title === 'Fondo emergenze').saved, 45000);
  await request(`/transactions/${libretto.id}`, { method: 'PUT', session: alice, body: { kind: 'expense', amount: 8000, categoryId: data.categories[0].id, description: libretto.description, date: libretto.date } });
  data = await state(alice); assert.equal(data.goals.find(g => g.title === 'Fondo emergenze').saved, 37000);
  assert.equal(instance.db.prepare("SELECT enabled FROM savings_destinations WHERE name = 'Cassa di Risparmio di Asti'").get().enabled, 0);
});

test('the owner marks a savings account: deposits become savings, its own movements stay out, its balance is apart', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  const TR = 'IT55T0300203280000000000777';
  provider.data.sessions.tr = [{ uid: 'uid-t', iban: TR, name: 'Deposito', currency: 'EUR', type: 'SVGS' }];
  provider.data.balances['uid-t'] = [{ balance_type: 'ITAV', balance_amount: { amount: '5000.00', currency: 'EUR' } }];
  provider.data.transactions = {
    'uid-t': [tx('etf', '290.00', 'DBIT', '2026-10-05', { creditor: { name: 'Acquisto ETF' } }), tx('in', '300.00', 'CRDT', '2026-10-04', { debtor_account: { iban: IBAN_A } })],
    'uid-a': [tx('t1', '300.00', 'DBIT', '2026-10-04', { creditor: { name: 'Bob' }, creditor_account: { iban: TR } }), tx('t3', '100.00', 'CRDT', '2026-10-09', { debtor_account: { iban: TR } })],
  };
  await request('/goals', { method: 'POST', session: bob, body: { title: 'Casa', horizon: 'long', target: 2000000, monthly: 50000 } });
  await link(bob, 'tr', 'shared');
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  const deposito = data.bank.accounts.find(a => a.name === 'Deposito');
  assert.equal(deposito.savings, false, 'never marked automatically, not even SVGS accounts');
  assert.equal(data.transactions.some(t => t.amount === 30000), false, 'until then the deposit is a giroconto');
  assert.equal(data.transactions.some(t => t.description === 'Acquisto ETF'), true);
  assert.equal((await request(`/bank/accounts/${deposito.id}`, { method: 'PATCH', session: alice, body: { savings: true } })).status, 404, 'only its owner marks it');
  assert.equal((await request(`/bank/accounts/${deposito.id}`, { method: 'PATCH', session: bob, body: { savings: true } })).status, 200);
  data = await state(alice);
  assert.equal(data.bank.accounts.find(a => a.name === 'Deposito').savings, true);
  const deposit = data.transactions.find(t => t.amount === 30000);
  assert.equal(deposit.kind, 'expense'); assert.equal(deposit.category_id, data.categories[5].id);
  assert.equal(data.goals[0].saved, 500000, 'the whole balance of the savings account goes to the goals, the deposit included');
  assert.equal(data.bank.savingsUnassigned, 0);
  assert.equal(data.transactions.some(t => t.description === 'Acquisto ETF'), false, 'purchases inside the savings account stay out of the budget');
  assert.equal(data.transactions.some(t => t.amount === 10000), false, 'withdrawals from savings are giroconti');
  assert.deepEqual([data.bank.total, data.bank.savingsTotal], [145055, 500000], 'savings balances are added up apart');
});

test('the savings balance is all assigned to goals; targeted deposits move automatic shares and new money follows the split', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  const TR = 'IT55T0300203280000000000777';
  provider.data.sessions.tr = [{ uid: 'uid-t', iban: TR, name: 'Deposito', currency: 'EUR', type: 'SVGS' }];
  provider.data.balances['uid-t'] = [{ balance_type: 'ITAV', balance_amount: { amount: '5000.00', currency: 'EUR' } }];
  provider.data.transactions = { 'uid-t': [] };
  const goal = async (title, monthly, target) => (await (await request('/goals', { method: 'POST', session: bob, body: { title, horizon: 'long', target, monthly } })).json()).id;
  const casa = await goal('Casa', 50000, 2000000);
  await link(bob, 'tr', 'shared');
  let data = await state(alice);
  const deposito = data.bank.accounts.find(a => a.name === 'Deposito');
  assert.equal(data.goals[0].saved, 0, 'nothing is assigned before the account is marked as savings');
  await request(`/bank/accounts/${deposito.id}`, { method: 'PATCH', session: bob, body: { savings: true } });
  const saved = async () => Object.fromEntries((await state(alice)).goals.map(g => [g.title, g.saved]));
  assert.deepEqual(await saved(), { Casa: 500000 });
  // A new goal does not take what is already assigned; a targeted deposit does, from the other goals.
  const auto = await goal('Auto', 20000, 300000);
  assert.deepEqual(await saved(), { Casa: 500000, Auto: 0 });
  assert.equal((await request(`/goals/${auto}/contributions`, { method: 'POST', session: alice, body: { amount: 100000 } })).status, 201);
  assert.deepEqual(await saved(), { Casa: 400000, Auto: 100000 });
  data = await state(alice);
  assert.deepEqual(data.contributions.filter(c => c.goal_id === auto).map(c => [c.amount, c.automatic]), [[100000, 0]]);
  assert.deepEqual(data.contributions.filter(c => c.goal_id === casa).map(c => [c.amount, c.automatic]), [[400000, 1]]);
  // New money covers this month's missing quotas first, then follows the quotas.
  const sync = async amount => {
    provider.data.balances['uid-t'] = [{ balance_type: 'ITAV', balance_amount: { amount, currency: 'EUR' } }];
    instance.db.prepare('UPDATE bank_connections SET last_attempt_at = ?').run('2026-01-01T00:00:00.000Z');
    await instance.bank.synchronizeAll();
  };
  await sync('5300.00');
  assert.deepEqual(await saved(), { Casa: 407143, Auto: 122857 });
  // A withdrawal gives back automatic shares only; the targeted deposit stays.
  await sync('1000.00');
  data = await state(alice);
  assert.equal(data.goals.reduce((sum, g) => sum + g.saved, 0), 100000);
  assert.deepEqual(data.contributions.filter(c => !c.automatic).map(c => c.amount), [100000]);
  // Targets cap the goals: what no goal can take stays visible as unassigned.
  await sync('30000.00');
  data = await state(alice);
  assert.deepEqual(Object.fromEntries(data.goals.map(g => [g.title, g.saved])), { Casa: 2000000, Auto: 300000 });
  assert.equal(data.bank.savingsUnassigned, 700000);
  // Deleting a goal frees its shares: with every target reached they stay unassigned.
  await request(`/goals/${auto}`, { method: 'DELETE', session: bob });
  assert.equal((await state(alice)).bank.savingsUnassigned, 1000000);
});

test('only current accounts with an IBAN are linked; one can be removed and stays hidden until the bank is unlinked', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  provider.data.sessions.alice = [
    { uid: 'uid-a', iban: IBAN_A, name: 'Conto Alice', currency: 'EUR', type: 'CACC' },
    { uid: 'uid-s', iban: 'IT77C0306909606100000000123', name: 'Conto secondario', currency: 'EUR', type: 'CACC' },
    { uid: 'uid-card', iban: null, name: 'Carta di credito', currency: 'EUR', type: 'CARD' },
    { uid: 'uid-prepaid', iban: 'IT12P0306909606100000000999', name: 'Carta prepagata con IBAN', currency: 'EUR', type: 'CARD' },
  ];
  provider.data.balances['uid-s'] = [{ balance_type: 'ITAV', balance_amount: { amount: '75.00', currency: 'EUR' } }];
  provider.data.balances['uid-card'] = [{ balance_type: 'ITAV', balance_amount: { amount: '-900.00', currency: 'EUR' } }];
  provider.data.transactions = { 'uid-a': [], 'uid-s': [tx('s1', '12.00', 'DBIT', '2026-10-05', { creditor: { name: 'Edicola' } })], 'uid-card': [tx('k1', '40.00', 'DBIT', '2026-10-05', { creditor: { name: 'Ristorante' } })] };
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  assert.deepEqual(data.bank.accounts.map(a => a.name).sort(), ['Conto Alice', 'Conto secondario'], 'cards are never linked');
  assert.equal(data.bank.total, 145055 + 7500);
  assert.equal(data.transactions.some(t => t.description === 'Ristorante'), false);
  const secondary = data.bank.accounts.find(a => a.name === 'Conto secondario');
  const main = data.bank.accounts.find(a => a.name === 'Conto Alice');
  assert.equal((await request(`/bank/accounts/${secondary.id}`, { method: 'DELETE', session: bob })).status, 404, 'only the owner removes an account');

  assert.equal((await request(`/bank/accounts/${secondary.id}`, { method: 'DELETE', session: alice })).status, 200);
  data = await state(alice);
  assert.deepEqual(data.bank.accounts.map(a => a.name), ['Conto Alice'], 'the bank stays linked');
  assert.equal(data.bank.total, 145055);
  assert.equal(data.transactions.some(t => t.description === 'Edicola'), false, 'records it imported leave with it');
  assert.deepEqual(data.bank.connections.map(c => Object.keys(c).sort()), [['bank', 'country', 'id', 'last_error', 'status', 'valid_until']], 'removed accounts are not listed');
  assert.deepEqual((await state(bob)).bank.connections, []);
  assert.equal((await request(`/bank/accounts/${main.id}`, { method: 'DELETE', session: alice })).status, 400, 'the last account is removed by unlinking the bank');

  // A renewed consent keeps it hidden; unlinking and linking again brings it back.
  await link(alice, 'alice', 'shared');
  data = await state(alice);
  assert.deepEqual(data.bank.accounts.map(a => a.name), ['Conto Alice']);
  assert.equal((await request(`/bank/connections/${data.bank.connections[0].id}`, { method: 'DELETE', session: alice })).status, 200);
  await link(alice, 'alice', 'shared');
  assert.deepEqual((await state(alice)).bank.accounts.map(a => a.name).sort(), ['Conto Alice', 'Conto secondario']);
  provider.data.sessions.bob = [{ uid: 'uid-card-b', iban: null, name: 'Carta Bob', currency: 'EUR', type: 'CARD' }];
  assert.equal((await link(bob, 'bob', 'shared')).headers.get('location'), '/?banca=nessun-conto#bank', 'a consent with cards only links nothing');
});

test('accounts removed by earlier versions are read once more and leave with what they imported', async () => {
  await start({ bankProvider: provider });
  const { alice } = await family();
  provider.data.sessions.alice = [
    { uid: 'uid-a', iban: IBAN_A, name: 'Conto Alice', currency: 'EUR', type: 'CACC' },
    { uid: 'uid-s', iban: 'IT77C0306909606100000000123', name: 'Conto secondario', currency: 'EUR', type: 'CACC' },
  ];
  provider.data.transactions = { 'uid-a': [], 'uid-s': [tx('s1', '12.29', 'DBIT', '2026-10-05', { creditor: { name: 'Edicola' } }), tx('s2', '50.00', 'CRDT', '2026-10-06', { debtor: { name: 'Mario Rossi' } })] };
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  const groceries = data.categories[0];
  await request('/transactions', { method: 'POST', session: alice, body: { kind: 'expense', amount: 1229, categoryId: groceries.id, description: 'Giornali', date: '2026-10-05' } });
  // The old removal kept the imports and dropped the account with its bank copies.
  const secondary = instance.db.prepare("SELECT * FROM bank_accounts WHERE name = 'Conto secondario'").get();
  const user = instance.db.prepare("SELECT c.user_id FROM bank_connections c WHERE c.id = ?").get(secondary.connection_id);
  instance.db.prepare('INSERT INTO bank_account_exclusions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ex-1', secondary.household_id, user.user_id, `iban:${secondary.iban_hash}`, secondary.connection_id, secondary.provider_uid, secondary.name, secondary.iban_hash, secondary.iban_last4, 'EUR', new Date().toISOString());
  instance.db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(secondary.id);
  data = await state(alice);
  assert.deepEqual(data.transactions.map(t => t.description).sort(), ['Edicola', 'Giornali', 'Mario Rossi']);
  assert.deepEqual(unclassified(data).map(t => [t.description, t.amount, t.bank_account]), [['Edicola', 1229, null]]);

  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  data = await state(alice);
  assert.deepEqual(data.transactions.map(t => t.description), ['Giornali'], 'only what the removed account imported is deleted');
  const reads = provider.calls.filter(c => c[0] === 'transactions' && c[1] === 'uid-s').length;
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  await request('/bank/refresh', { method: 'POST', session: alice });
  assert.equal(provider.calls.filter(c => c[0] === 'transactions' && c[1] === 'uid-s').length, reads, 'the removed account is read only once');
});

test('cards linked before the IBAN rule are removed with their imported records', async () => {
  await start({ bankProvider: provider });
  const { alice } = await family();
  provider.data.transactions = { 'uid-a': [] };
  await link(alice, 'alice', 'shared');
  const connection = instance.db.prepare('SELECT id FROM bank_connections').get().id;
  const hid = alice.user.householdId;
  instance.db.prepare(`INSERT INTO bank_accounts (id, household_id, connection_id, provider_uid, name, iban_hash, iban_last4, currency, visibility, import_from, created_at, balance)
    VALUES ('card', ?, ?, 'uid-old-card', 'Carta', NULL, NULL, 'EUR', 'shared', '2026-10-01', '2026-10-01', -90000)`).run(hid, connection);
  instance.db.prepare(`INSERT INTO transactions VALUES ('t-card', ?, 'expense', 4000, NULL, 'Ristorante', '2026-10-05', ?, '2026-10-05')`).run(hid, alice.user.id);
  instance.db.prepare(`INSERT INTO bank_movements (id, household_id, account_id, external_id, kind, amount, date, description, match_key, status, transaction_id, created_at)
    VALUES ('m-card', ?, 'card', 'e:k1', 'expense', 4000, '2026-10-05', 'Ristorante', 'ristorante', 'imported', 't-card', '2026-10-05')`).run(hid);
  assert.equal((await state(alice)).bank.total, 145055 - 90000);
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  const data = await state(alice);
  assert.deepEqual(data.bank.accounts.map(a => a.name), ['Conto Alice']);
  assert.equal(data.bank.total, 145055);
  assert.equal(data.transactions.some(t => t.description === 'Ristorante'), false);
});

test('new bank expenses to classify are notified to who can see them; a failing link to its owner', async () => {
  const sent = [];
  await start({ bankProvider: provider, pushSender: async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) }); } });
  const { alice, bob } = await family();
  for (const [session, name] of [[alice, 'alice'], [bob, 'bob']])
    await request('/notifications/subscriptions', { method: 'POST', session, body: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}-device`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } } });
  provider.data.transactions = { 'uid-a': [tx('n1', '60.00', 'DBIT', '2026-10-14', { creditor: { name: 'Negozio Vario' } })], 'uid-b': [tx('b1', '25.00', 'DBIT', '2026-10-14', { creditor: { name: 'Libreria Centrale' } })] };
  await link(alice, 'alice', 'shared');
  await link(bob, 'bob', 'balance');
  await request('/bank/refresh', { method: 'POST', session: alice }); await instance.notifications.idle();
  const bodies = name => sent.filter(m => m.endpoint.includes(`/${name}-`) && m.url === '#expenses').map(m => [m.title, m.body]);
  assert.deepEqual(bodies('alice'), [['Un’uscita da classificare', 'Negozio Vario. Scegli la categoria in Uscite.']], 'others\' private expenses stay private');
  assert.deepEqual(bodies('bob'), [['Un’uscita da classificare', 'Negozio Vario. Scegli la categoria in Uscite.'], ['Un’uscita da classificare', 'Libreria Centrale. Scegli la categoria in Uscite.']], 'his own private expense too');
  await request('/bank/refresh', { method: 'POST', session: alice }); await instance.notifications.idle();
  assert.equal(sent.filter(m => m.url === '#expenses').length, 3, 'each expense is notified once');
  instance.db.prepare("UPDATE bank_connections SET status = 'expired' WHERE user_id = ?").run(bob.user.id);
  await request('/shopping', { method: 'POST', session: alice, body: { name: 'Latte', quantity: '', section: 'Altro' } }); await instance.notifications.idle();
  assert.deepEqual(sent.filter(m => m.url === '#settings/conti').map(m => [m.endpoint.includes('/bob-'), m.body]), [[true, 'Il consenso è scaduto: rinnova il collegamento.']]);
});

test('the real balance line is a personal preference, off by default', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  const standard = { quickActions: false, dashboard: { order: ['income', 'expense', 'balance', 'savings', 'spending', 'advice', 'home', 'goals', 'recent', 'comparison'], hidden: [] } };
  assert.deepEqual((await state(alice)).preferences, { showBankBalance: false, ...standard });
  assert.equal((await request('/preferences', { method: 'PUT', session: alice, body: { showBankBalance: 'yes' } })).status, 400);
  assert.equal((await request('/preferences', { method: 'PUT', session: alice, body: { showBankBalance: true } })).status, 200);
  assert.deepEqual((await state(alice)).preferences, { showBankBalance: true, ...standard });
  assert.deepEqual((await state(bob)).preferences, { showBankBalance: false, ...standard }, 'each account keeps its own choice');
  // The overview: quick buttons, hidden cards and their order, per account.
  const dashboard = body => request('/preferences/dashboard', { method: 'PUT', session: alice, body });
  const order = ['recent', 'goals', 'income'];
  assert.equal((await dashboard({ quickActions: true, order, hidden: ['savings'] })).status, 200);
  assert.deepEqual((await state(alice)).preferences, { showBankBalance: true, quickActions: true, dashboard: { order: ['recent', 'goals', 'income', 'expense', 'balance', 'savings', 'spending', 'advice', 'home', 'comparison'], hidden: ['savings'] } }, 'cards left out keep their default order after the chosen ones');
  assert.deepEqual((await state(bob)).preferences, { showBankBalance: false, ...standard });
  for (const body of [{ quickActions: 'yes', order: [], hidden: [] }, { quickActions: true, order: ['income', 'income'], hidden: [] }, { quickActions: true, order: [], hidden: ['unknown'] }, { quickActions: true, order: 'income', hidden: [] }])
    assert.equal((await dashboard(body)).status, 400);
  assert.equal((await request('/preferences/dashboard', { method: 'PUT', body: { quickActions: true, order: [], hidden: [] } })).status, 401);
  assert.equal((await request('/preferences', { method: 'PUT', body: { showBankBalance: true } })).status, 401);
});

test('imported expenses are classified from Uscite, teaching later imports and respecting privacy', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  provider.data.transactions = { 'uid-a': [tx('n1', '60.00', 'DBIT', '2026-10-08', { creditor: { name: 'Negozio Vario' } })],
    'uid-b': [tx('b1', '25.00', 'DBIT', '2026-10-07', { creditor: { name: 'Libreria Centrale' } })] };
  await link(alice, 'alice', 'shared');
  await link(bob, 'bob', 'balance');
  let data = await state(alice);
  assert.deepEqual(unclassified(data).map(t => t.description), ['Negozio Vario']);
  assert.deepEqual(data.transactions.filter(t => t.privacy === 'others').map(t => [t.description, t.amount, t.category_id]), [['Spese di bob', 2500, null]], 'others\' private expenses only as a total');
  const item = unclassified(data)[0];
  const casa = data.categories[0].id;
  const edit = (session, id, categoryId, record = item) => request(`/transactions/${id}`, { method: 'PUT', session, body: { kind: 'expense', amount: record.amount, categoryId, description: record.description, date: record.date } });
  const bobsOwn = (await state(bob)).transactions.find(t => t.description === 'Libreria Centrale');
  assert.equal((await edit(alice, bobsOwn.id, casa, bobsOwn)).status, 404, 'others\' private records cannot be classified');
  const eve = await register('eve@example.it');
  const evesCategory = (await state(eve)).categories[0].id;
  assert.equal((await edit(eve, item.id, evesCategory)).status, 404);
  assert.equal((await edit(alice, item.id, evesCategory)).status, 404, 'categories of another family are refused');
  assert.equal((await edit(alice, item.id, casa)).status, 200);
  data = await state(alice);
  assert.equal(unclassified(data).length, 0);
  assert.equal(data.transactions.find(t => t.id === item.id).category_id, casa);
  provider.data.transactions['uid-a'].push(tx('n2', '15.00', 'DBIT', '2026-10-12', { creditor: { name: 'NEGOZIO VARIO' } }));
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  await request('/bank/refresh', { method: 'POST', session: alice });
  assert.equal((await state(alice)).transactions.find(t => t.amount === 1500).category_id, casa, 'the next import learns the choice');
});

test('the history fetched before the link is imported from its first whole month, also for accounts linked earlier', async () => {
  await start({ bankProvider: provider });
  const { alice } = await family();
  const TR = 'IT55T0300203280000000000777';
  await request('/goals', { method: 'POST', session: alice, body: { title: 'Vacanze', horizon: 'short', target: 100000, monthly: 10000, primary: true } });
  provider.data.transactions = { 'uid-a': [
    tx('old', '25.00', 'DBIT', '2026-07-20', { creditor: { name: 'Libreria' } }),
    tx('aug', '200.00', 'DBIT', '2026-08-02', { creditor: { name: 'Trade Republic Bank GmbH' }, creditor_account: { iban: TR }, remittance_information: ['PAC agosto'] }),
    tx('sep', '15.00', 'DBIT', '2026-09-20', { creditor: { name: 'Farmacia Centrale' } }),
    tx('oct', '42.30', 'DBIT', '2026-10-03', { creditor: { name: 'CONAD SUPERSTORE' } }),
  ], 'uid-b': [] };
  await link(alice, 'alice', 'shared');
  let data = await state(alice);
  const savingsCategory = data.categories[5].id;
  assert.equal(data.bank.accounts[0].import_from, '2026-08-01');
  assert.deepEqual((await state(alice, '2026-07')).transactions, [], 'July is only partly fetched and stays out');
  assert.deepEqual(movements("m.description = 'Libreria'").map(m => m.status), ['stored']);
  const august = (await state(alice, '2026-08')).transactions;
  assert.deepEqual(august.map(t => [t.description, t.amount, t.category_id]), [['Trade Republic Bank GmbH', 20000, savingsCategory]]);
  assert.equal(data.goals[0].saved, 0, 'deposits made before the link do not fill the goals again');
  assert.deepEqual(data.history.slice(-3).map(m => m.expense), [20000, 1500, 4230]);

  // An account linked when only the linking month was imported takes its history at the next sync.
  for (const m of movements("m.date < '2026-10-01'")) {
    if (m.transaction_id) instance.db.prepare('DELETE FROM transactions WHERE id = ?').run(m.transaction_id);
    instance.db.prepare("UPDATE bank_movements SET status = 'stored', transaction_id = NULL WHERE id = ?").run(m.id);
  }
  instance.db.prepare("UPDATE bank_accounts SET import_from = '2026-10-01'").run();
  assert.deepEqual((await state(alice, '2026-09')).transactions, []);
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  data = await state(alice);
  assert.equal(data.bank.accounts[0].import_from, '2026-08-01');
  assert.deepEqual((await state(alice, '2026-09')).transactions.map(t => t.description), ['Farmacia Centrale']);
  assert.deepEqual((await state(alice, '2026-08')).transactions.map(t => t.description), ['Trade Republic Bank GmbH']);
  assert.equal(data.goals[0].saved, 0);
  assert.equal(data.transactions.filter(t => t.description === 'CONAD SUPERSTORE').length, 1);
});

test('salaries credited before a recurring income started join it in their own months', async () => {
  await start({ bankProvider: provider });
  const { alice } = await family();
  provider.data.transactions = { 'uid-a': [
    tx('aug', '1800.00', 'CRDT', '2026-08-27', { debtor: { name: 'Azienda Srl' } }),
    tx('aug-refund', '50.00', 'CRDT', '2026-08-12', { debtor: { name: 'Azienda Srl' } }),
    tx('sep', '1820.50', 'CRDT', '2026-09-26', { debtor: { name: 'Azienda Srl' } }),
    tx('sale', '1790.00', 'CRDT', '2026-09-10', { debtor: { name: 'Mario Bianchi' }, remittance_information: ['Vendita auto'] }),
  ], 'uid-b': [] };
  await link(alice, 'alice', 'shared');
  assert.equal((await request('/recurring', { method: 'POST', session: alice, body: { kind: 'income', name: 'Stipendio', amount: 180000, day: 27, startMonth: '2026-10', enabled: true } })).status, 201);
  let september = await state(alice, '2026-09');
  assert.equal(september.transactions.some(t => t.recurring_id), false);
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  september = await state(alice, '2026-09');
  const august = await state(alice, '2026-08');
  const recurring = data => data.transactions.filter(t => t.recurring_id).map(t => [t.description, t.amount, t.date]);
  assert.deepEqual(recurring(september), [['Azienda Srl', 182050, '2026-09-26']], 'the sale stays one-off');
  assert.deepEqual(recurring(august), [['Azienda Srl', 180000, '2026-08-27']], 'the smaller credit from the employer stays one-off');
  assert.deepEqual(september.history.slice(-2).map(m => m.budgetIncome), [180000, 182050]);
  assert.equal(september.budgetFallback, null);
  const october = await state(alice);
  assert.deepEqual(recurring(october), [['Stipendio', 180000, '2026-10-27']], 'the rule still starts in October');
  assert.equal(october.recurring[0].start_month, '2026-10');
  instance.db.prepare('UPDATE bank_connections SET last_attempt_at = NULL').run();
  assert.equal((await request('/bank/refresh', { method: 'POST', session: alice })).status, 200);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM recurring_occurrences').get().count, 3, 'linking again changes nothing');
});
