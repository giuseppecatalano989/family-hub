import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { sanitizePantry, photoType, PANTRY_DAILY_LIMIT } from '../server/pantry.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');

test('the answer of the model is bounded to what the menu and the list accept', () => {
  const result = sanitizePantry({
    notice: '  Foto   chiara ', found: [{ name: 'Uova', amount: '6' }, { name: '' }, null],
    shopping: [{ name: 'Latte', quantity: '1 l', section: 'Reparto inventato', reason: 'Finito' }],
    recipes: [
      { title: 'Frittata', servings: 99, minutes: 20, summary: 'Veloce.', steps: ['Sbatti le uova', 'Cuoci'], ingredients: [{ name: 'Uova', quantity: '6', section: 'Frigo e freschi', available: true }, { name: 'Zucchine', quantity: '2', section: 'Frutta e verdura', available: 'no' }] },
      { title: '', ingredients: [] },
      ...Array.from({ length: 10 }, (_, i) => ({ title: `Ricetta ${i}`, servings: 2, minutes: -1, summary: '', steps: [], ingredients: Array.from({ length: 40 }, () => ({ name: 'x'.repeat(300), quantity: 'q', section: 'Dispensa', available: true })) })),
    ],
  }, { servings: 3 });
  assert.equal(result.notice, 'Foto chiara');
  assert.deepEqual(result.found, [{ name: 'Uova', amount: '6' }]);
  assert.equal(result.shopping[0].section, 'Altro', 'unknown sections fall back to Altro');
  assert.equal(result.recipes.length, 5, 'empty titles are dropped and at most six recipes are read');
  const [frittata, other] = result.recipes;
  assert.equal(frittata.servings, 3, 'servings out of range use the requested ones');
  assert.equal(frittata.notes, 'Veloce.\n\n1. Sbatti le uova\n2. Cuoci');
  assert.deepEqual(frittata.ingredients.map(i => i.available), [true, false]);
  assert.equal(other.minutes, null);
  assert.equal(other.ingredients.length, 30);
  assert.equal(other.ingredients[0].name.length, 120);
});

