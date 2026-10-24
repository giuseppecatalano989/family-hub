import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { presentPlace, photonPlaces, PLACES_PER_MINUTE } from '../server/places.mjs';

test('places get a short label to save and the area that tells them apart', () => {
  assert.deepEqual(presentPlace({ name: 'Ospedale Niguarda', street: 'Piazza dell’Ospedale Maggiore', housenumber: '3', city: 'Milano', county: 'Milano', state: 'Lombardia', country: 'Italia' }),
    { label: 'Ospedale Niguarda, Piazza dell’Ospedale Maggiore 3, Milano', detail: 'Lombardia, Italia' });
  assert.deepEqual(presentPlace({ street: 'Via Roma', housenumber: '12', city: 'Torino', state: 'Piemonte', country: 'Italia' }), { label: 'Via Roma 12, Torino', detail: 'Piemonte, Italia' });
  assert.deepEqual(presentPlace({ name: 'Bologna', city: 'Bologna', state: 'Emilia-Romagna', country: 'Italia' }), { label: 'Bologna', detail: 'Emilia-Romagna, Italia' });
  assert.equal(presentPlace({ name: 'x'.repeat(100), street: 'y'.repeat(30), city: 'Roma' }).label, `${'x'.repeat(100)}, Roma`, 'labels fit the 120 characters of the location');
  assert.equal(presentPlace({ country: 'Italia' }), null);
  assert.equal(presentPlace(undefined), null);
});

test('Photon is reached over HTTPS with the typed text only', async () => {
  assert.equal(photonPlaces({ baseUrl: 'off' }), null);
  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try { assert.equal(photonPlaces({ baseUrl: 'http://photon.example.com' }), null); } finally { console.error = original; }
  assert.equal(errors.length, 1);
  const calls = [];
  const provider = photonPlaces({ baseUrl: 'https://photon.example.com/', fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ features: [{ properties: { name: 'Duomo' } }, null] }); } });
  assert.deepEqual(await provider.search('duomo milano'), [{ name: 'Duomo' }, undefined]);
  const url = calls[0].url;
  assert.equal(`${url.origin}${url.pathname}`, 'https://photon.example.com/api');
  assert.equal(url.searchParams.get('q'), 'duomo milano');
  assert.equal(url.searchParams.get('lat'), '42.5');
  assert.ok(calls[0].options.signal, 'requests time out');
  const failing = photonPlaces({ baseUrl: 'https://photon.example.com', fetcher: async () => new Response('busy', { status: 429 }) });
  await assert.rejects(failing.search('duomo'), error => error.status === 429);
});

let instance; let server; let dataDir; let base;
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  instance?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  server = undefined; instance = undefined; dataDir = undefined;
});
async function start(options) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-places-'));
  instance = createApp({ dataDir, ...options });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function request(route, { method = 'GET', body, session } = {}) {
  return fetch(base + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'Casa', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function register(email) {
  const response = await request('/auth/register', { method: 'POST', body: { name: email.split('@')[0], email, password: 'password-test-123', householdName: 'Casa Rossi' } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: result.csrf, user: result.user };
}
const search = (session, q) => request(`/places?q=${encodeURIComponent(q)}`, { session });

test('signed-in members get deduplicated suggestions, cached and limited per family', async () => {
  const queries = [];
  const placesProvider = { async search(query) {
    queries.push(query);
    if (query.includes('guasto')) throw Object.assign(new Error(`errore per ${query}`), { status: 500 });
    return [{ name: 'Studio Bianchi', street: 'Via Roma', housenumber: '12', city: 'Milano', country: 'Italia' }, { name: 'Studio Bianchi', street: 'Via Roma', housenumber: '12', city: 'Milano' },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `Luogo ${i}`, city: 'Roma' })), { country: 'Italia' }];
  } };
  let now = Date.parse('2026-10-24T10:00:00Z');
  await start({ placesProvider, clock: () => now });
  assert.equal((await search(null, 'studio bianchi')).status, 401);
  const alice = await register('alice@example.it'); const bob = await register('bob@example.it');
  assert.deepEqual(await (await search(alice, 'st')).json(), { places: [] }, 'short queries do not reach the service');
  const response = await search(alice, '  Studio   Bianchi ');
  assert.equal(response.status, 200);
  const { places } = await response.json();
  assert.equal(places.length, 5);
  assert.deepEqual(places[0], { label: 'Studio Bianchi, Via Roma 12, Milano', detail: 'Italia' });
  assert.equal(new Set(places.map(p => p.label)).size, 5);
  assert.deepEqual(queries, ['studio bianchi']);
  assert.equal((await search(bob, 'studio bianchi')).status, 200);
  assert.equal(queries.length, 1, 'the same text is answered from the cache');

  for (let i = 1; i < PLACES_PER_MINUTE; i++) assert.equal((await search(alice, `via numero ${i}`)).status, 200);
  const limited = await search(alice, 'via oltre il limite');
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Riprova tra un minuto/);
  assert.equal((await search(bob, 'via di bob')).status, 200, 'the limit is per family');
  now += 60000;
  assert.equal((await search(alice, 'via oltre il limite')).status, 200, 'the limit resets every minute');

  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  let failed;
  try { failed = await search(alice, 'luogo guasto'); } finally { console.error = original; }
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /scrivere il luogo a mano/);
  assert.equal(errors.length, 1); assert.doesNotMatch(errors[0], /guasto/, 'the typed text is never logged');
});

test('without a service the suggestions are not offered', async () => {
  await start({ placesProvider: null });
  const alice = await register('alice@example.it');
  assert.equal((await search(alice, 'via roma')).status, 503);
});
