import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { allocateBudget } from '../server/notifications.mjs';

// Thursday 15 October 2026, 20:00 in Rome.
let now = Date.parse('2026-10-15T18:00:00Z');
let instance, server, base, dataDir, sent, failing;
const device = name => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${'x'.repeat(20)}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
async function start() {
  sent = []; failing = new Map();
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-push-'));
  const sender = async (subscription, payload, keys) => {
    if (failing.has(subscription.endpoint)) throw Object.assign(new Error('gone'), { statusCode: failing.get(subscription.endpoint) });
    assert.ok(keys.publicKey && keys.privateKey && keys.subject);
    sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
  };
  instance = createApp({ dataDir, clock: () => now, pushSender: sender });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
afterEach(async () => {
  await instance?.notifications.idle();
  if (server) await new Promise(resolve => server.close(resolve));
  instance?.close(); if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  server = instance = dataDir = undefined; now = Date.parse('2026-10-15T18:00:00Z');
});
async function request(route, { method = 'GET', body, session } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'Casa', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  await instance.notifications.idle();
  return response;
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
const state = async session => (await request('/state?month=2026-10&week=2026-10-12', { session })).json();
const subscribe = (session, name) => request('/notifications/subscriptions', { method: 'POST', session, body: device(name) });
const to = name => sent.filter(m => m.endpoint.includes(`/${name}-`));

test('budget rounding matches the interface', () => {
  assert.deepEqual(allocateBudget(100001, [{ id: 'a', percentage: 3333 }, { id: 'b', percentage: 3333 }, { id: 'c', percentage: 3334 }]), { a: 33330, b: 33330, c: 33341 });
});

test('devices subscribe only to browser push services; choices are personal and validated', async () => {
  await start();
  const { alice, bob } = await family();
  const initial = (await state(alice)).notifications;
  assert.match(initial.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.deepEqual(initial.types, { notes: true, shopping: true, meals: true, deadlines: true, budget: true, waste: true, calendar: true, bank: true });
  assert.equal(initial.devices, 0);
  assert.equal((await state(bob)).notifications.publicKey, initial.publicKey, 'one key pair for the whole instance');
  assert.equal((await request('/notifications/subscriptions', { method: 'POST', body: device('x') })).status, 401);
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/push', 'https://evil.example/fcm.googleapis.com', 'not a url'])
    assert.equal((await request('/notifications/subscriptions', { method: 'POST', session: alice, body: { ...device('x'), endpoint } })).status, 400, endpoint);
  assert.equal((await request('/notifications/subscriptions', { method: 'POST', session: alice, body: { ...device('x'), keys: { p256dh: 'short', auth: 'a'.repeat(22) } } })).status, 400);
  assert.equal((await subscribe(alice, 'alice')).status, 201);
  assert.equal((await request('/notifications/subscriptions', { method: 'POST', session: alice, body: { ...device('apple'), endpoint: 'https://web.push.apple.com/QGuQyavXutnMH' } })).status, 201);
  assert.equal((await state(alice)).notifications.devices, 2);
  assert.equal((await state(bob)).notifications.devices, 0);
  assert.equal((await request('/notifications/preferences', { method: 'PUT', session: alice, body: { types: { shopping: 'no' } } })).status, 400);
  assert.equal((await request('/notifications/preferences', { method: 'PUT', session: alice, body: { types: { unknown: true } } })).status, 400);
  assert.equal((await request('/notifications/preferences', { method: 'PUT', session: alice, body: { types: { shopping: false } } })).status, 200);
  assert.equal((await state(alice)).notifications.types.shopping, false);
  assert.equal((await state(bob)).notifications.types.shopping, true);
  assert.equal((await request('/notifications/test', { method: 'POST', session: bob })).status, 400, 'no device yet');
  assert.equal((await request('/notifications/test', { method: 'POST', session: alice })).status, 200);
  assert.equal(sent.filter(m => m.tag === 'test').length, 2, 'a test notice reaches each device');
  await request('/notifications/subscriptions', { method: 'DELETE', session: alice, body: { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH' } });
  assert.equal((await state(alice)).notifications.devices, 1);
});

test('family changes reach the other members once per quarter of an hour, never the author', async () => {
  await start();
  const { alice, bob } = await family();
  await subscribe(alice, 'alice'); await subscribe(bob, 'bob');
  await request('/shopping', { method: 'POST', session: bob, body: { name: 'Latte', quantity: '', section: 'Frigo e freschi' } });
  await request('/shopping', { method: 'POST', session: bob, body: { name: 'Pane', quantity: '', section: 'Altro' } });
  assert.deepEqual(to('alice').map(m => [m.title, m.body, m.url]), [['Lista della spesa', 'bob ha aggiornato la lista della spesa.', '#shopping']]);
  assert.equal(to('bob').length, 0);
  await request('/notes', { method: 'POST', session: bob, body: { title: 'Idraulico', content: 'Giovedì', color: 'mint', pinned: false } });
  assert.deepEqual(to('alice').map(m => m.title), ['Lista della spesa', 'Lavagna di famiglia']);
  now += 16 * 60000;
  await request('/shopping', { method: 'POST', session: bob, body: { name: 'Uova', quantity: '', section: 'Altro' } });
  assert.equal(to('alice').filter(m => m.url === '#shopping').length, 2, 'a later change is notified again');
  await request('/notifications/preferences', { method: 'PUT', session: alice, body: { types: { notes: false } } });
  now += 16 * 60000;
  await request('/notes', { method: 'POST', session: bob, body: { title: 'Bollette', content: '', color: 'mint', pinned: false } });
  assert.equal(to('alice').filter(m => m.url === '#notes').length, 1, 'turned off');
  await request('/shopping', { method: 'POST', session: alice, body: { name: 'Sale', quantity: '', section: 'Altro' } });
  assert.deepEqual(to('bob').map(m => m.body), ['alice ha aggiornato la lista della spesa.']);
  // A device that the push service no longer knows is forgotten.
  failing.set(device('alice').endpoint, 410);
  now += 16 * 60000;
  await request('/shopping', { method: 'POST', session: bob, body: { name: 'Riso', quantity: '', section: 'Altro' } });
  assert.equal((await state(alice)).notifications.devices, 0);
});

test('a category over budget is notified once a month to everyone who wants it', async () => {
  await start();
  const { alice, bob } = await family();
  await subscribe(alice, 'alice'); await subscribe(bob, 'bob');
  await request('/notifications/preferences', { method: 'PUT', session: bob, body: { types: { budget: false } } });
  const categories = (await state(alice)).categories;
  await request('/recurring', { method: 'POST', session: alice, body: { kind: 'income', name: 'Stipendio', amount: 100000, startMonth: '2026-10', day: 1, enabled: true } });
  await state(alice);
  const limit = allocateBudget(100000, categories)[categories[1].id];
  const spend = amount => request('/transactions', { method: 'POST', session: bob, body: { kind: 'expense', amount, categoryId: categories[1].id, description: 'Spesa', date: '2026-10-14' } });
  await spend(limit);
  assert.equal(sent.filter(m => m.url === '#budget').length, 0, 'reaching the budget is fine');
  await spend(1);
  const notices = sent.filter(m => m.url === '#budget');
  assert.deepEqual(notices.map(m => [m.endpoint.includes('/alice-'), m.title]), [[true, `Budget superato: ${categories[1].name}`]]);
  await spend(500);
  assert.equal(sent.filter(m => m.url === '#budget').length, 1, 'once per category and month');
});

test('the evening round warns about tomorrow’s collection and deadlines, once', async () => {
  await start();
  const { alice, bob } = await family();
  await subscribe(alice, 'alice'); await subscribe(bob, 'bob');
  await request('/notifications/preferences', { method: 'PUT', session: bob, body: { types: { waste: false } } });
  await request('/waste', { method: 'POST', session: alice, body: { name: 'Plastica', days: [4], timeWindow: 'dalle 20 alle 24', notes: '', color: '#176854' } });
  await request('/waste', { method: 'POST', session: alice, body: { name: 'Vetro', days: [1], timeWindow: '', notes: '', color: '#8099b0' } });
  await request('/deadlines', { method: 'POST', session: alice, body: { name: 'Assicurazione', frequency: 'once', startDate: '2026-10-18', requiresPayment: false, reminderDays: 5 } });
  await request('/deadlines', { method: 'POST', session: alice, body: { name: 'Bollo auto', frequency: 'once', startDate: '2026-10-10', requiresPayment: false, reminderDays: 0 } });
  await request('/deadlines', { method: 'POST', session: alice, body: { name: 'Revisione', frequency: 'once', startDate: '2026-11-30', requiresPayment: false, reminderDays: 3 } });
  sent.length = 0;
  await instance.notifications.evening();
  assert.deepEqual(to('alice').filter(m => m.url === '#waste').map(m => [m.title, m.body]), [['Domani: Plastica', 'Plastica: dalle 20 alle 24']]);
  assert.equal(to('bob').filter(m => m.url === '#waste').length, 0);
  assert.deepEqual(to('bob').filter(m => m.url === '#bills').map(m => m.title).sort(), ['In scadenza: Assicurazione', 'Scaduta: Bollo auto']);
  await instance.notifications.evening();
  assert.equal(to('alice').length, 3, 'nothing is repeated');
});

test('calendar events reach the family once: changes by others and the evening before', async () => {
  await start();
  const { alice, bob } = await family();
  await subscribe(alice, 'alice'); await subscribe(bob, 'bob');
  const event = { title: 'Pediatra', startDate: '2026-10-16', startTime: '17:30', endTime: '', recurrence: 'none', location: 'Via Roma 1', notes: '', color: '#176854' };
  await request('/calendar', { method: 'POST', session: alice, body: event });
  await request('/calendar', { method: 'POST', session: alice, body: { ...event, title: 'Calcetto', startDate: '2026-10-02', startTime: '', location: '', recurrence: 'weekly' } });
  await request('/calendar', { method: 'POST', session: alice, body: { ...event, title: 'Gita', startDate: '2026-10-15', endDate: '2026-10-17', startTime: '' } });
  assert.deepEqual(to('bob').filter(m => m.url === '#calendar').map(m => m.body), ['alice ha aggiornato il calendario.'], 'one notice every 15 minutes');
  assert.equal(to('alice').filter(m => m.url === '#calendar').length, 0, 'never to the author');
  sent.length = 0;
  await instance.notifications.evening();
  // Tomorrow is Friday 16: the weekly event and the timed one; the trip started today.
  assert.deepEqual(to('bob').filter(m => m.url === '#calendar').map(m => [m.title, m.body]), [['Domani: 2 eventi in calendario', 'Calcetto · 17:30 Pediatra (Via Roma 1)']]);
  await request('/notifications/preferences', { method: 'PUT', session: alice, body: { types: { calendar: false } } });
  now += 86400000; sent.length = 0;
  await instance.notifications.evening();
  assert.equal(sent.filter(m => m.url === '#calendar').length, 0, 'nothing starts on Saturday 17');
});

test('notice tables follow the member and the endpoint is not public', async () => {
  await start();
  const { alice } = await family();
  await subscribe(alice, 'alice');
  const payload = JSON.stringify(await state(alice));
  assert.equal(payload.includes('fcm.googleapis.com'), false, 'device addresses never leave the server');
  assert.equal(payload.includes(instance.db.prepare('SELECT private_key FROM push_keys').get().private_key), false);
});
