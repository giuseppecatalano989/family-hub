import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { resetEmailSender } from '../server/reset-email.mjs';
import { snapshotInstance } from '../server/backups.mjs';

let app, server, base, root, messages, sendFails, mailGate, background;
beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'family-hub-recovery-'));
  messages = []; sendFails = false; mailGate = undefined; background = [];
  app = createApp({ dataDir: path.join(root, 'data'), scheduleResetDelivery: promise => background.push(promise), resetMailer: async message => { if (mailGate) await mailGate; if (sendFails) throw new Error('Private provider response'); messages.push(message); } });
  server = app.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => { await Promise.all(background); await new Promise(resolve => server.close(resolve)); app.close(); rmSync(root, { recursive: true, force: true }); });
async function request(route, body, session, method = 'POST') {
  return fetch(base + route, { method, headers: { 'x-requested-with': 'Casa', ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function register(email = 'alice@example.test') {
  const result = await request('/auth/register', { name: 'Alice', email, password: 'old-password-123', householdName: 'Casa test' });
  assert.equal(result.status, 201);
  return { ...(await result.json()), cookie: result.headers.get('set-cookie').split(';')[0] };
}
const forgot = email => request('/auth/forgot-password', { email });
const reset = (token, newPassword = 'new-password-456') => request('/auth/reset-password', { token, newPassword });

test('email recovery is private, rate limited per recipient and keeps only hashed tokens', async () => {
  await register();
  const known = await forgot('ALICE@example.test'); const unknown = await forgot('unknown@example.test');
  assert.equal(known.status, 200); assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(messages.length, 1); assert.equal(messages[0].email, 'alice@example.test');
  assert.match(messages[0].url, /^https:\/\/family-hub-giuseppecatalano.vercel.app\/#reset=[a-f0-9]{64}$/);
  const stored = app.db.prepare('SELECT * FROM password_resets').get();
  assert.notEqual(stored.token_hash, messages[0].token); assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.ok(stored.expires > Date.now() && stored.expires <= Date.now() + 30 * 60000);
  assert.equal((await forgot('alice@example.test')).status, 200); assert.equal(messages.length, 1);
  assert.equal((await forgot('invalid')).status, 400);
});

test('a reset is single use, revokes all target sessions, preserves family data and cannot reset another account', async () => {
  const alice = await register(); const bob = await register('bob@example.test');
  const login = await request('/auth/login', { email: 'alice@example.test', password: 'old-password-123' });
  const extra = { cookie: login.headers.get('set-cookie').split(';')[0] };
  await forgot('alice@example.test'); const token = messages[0].token;
  assert.equal((await reset(token, 'short')).status, 400);
  const responses = await Promise.all([reset(token), reset(token)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal((await request('/session', null, alice, 'GET')).status, 200);
  assert.equal((await (await request('/session', null, alice, 'GET')).json()).user, null);
  assert.equal((await (await request('/session', null, extra, 'GET')).json()).user, null);
  assert.equal((await request('/state?month=2026-10', null, bob, 'GET')).status, 200);
  assert.equal((await request('/auth/login', { email: 'alice@example.test', password: 'old-password-123' })).status, 401);
  const fresh = await request('/auth/login', { email: 'alice@example.test', password: 'new-password-456' });
  assert.equal(fresh.status, 200); assert.equal((await fresh.json()).user.householdId, alice.user.householdId);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM categories WHERE household_id = ?').get(alice.user.householdId).count, 6);
});

test('expired and replaced links cannot change credentials', async () => {
  await register(); await forgot('alice@example.test'); const old = messages[0].token;
  app.db.prepare('UPDATE password_resets SET expires = ?').run(Date.now() - 1);
  assert.equal((await reset(old)).status, 400);
  await forgot('alice@example.test'); assert.equal(messages.length, 2);
  assert.equal((await reset('0'.repeat(64))).status, 400);
  assert.equal((await reset(old)).status, 400);
  assert.equal((await reset(messages[1].token)).status, 200);
});

test('changing email or password invalidates pending recovery links', async () => {
  const alice = await register(); await forgot('alice@example.test'); const first = messages[0].token;
  assert.equal((await request('/account', { name: 'Alice', email: 'new@example.test', currentPassword: 'old-password-123' }, alice, 'PUT')).status, 200);
  assert.equal((await reset(first)).status, 400);
  await forgot('new@example.test'); const second = messages[1].token;
  assert.equal((await request('/account/password', { currentPassword: 'old-password-123', newPassword: 'changed-password-789' }, alice, 'PUT')).status, 200);
  assert.equal((await reset(second)).status, 400);
});

test('failed delivery does not disclose account existence or retain unusable links', async () => {
  await register(); sendFails = true;
  const known = await forgot('alice@example.test'); const unknown = await forgot('unknown@example.test');
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM password_resets').get().count, 0);
  sendFails = false; await forgot('alice@example.test'); assert.equal(messages.length, 1);
});

test('backup snapshots exclude recovery tokens without changing the live database', async () => {
  await register(); await forgot('alice@example.test');
  const destination = path.join(root, 'snapshot');
  snapshotInstance(app.db, path.join(root, 'data'), destination);
  const copy = new DatabaseSync(path.join(destination, 'casa.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM password_resets').get().count, 0); }
  finally { copy.close(); }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM password_resets').get().count, 1);
});

test('Resend adapter uses a verified sender and does not expose provider errors', async () => {
  assert.equal(resetEmailSender({ apiKey: '', from: '' }), null);
  assert.throws(() => resetEmailSender({ apiKey: 'test-key', from: 'bad\r\nsender' }));
  let sent;
  const sender = resetEmailSender({ apiKey: 'test-key', from: 'Family Hub <account@example.test>', fetcher: async (url, options) => { sent = { url, options }; return { ok: true }; } });
  await sender({ email: 'member@example.test', url: 'https://example.test/#reset=abc' });
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(sent.options.body).to, ['member@example.test']);
  assert.match(JSON.parse(sent.options.body).text, /30 minuti/);
  const failSender = resetEmailSender({ apiKey: 'test-key', from: 'account@example.test', fetcher: async () => ({ ok: false }) });
  await assert.rejects(failSender({ email: 'member@example.test', url: 'https://example.test/' }), /Invio email non riuscito/);
});

test('Brevo adapter supports an individually verified email sender', async () => {
  let sent;
  const sender = resetEmailSender({ provider: 'brevo', apiKey: 'test-key', from: 'Family Hub <sender@example.test>', fetcher: async (url, options) => { sent = { url, options }; return { ok: true }; } });
  await sender({ email: 'member@example.test', url: 'https://example.test/#reset=abc' });
  assert.equal(sent.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(sent.options.headers['api-key'], 'test-key');
  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.sender, { name: 'Family Hub', email: 'sender@example.test' });
  assert.deepEqual(body.to, [{ email: 'member@example.test' }]);
  assert.match(body.textContent, /30 minuti/);
});

test('generic recovery responses do not wait for background email delivery', async () => {
  await register();
  let release;
  mailGate = new Promise(resolve => { release = resolve; });
  try {
    const result = await forgot('alice@example.test');
    assert.equal(result.status, 200);
    assert.equal(messages.length, 0); assert.equal(background.length, 1);
    release(); await Promise.all(background);
    assert.equal(messages.length, 1);
  } finally { release(); }
});

test('recovery status and requests report unavailable email configuration honestly', async () => {
  const disabled = createApp({ dataDir: path.join(root, 'disabled'), resetMailer: null });
  const other = disabled.app.listen(0, '127.0.0.1');
  await new Promise(resolve => other.once('listening', resolve));
  const origin = `http://127.0.0.1:${other.address().port}/api/auth`;
  try {
    assert.deepEqual(await (await fetch(`${origin}/recovery-status`)).json(), { available: false });
    const result = await fetch(`${origin}/forgot-password`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'Casa' }, body: JSON.stringify({ email: 'any@example.test' }) });
    assert.equal(result.status, 503);
  } finally { await new Promise(resolve => other.close(resolve)); disabled.close(); }
});
