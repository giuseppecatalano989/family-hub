import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { presentPlace, googlePlaces, PLACES_PER_MINUTE } from '../server/places.mjs';

const prediction = (label, detail = '') => ({ text: { text: label }, structuredFormat: { secondaryText: { text: detail } } });

test('Google predictions keep detailed addresses within the event location limit', () => {
  assert.deepEqual(presentPlace(prediction('Studio Bianchi, Via Roma 12, Milano', 'Lombardia, Italia')), { label: 'Studio Bianchi, Via Roma 12, Milano', detail: 'Lombardia, Italia' });
  assert.equal(presentPlace(prediction('x'.repeat(140))).label.length, 120);
  assert.equal(presentPlace({}), null);
  assert.equal(presentPlace(undefined), null);
  assert.equal(presentPlace(null), null);
});

test('Google Autocomplete uses a private header, Italian results and a bounded request', async () => {
  assert.equal(googlePlaces({ apiKey: '', baseUrl: 'https://places.googleapis.com' }), null);
  assert.equal(googlePlaces({ apiKey: 'test-only', baseUrl: 'off' }), null);
  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(googlePlaces({ apiKey: 'test-only', baseUrl: 'http://places.googleapis.com' }), null);
    assert.equal(googlePlaces({ apiKey: 'test-only', baseUrl: 'https://untrusted.example.com' }), null);
  } finally { console.error = original; }
  assert.equal(errors.length, 2);
  const calls = [];
  const result = prediction('Duomo di Milano, Milano, Italia', 'Milano, Italia');
  const provider = googlePlaces({ apiKey: 'test-only', fetcher: async (url, options) => {
    calls.push({ url, options }); return Response.json({ suggestions: [{ placePrediction: result }, { queryPrediction: {} }] });
  } });
  assert.deepEqual(await provider.search('D'), [result, undefined]);
  assert.equal(calls[0].url.href, 'https://places.googleapis.com/v1/places:autocomplete');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-Goog-Api-Key'], 'test-only');
  assert.equal(options.redirect, 'error', 'credentials are not forwarded through redirects');
  assert.deepEqual(JSON.parse(options.body), { input: 'D', languageCode: 'it', regionCode: 'it', includeQueryPredictions: false });
  assert.ok(options.signal);
  assert.doesNotMatch(options.body, /test-only/);
  const failing = googlePlaces({ apiKey: 'test-only', fetcher: async () => new Response('sensitive provider error', { status: 403 }) });
  await assert.rejects(failing.search('duomo'), error => error.status === 403 && !error.message.includes('sensitive'));
  const empty = googlePlaces({ apiKey: 'test-only', fetcher: async () => Response.json({}) });
  assert.deepEqual(await empty.search('a'), []);
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

test('signed-in members search from one character without caching, with deduplication and family limits', async () => {
  const queries = [];
  const placesProvider = { async search(query) {
    queries.push(query);
    if (query.includes('guasto')) throw Object.assign(new Error(`errore per ${query}`), { status: 500 });
    return [prediction('Studio Bianchi, Via Roma 12, Milano', 'Italia'), prediction('Studio Bianchi, Via Roma 12, Milano'),
      ...Array.from({ length: 8 }, (_, i) => prediction(`Luogo ${i}, Roma`)), {}];
  } };
  let now = Date.parse('2026-10-24T10:00:00Z');
  await start({ placesProvider, clock: () => now });
  assert.equal((await search(null, 'studio bianchi')).status, 401);
  const alice = await register('alice@example.it'); const bob = await register('bob@example.it');
  assert.deepEqual(await (await search(alice, '  ')).json(), { places: [] });
  assert.deepEqual(await (await search(alice, 'x'.repeat(121))).json(), { places: [] });
  assert.equal(queries.length, 0);
  assert.equal((await search(alice, 'S')).status, 200);
  assert.deepEqual(queries, ['S'], 'the first character reaches Google');
  const response = await search(alice, '  Studio   Bianchi ');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { places } = await response.json();
  assert.equal(places.length, 5);
  assert.deepEqual(places[0], { label: 'Studio Bianchi, Via Roma 12, Milano', detail: 'Italia' });
  assert.equal(new Set(places.map(p => p.label)).size, 5);
  assert.deepEqual(queries, ['S', 'Studio Bianchi']);
  assert.equal((await search(bob, 'studio bianchi')).status, 200);
  assert.equal(queries.length, 3, 'predictions are not cached, even for another family');

  for (let i = 2; i < PLACES_PER_MINUTE; i++) assert.equal((await search(alice, `via numero ${i}`)).status, 200);
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
