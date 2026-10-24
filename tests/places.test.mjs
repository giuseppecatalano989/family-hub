import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { presentPlace, presentPrediction, photonPlaces, googlePlaces, position, distance, PLACES_PER_MINUTE } from '../server/places.mjs';

test('places get a short label to save and the area that tells them apart', () => {
  assert.deepEqual(presentPlace({ name: 'Ospedale Niguarda', street: 'Piazza dell’Ospedale Maggiore', housenumber: '3', city: 'Milano', county: 'Milano', state: 'Lombardia', country: 'Italia' }),
    { label: 'Ospedale Niguarda, Piazza dell’Ospedale Maggiore 3, Milano', name: 'Ospedale Niguarda, Piazza dell’Ospedale Maggiore 3, Milano', detail: 'Lombardia, Italia' });
  assert.equal(presentPlace({ street: 'Via Roma', housenumber: '12', city: 'Torino', state: 'Piemonte', country: 'Italia' }).label, 'Via Roma 12, Torino');
  assert.equal(presentPlace({ name: 'Bologna', city: 'Bologna', state: 'Emilia-Romagna', country: 'Italia' }).detail, 'Emilia-Romagna, Italia');
  assert.equal(presentPlace({ name: 'x'.repeat(100), street: 'y'.repeat(30), city: 'Roma' }).label, `${'x'.repeat(100)}, Roma`, 'labels fit the 120 characters of the location');
  assert.equal(presentPlace({ country: 'Italia' }), null);
  assert.equal(presentPlace(undefined), null);
  assert.deepEqual(presentPrediction({ text: { text: 'Esselunga, Viale Monza, 123, Milano, MI, Italia' }, structuredFormat: { mainText: { text: 'Esselunga' }, secondaryText: { text: 'Viale Monza, 123, Milano, MI, Italia' } }, distanceMeters: 850 }),
    { label: 'Esselunga, Viale Monza, 123, Milano, MI', name: 'Esselunga', detail: 'Viale Monza, 123, Milano, MI', distance: 850 });
  assert.equal(presentPrediction({ text: { text: 'Louvre, Rue de Rivoli, Paris, France' } }).label, 'Louvre, Rue de Rivoli, Paris, France');
  assert.equal(presentPrediction({}), null);
});

test('positions are rounded to about 100 m and distances are in metres', () => {
  assert.deepEqual(position('45.46427', '9.18951'), { lat: 45.464, lon: 9.19 });
  assert.equal(position('91', '9'), null); assert.equal(position('45', 'abc'), null); assert.equal(position(undefined, undefined), null); assert.equal(position(['45'], '9'), null);
  assert.ok(Math.abs(distance({ lat: 45.464, lon: 9.19 }, { lat: 41.9, lon: 12.496 }) - 477000) < 1000, 'Milano–Roma is about 477 km');
  assert.equal(distance({ lat: 45.464, lon: 9.19 }, { lat: 45.464, lon: 9.19 }), 0);
});

test('Photon is reached over HTTPS with the typed text and the rounded position only', async () => {
  assert.equal(photonPlaces({ baseUrl: 'off' }), null);
  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try { assert.equal(photonPlaces({ baseUrl: 'http://photon.example.com' }), null); } finally { console.error = original; }
  assert.equal(errors.length, 1);
  const calls = [];
  const provider = photonPlaces({ baseUrl: 'https://photon.example.com/', fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ features: [{ properties: { name: 'Duomo', city: 'Milano' }, geometry: { coordinates: [9.191, 45.464] } }, null] }); } });
  assert.deepEqual(await provider.search('duomo milano'), [{ label: 'Duomo, Milano', name: 'Duomo, Milano', detail: '' }]);
  const url = calls[0].url;
  assert.equal(`${url.origin}${url.pathname}`, 'https://photon.example.com/api');
  assert.equal(url.searchParams.get('q'), 'duomo milano');
  assert.equal(url.searchParams.get('lat'), '42.5', 'without a position the results lean towards Italy');
  assert.ok(calls[0].options.signal, 'requests time out');
  const [near] = await provider.search('duomo', { lat: 45.464, lon: 9.19 });
  assert.equal(near.distance, 78);
  assert.equal(calls[1].url.searchParams.get('lat'), '45.464'); assert.equal(calls[1].url.searchParams.get('zoom'), '12');
  const plain = [];
  const strict = photonPlaces({ baseUrl: 'https://photon.example.com', fetcher: async url => { plain.push(url); return url.searchParams.has('lat') ? new Response('bad parameter', { status: 400 }) : Response.json({ features: [{ properties: { name: 'Duomo' } }] }); } });
  assert.equal((await strict.search('duomo')).length, 1, 'without the bias when the instance refuses it');
  assert.deepEqual([...plain[1].searchParams.keys()], ['q', 'limit']);
  const failing = photonPlaces({ baseUrl: 'https://photon.example.com', fetcher: async () => new Response('busy', { status: 429 }) });
  await assert.rejects(failing.search('duomo'), error => error.status === 429);
});

