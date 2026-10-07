import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createApp } from '../server/app.mjs';
import { enableBankingProvider, normalizeTransactions, parseAmount, pickBalance, ruleCategory } from '../server/bank.mjs';

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
    async createSession(code) { calls.push(['session', code]); return { sessionId: `sess-${code}`, validUntil: '2027-04-10T10:00:00Z', accounts: sessions[code] || [] }; },
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
  assert.deepEqual(data.bank, { configured: false, total: 0, accounts: [], movements: [] });
});

test('linking shared and balance-only accounts builds a family total, imports and reconciles shared movements', async () => {
  await start({ bankProvider: provider });
  const { alice, bob } = await family();
  assert.equal((await request('/bank/banks')).status, 401);
  assert.deepEqual((await (await request('/bank/banks', { session: alice })).json()).banks.map(b => b.name), ['Banca Due', 'Intesa Sanpaolo']);
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
  assert.equal((await state(alice, '2026-09')).transactions.length, 0, 'movements before the linking month are not imported');
  assert.equal(data.bank.movements.find(m => m.description === 'CONAD SUPERSTORE').status, 'matched');
  assert.equal(data.bank.movements.some(m => m.description === 'In attesa'), false);

  // Bob keeps his movements private: they count in the budget, Alice only sees totals.
  assert.equal((await link(bob, 'bob', 'balance')).headers.get('location'), '/?banca=collegato#bank');
  data = await state(alice);
  assert.equal(data.bank.total, 145055 - 2010);
  const bobAccount = data.bank.accounts.find(a => a.name === 'Conto Bob');
  assert.equal(bobAccount.mine, false); assert.equal(bobAccount.balance, -2010);
  assert.equal(data.bank.movements.some(m => m.account_id === bobAccount.id), false);
  assert.equal(data.transactions.some(t => t.description === 'Pizzeria Da Mario'), false);
  const totals = data.transactions.find(t => t.privacy === 'others');
  assert.deepEqual({ description: totals.description, amount: totals.amount, category: totals.category_id, kind: totals.kind }, { description: 'Spese di bob', amount: 3300, category: data.categories[4].id, kind: 'expense' });
  assert.equal(JSON.stringify(data.transactions).includes('Pizzeria'), false);
  assert.equal(data.transactions.some(t => t.description === 'Bonifico a Bob' || t.description === 'Da Alice'), false, 'transfers between family accounts are giroconti, even when private');
  const bobView = await state(bob);
  const pizza = bobView.transactions.find(t => t.description === 'Pizzeria Da Mario');
  assert.equal(pizza.privacy, 'mine'); assert.equal(pizza.author, 'bob');
  assert.equal(bobView.bank.movements.filter(m => m.account_id === bobAccount.id).length, 2);
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
  assert.deepEqual(data.bank.movements.filter(m => m.status === 'transfer').map(m => m.description).sort(), ['Bonifico a Bob', 'Da Alice']);

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