test('only real images are recognized', () => {
  assert.equal(photoType(Buffer.from(jpeg, 'base64')), 'image/jpeg');
  assert.equal(photoType(Buffer.from(png, 'base64')), 'image/png');
  assert.equal(photoType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(photoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

let instance; let server; let dataDir; let base;
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  instance?.db.close?.();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  server = undefined; instance = undefined; dataDir = undefined;
});
async function start(options) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-pantry-'));
  instance = createApp({ dataDir, ...options });
  server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function request(route, { method = 'GET', body, session, type = 'application/json' } = {}) {
  return fetch(base + route, { method, headers: { ...(body ? { 'content-type': type } : {}), 'x-requested-with': 'Casa', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
const analysis = (session, body) => request('/pantry/analysis', { method: 'POST', session, body, type: 'application/x-casa-pantry' });
async function register(email, extra = {}) {
  const response = await request('/auth/register', { method: 'POST', body: { name: email.split('@')[0], email, password: 'password-test-123', householdName: 'Casa Rossi', ...extra } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: result.csrf, user: result.user };
}
const state = async session => (await request('/state?month=2026-10&week=2026-10-12', { session })).json();

test('without a key the analysis is not offered', async () => {
  await start({ pantryModel: null });
  const alice = await register('alice@example.it');
  assert.deepEqual((await state(alice)).pantry, { available: false, remaining: 0 });
  assert.equal((await analysis(alice, { photos: [jpeg], servings: 2 })).status, 503);
});

test('photos are analysed outside the request queue, within a daily limit', async () => {
  let release; const calls = [];
  const model = { model: 'test', async analyze(input) {
    calls.push(input);
    if (input.text.includes('errore')) throw Object.assign(new Error('boom'), { status: 500 });
    if (input.text.includes('lento')) await new Promise(resolve => { release = resolve; });
    return { notice: '', found: [{ name: 'Uova', amount: '6' }], shopping: [{ name: 'Parmigiano', quantity: '200 g', section: 'Frigo e freschi', reason: 'Per la pasta' }],
      recipes: [{ title: 'Frittata di zucchine', servings: 2, minutes: 25, summary: 'Semplice.', steps: ['Cuoci'], ingredients: [{ name: 'Uova', quantity: '4', section: 'Frigo e freschi', available: true }, { name: 'Zucchine', quantity: '2', section: 'Frutta e verdura', available: false }] }] };
  } };
  await start({ pantryModel: model });
  const alice = await register('alice@example.it');
  assert.deepEqual((await state(alice)).pantry, { available: true, remaining: PANTRY_DAILY_LIMIT });

  assert.equal((await analysis(alice, { photos: [], servings: 2 })).status, 400);
  assert.equal((await analysis(alice, { photos: [jpeg, jpeg, jpeg, jpeg, jpeg], servings: 2 })).status, 400);
  assert.equal((await analysis(alice, { photos: [Buffer.from('<svg/>').toString('base64')], servings: 2 })).status, 400, 'only images');
  assert.equal((await analysis(alice, { photos: ['non base64!'], servings: 2 })).status, 400);
  assert.equal((await analysis(alice, { photos: [jpeg], servings: 0 })).status, 400);
  assert.equal(calls.length, 0, 'invalid requests never reach the model');
  assert.equal((await fetch(`${base}/pantry/analysis`, { method: 'POST', headers: { 'content-type': 'application/x-casa-pantry', 'x-requested-with': 'Casa' }, body: JSON.stringify({ photos: [jpeg], servings: 2 }) })).status, 401);

  // While Claude looks at the photos, the rest of the app keeps answering.
  const pending = analysis(alice, { photos: [jpeg, png], servings: 2, note: 'pranzo lento' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request('/shopping', { method: 'POST', session: alice, body: { name: 'Pane', quantity: '', section: 'Dispensa' } })).status, 201);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.recipes[0].title, 'Frittata di zucchine');
  assert.equal(result.remaining, PANTRY_DAILY_LIMIT - 1);
  assert.deepEqual(calls[0].photos.map(p => p.type), ['image/jpeg', 'image/png']);
  assert.match(calls[0].text, /2 porzioni/);
  assert.doesNotMatch(calls[0].text, /alice|Casa Rossi/, 'no names reach the model');
  assert.equal((await state(alice)).meals.length, 0, 'nothing is planned without confirmation');

  assert.equal((await analysis(alice, { photos: [jpeg], servings: 2, note: 'errore' })).status, 502);
  assert.equal((await state(alice)).pantry.remaining, PANTRY_DAILY_LIMIT - 1, 'a failed analysis is not counted');
  instance.db.prepare('UPDATE pantry_usage SET count = ?').run(PANTRY_DAILY_LIMIT);
  assert.equal((await analysis(alice, { photos: [jpeg], servings: 2 })).status, 429);
  assert.equal(calls.length, 2);
});

test('confirmed recipes enter the menu and only the missing ingredients the list', async () => {
  await start({ pantryModel: null });
  const alice = await register('alice@example.it');
  const eve = await register('eve@example.it', { householdName: 'Altra casa' });
  const frittata = { date: '2026-10-14', slot: 'dinner', title: 'Frittata di zucchine', servings: 2, notes: '1. Cuoci', ingredients: [
    { name: 'Uova', quantity: '4', section: 'Frigo e freschi', buy: false }, { name: 'Zucchine', quantity: '2', section: 'Frutta e verdura', buy: true }] };
  const pasta = { date: '2026-10-15', slot: 'lunch', title: 'Pasta al pomodoro', servings: 2, notes: '', ingredients: [{ name: 'Pasta', quantity: '200 g', section: 'Dispensa', buy: false }] };
  const extra = [{ name: 'Parmigiano', quantity: '200 g', section: 'Frigo e freschi' }];
  assert.equal((await request('/meals/batch', { method: 'POST', session: alice, body: { meals: [] } })).status, 400);
  assert.equal((await request('/meals/batch', { method: 'POST', session: alice, body: { meals: [frittata, { ...pasta, date: frittata.date, slot: 'dinner' }] } })).status, 400, 'one recipe per meal');
  const response = await request('/meals/batch', { method: 'POST', session: alice, body: { meals: [frittata, pasta], shopping: extra } });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(await response.json(), { meals: 2, added: 2 });
  let current = await state(alice);
  assert.deepEqual(current.meals.map(m => m.title), ['Frittata di zucchine', 'Pasta al pomodoro']);
  assert.deepEqual(current.shopping.map(s => s.name).sort(), ['Parmigiano', 'Zucchine']);
  const planned = current.meals[0];
  assert.deepEqual(planned.shoppingAdded, [planned.ingredients[1].id], 'the bought ingredient stays linked to its meal');
  assert.equal((await request(`/meals/${planned.id}/shopping`, { method: 'POST', session: alice })).status, 200);
  assert.equal((await state(alice)).shopping.filter(s => s.name === 'Zucchine').length, 1, 'adding the meal again does not duplicate it');

  // A taken slot rejects the whole confirmation.
  const busy = await request('/meals/batch', { method: 'POST', session: alice, body: { meals: [{ ...pasta, date: '2026-10-16' }, { ...pasta, title: 'Altro' }], shopping: extra } });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /15 ottobre: il pranzo è già pianificato/);
  current = await state(alice);
  assert.equal(current.meals.length, 2);
  assert.equal(current.shopping.length, 3);
  const other = await state(eve);
  assert.deepEqual([other.meals.length, other.shopping.length], [0, 0], 'each family sees only its own records');
});