test('Google Places is used only with a backend key and receives the text and the rounded position', async () => {
  assert.equal(googlePlaces({ apiKey: '' }), null);
  const calls = [];
  const provider = googlePlaces({ apiKey: 'test-key', fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ suggestions: [
    { placePrediction: { text: { text: 'Esselunga, Viale Monza, Milano, MI, Italia' }, structuredFormat: { mainText: { text: 'Esselunga' }, secondaryText: { text: 'Viale Monza, Milano, MI, Italia' } }, distanceMeters: 1200 } },
    { queryPrediction: { text: { text: 'esselunga vicino a me' } } },
  ] }); } });
  assert.equal(provider.source, 'google');
  assert.deepEqual(await provider.search('e', { lat: 45.464, lon: 9.19 }), [{ label: 'Esselunga, Viale Monza, Milano, MI', name: 'Esselunga', detail: 'Viale Monza, Milano, MI', distance: 1200 }]);
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places:autocomplete');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.input, 'e'); assert.equal(body.languageCode, 'it');
  assert.deepEqual(body.origin, { latitude: 45.464, longitude: 9.19 });
  assert.deepEqual(body.locationBias.circle.center, { latitude: 45.464, longitude: 9.19 });
  await provider.search('esselunga');
  assert.equal('origin' in JSON.parse(calls[1].options.body), false, 'no position is sent when the member does not share it');
  const failing = googlePlaces({ apiKey: 'test-key', fetcher: async () => new Response('denied', { status: 403 }) });
  await assert.rejects(failing.search('duomo'), error => error.status === 403);
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
const search = (session, q, near = '') => request(`/places?q=${encodeURIComponent(q)}${near}`, { session });

test('signed-in members get deduplicated suggestions from the first letter, nearest first, cached and limited per family', async () => {
  const queries = [];
  const place = (name, distance) => ({ label: `${name}, Milano`, name, detail: 'Milano', ...(distance !== undefined ? { distance } : {}) });
  const placesProvider = { source: 'osm', async search(query, near) {
    queries.push({ query, near });
    if (query.includes('guasto')) throw Object.assign(new Error(`errore per ${query}`), { status: 500 });
    return near ? [place('Lontano', 9000), place('Senza distanza'), place('Vicino', 300), place('Vicino', 300), place('Medio', 2000)]
      : [place('Studio Bianchi'), place('Studio Bianchi'), ...Array.from({ length: 8 }, (_, i) => place(`Luogo ${i}`))];
  } };
  let now = Date.parse('2026-10-24T10:00:00Z');
  await start({ placesProvider, clock: () => now });
  assert.equal((await search(null, 's')).status, 401);
  const alice = await register('alice@example.it'); const bob = await register('bob@example.it');
  assert.deepEqual(await (await search(alice, '   ')).json(), { places: [], source: 'osm' }, 'empty text does not reach the service');
  const response = await search(alice, '  S ');
  assert.equal(response.status, 200);
  const { places, source } = await response.json();
  assert.equal(source, 'osm');
  assert.equal(places.length, 5);
  assert.equal(places[0].label, 'Studio Bianchi, Milano');
  assert.equal(new Set(places.map(p => p.label)).size, 5);
  assert.deepEqual(queries, [{ query: 's', near: null }], 'the search starts from the first letter');
  assert.equal((await search(bob, 's')).status, 200);
  assert.equal(queries.length, 1, 'the same text is answered from the cache');

  const nearby = await (await search(alice, 'es', '&lat=45.46427&lon=9.18951')).json();
  assert.deepEqual(queries.at(-1).near, { lat: 45.464, lon: 9.19 }, 'the position is rounded to about 100 m');
  assert.deepEqual(nearby.places.map(p => p.name), ['Vicino', 'Medio', 'Lontano', 'Senza distanza'], 'nearest first, deduplicated');
  assert.equal((await search(alice, 'es', '&lat=200&lon=9')).status, 200);
  assert.equal(queries.at(-1).near, null, 'an invalid position is ignored');

  for (let i = queries.length; i < PLACES_PER_MINUTE; i++) assert.equal((await search(alice, `via numero ${i}`)).status, 200);
  const limited = await search(alice, 'via oltre il limite');
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Riprova tra un minuto/);
  assert.equal((await search(bob, 'via di bob')).status, 200, 'the limit is per family');
  now += 60000;
  assert.equal((await search(alice, 'via oltre il limite')).status, 200, 'the limit resets every minute');

  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  let failed;
  try { failed = await search(alice, 'luogo guasto', '&lat=45.464&lon=9.19'); } finally { console.error = original; }
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /scrivere il luogo a mano/);
  assert.equal(errors.length, 1); assert.doesNotMatch(errors[0], /guasto|45\.464/, 'neither the text nor the position is logged');
});

test('without a service the suggestions are not offered', async () => {
  await start({ placesProvider: null });
  const alice = await register('alice@example.it');
  assert.equal((await search(alice, 'via roma')).status, 503);
});
