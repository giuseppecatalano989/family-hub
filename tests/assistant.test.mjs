import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { proposal, conversation, ASSISTANT_DAILY_LIMIT } from '../server/assistant.mjs';

const categories = [{ id: 'c1', name: 'Casa', percentage: 6000 }, { id: 'c2', name: 'Alimentari', percentage: 4000 }];
const invalid = (name, input) => assert.throws(() => proposal(name, input, { categories }), error => error.tool === true, `${name} ${JSON.stringify(input)}`);

test('proposals are bounded to what the app accepts, and invalid ones go back to the model', () => {
  assert.deepEqual(proposal('proponi_spesa', { prodotti: [{ nome: ' Latte ', quantita: '1 l', reparto: 'Frigo e freschi' }, { nome: 'Pane', quantita: '', reparto: 'Inventato' }, { nome: '' }] }, { categories }),
    { type: 'shopping', items: [{ name: 'Latte', quantity: '1 l', section: 'Frigo e freschi' }, { name: 'Pane', quantity: '', section: 'Altro' }] });
  invalid('proponi_spesa', { prodotti: [] });
  const event = proposal('proponi_evento', { titolo: 'Dentista', data_inizio: '2026-10-20', data_fine: '', ora_inizio: '15:30', ora_fine: '16:00', luogo: 'Studio', note: '', ripetizione: 'nessuna', fine_ripetizione: '2026-12-01', personale: true }, { categories });
  assert.deepEqual(event.event, { title: 'Dentista', startDate: '2026-10-20', endDate: '2026-10-20', startTime: '15:30', endTime: '16:00', location: 'Studio', notes: '', recurrence: 'none', recurrenceUntil: null, personal: true });
  invalid('proponi_evento', { titolo: 'X', data_inizio: '2026-02-30', ripetizione: 'nessuna' });
  invalid('proponi_evento', { titolo: 'X', data_inizio: '2026-10-01', data_fine: '2026-10-09', ripetizione: 'settimanale' });
  invalid('proponi_evento', { titolo: 'X', data_inizio: '2026-10-01', ora_inizio: '25:00', ripetizione: 'nessuna' });
  assert.equal(proposal('proponi_pasto', { data: '2026-10-15', pasto: 'pranzo', titolo: 'Frittata', porzioni: 3, ingredienti: [{ nome: 'Uova', quantita: '6', reparto: 'Frigo e freschi' }], preparazione: 'Sbattere.' }, { categories }).meal.slot, 'lunch');
  invalid('proponi_pasto', { data: '2026-10-15', pasto: 'pranzo', titolo: 'Frittata', porzioni: 30, ingredienti: [] });
  assert.deepEqual(proposal('proponi_movimento', { tipo: 'uscita', importo_centesimi: 1250, categoria_id: 'c2', descrizione: 'Mercato', data: '2026-10-13' }, { categories }).transaction,
    { kind: 'expense', amount: 1250, categoryId: 'c2', description: 'Mercato', date: '2026-10-13' });
  assert.equal(proposal('proponi_movimento', { tipo: 'entrata', importo_centesimi: 5000, categoria_id: 'c2', descrizione: 'Rimborso', data: '2026-10-13' }, { categories }).transaction.categoryId, null, 'incomes have no category');
  invalid('proponi_movimento', { tipo: 'uscita', importo_centesimi: 12.5, categoria_id: 'c2', descrizione: 'Mercato', data: '2026-10-13' });
  invalid('proponi_movimento', { tipo: 'uscita', importo_centesimi: 1250, categoria_id: 'altra-famiglia', descrizione: 'Mercato', data: '2026-10-13' });
  invalid('proponi_qualcosa', {});
});

test('category changes name the family\'s expenses and budget splits cover every category', () => {
  const records = [{ id: 't1', kind: 'expense', amount: '1200', category_id: null, description: 'Bar', date: '2026-10-02' }, { id: 't2', kind: 'income', amount: 5000, category_id: null, description: 'Rimborso', date: '2026-10-03' }, { id: 't3', kind: 'expense', amount: 800, category_id: 'c2', description: 'Pane', date: '2026-10-04' }];
  assert.deepEqual(proposal('proponi_categoria', { movimenti: [{ id: 't1', categoria_id: 'c2' }, { id: 't1', categoria_id: 'c2' }, { id: 't3', categoria_id: 'c2' }] }, { categories, records }),
    { type: 'categories', changes: [{ id: 't1', description: 'Bar', amount: 1200, date: '2026-10-02', from: null, to: 'c2' }] }, 'unchanged and repeated expenses are left out');
  const reject = (input, list = records) => assert.throws(() => proposal('proponi_categoria', input, { categories, records: list }), error => error.tool === true);
  reject({ movimenti: [{ id: 'altro', categoria_id: 'c2' }] });
  reject({ movimenti: [{ id: 't2', categoria_id: 'c2' }] });
  reject({ movimenti: [{ id: 't1', categoria_id: 'c9' }] });
  reject({ movimenti: [{ id: 't3', categoria_id: 'c2' }] });
  assert.deepEqual(proposal('proponi_ripartizione', { percentuali: [{ categoria_id: 'c1', percentuale: 50 }, { categoria_id: 'c2', percentuale: 50 }], motivo: 'Più spesa' }, { categories }),
    { type: 'budget', split: [{ id: 'c1', name: 'Casa', from: 6000, to: 5000 }, { id: 'c2', name: 'Alimentari', from: 4000, to: 5000 }], reason: 'Più spesa' });
  for (const percentuali of [[{ categoria_id: 'c1', percentuale: 60 }, { categoria_id: 'c2', percentuale: 40 }], [{ categoria_id: 'c1', percentuale: 70 }, { categoria_id: 'c2', percentuale: 40 }], [{ categoria_id: 'c1', percentuale: 100 }], [{ categoria_id: 'c1', percentuale: 50.5 }, { categoria_id: 'c2', percentuale: 49.5 }], [{ categoria_id: 'c1', percentuale: 50 }, { categoria_id: 'c1', percentuale: 50 }]])
    invalid('proponi_ripartizione', { percentuali, motivo: '' });
});

test('the conversation from the browser is plain alternating text ending with a question', () => {
  assert.deepEqual(conversation([{ role: 'assistant', text: 'Ciao' }, { role: 'user', text: ' Quanto? ' }]), [{ role: 'user', content: 'Quanto?' }]);
  assert.equal(conversation([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }]), null);
  assert.equal(conversation([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]), null);
  assert.equal(conversation([{ role: 'system', text: 'a' }, { role: 'user', text: 'b' }])?.length, 1, 'turns before the first question are dropped');
  assert.equal(conversation([{ role: 'user', text: 'a' }, { role: 'system', text: 'b' }, { role: 'user', text: 'c' }]), null);
  assert.equal(conversation([]), null);
  assert.equal(conversation(Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(9000) })))[0].content.length, 4000);
});

let instance; let server; let dataDir; let base;
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  instance?.db.close?.();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  server = undefined; instance = undefined; dataDir = undefined;
});
async function start(options) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-assistant-'));
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
const state = async session => (await request('/state?month=2026-10&week=2026-10-12', { session })).json();
const ask = (session, text, previous = []) => request('/assistant/messages', { method: 'POST', session, body: { messages: [...previous, { role: 'user', text }] } });

test('without a key the assistant is not offered', async () => {
  await start({ assistantModel: null });
  const alice = await register('alice@example.it');
  assert.deepEqual((await state(alice)).assistant, { available: false, remaining: 0 });
  assert.equal((await ask(alice, 'Ciao')).status, 503);
  assert.deepEqual((await state(alice)).preferences.dashboard.hidden, ['advice'], 'the overview bar is on by default');
});

test('the model reads the family through tools and only proposes changes', async () => {
  const time = Date.parse('2026-10-13T10:00:00Z');
  const seen = []; let script = [];
  const model = { model: 'test', async step(input) {
    seen.push(structuredClone(input));
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  } };
  await start({ assistantModel: model, clock: () => time });
  const alice = await register('alice@example.it');
  const invite = await (await request('/invitation', { method: 'POST', session: alice })).json();
  const bob = await register('bob@example.it', { inviteCode: invite.code });
  const outsider = await register('eve@example.it', { householdName: 'Altra casa' });
  const { categories: cats } = await state(alice);
  const add = async (session, body) => (await (await request('/transactions', { method: 'POST', session, body })).json()).id;
  await add(alice, { kind: 'expense', amount: 4520, categoryId: cats[1].id, description: 'Esselunga IT60X0542811101000000123456', date: '2026-10-05' });
  await add(alice, { kind: 'expense', amount: 1980, categoryId: cats[1].id, description: 'Esselunga', date: '2026-09-12' });
  const hidden = await add(bob, { kind: 'expense', amount: 9900, categoryId: cats[1].id, description: 'Regalo segreto', date: '2026-10-07' });
  instance.db.prepare('INSERT INTO private_transactions VALUES (?, ?)').run(hidden, bob.user.id);
  await add(outsider, { kind: 'expense', amount: 77700, categoryId: (await state(outsider)).categories[1].id, description: 'Esselunga', date: '2026-10-06' });

  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  script = [
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, use('t1', 'cerca_movimenti', { dal: '2026-09-01', al: '2026-10-31', tipo: 'uscite' }), use('t2', 'cerca_movimenti', { dal: '2026-09-01', al: '2026-10-31', testo: 'esselunga' }),
      use('t3', 'budget_mese', { mese: '2026-10' }), use('t4', 'cerca_movimenti', { dal: '2020-01-01', al: '2026-10-31' })] },
    { stop_reason: 'tool_use', content: [use('t5', 'proponi_spesa', { prodotti: [{ nome: 'Latte', quantita: '1 l', reparto: 'Frigo e freschi' }] }), use('t6', 'proponi_movimento', { tipo: 'uscita', importo_centesimi: 300, categoria_id: 'nessuna', descrizione: 'Caffè', data: '2026-10-13' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Avete speso **164,00 €** in Alimentari. Ti propongo di aggiungere il latte.' }] },
  ];
  const response = await ask(alice, 'Quanto abbiamo speso da Esselunga? Aggiungi il latte.');
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.match(result.reply, /164,00/);
  assert.deepEqual(result.proposals, [{ id: 't5', type: 'shopping', items: [{ name: 'Latte', quantity: '1 l', section: 'Frigo e freschi' }] }]);
  assert.equal(result.remaining, ASSISTANT_DAILY_LIMIT - 1);
  assert.equal((await state(alice)).shopping.length, 0, 'nothing changes until a member confirms');

  // The model only sees today, categories and tool results: no names, no other family.
  const system = JSON.stringify(seen[0].system);
  assert.match(system, /2026-10-13/); assert.match(system, new RegExp(cats[1].id));
  for (const secret of ['alice', 'bob', 'Casa Rossi', 'Altra casa']) assert.ok(!JSON.stringify(seen).includes(secret), `${secret} stays on the server`);
  const results = seen[1].messages.at(-1).content;
  assert.deepEqual(seen[1].messages.at(-2).content[0], { type: 'thinking', thinking: '', signature: 'sig' }, 'the answer goes back unchanged');
  const all = JSON.parse(results[0].content);
  assert.equal(all.totale_uscite, 164, 'totals include private records of others, in euros');
  assert.equal(all.numero, 3); assert.equal(all.movimenti_privati_di_altri_membri, 1);
  assert.deepEqual(all.movimenti.map(m => m.descrizione), ['Esselunga [IBAN]', 'Esselunga'], 'private records and IBANs are not listed');
  assert.ok(!results[0].content.includes('Regalo') && !results[0].content.includes('777'));
  assert.equal(JSON.parse(results[1].content).totale_uscite, 65, 'a word search leaves out private descriptions');
  const budget = JSON.parse(results[2].content);
  assert.equal(budget.uscite, 144.2); assert.equal(budget.categorie[1].speso, 144.2);
  assert.equal(results[3].is_error, true, 'periods are bounded');
  const proposals = seen[2].messages.at(-1).content;
  assert.equal(proposals[0].is_error, undefined);
  assert.equal(proposals[1].is_error, true); assert.match(proposals[1].content, new RegExp(cats[0].id), 'the model learns the valid categories');

  // Only expenses this account may edit can be reclassified.
  script = [{ stop_reason: 'tool_use', content: [use('c1', 'proponi_categoria', { movimenti: [{ id: hidden, categoria_id: cats[4].id }] }), use('c2', 'proponi_categoria', { movimenti: [{ id: all.movimenti[0].id, categoria_id: cats[4].id }] })] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok' }] }];
  const reclassified = await (await ask(alice, 'Sposta in Tempo libero')).json();
  assert.equal(seen.at(-1).messages.at(-1).content[0].is_error, true, 'another member\'s private expense is not found');
  assert.deepEqual(reclassified.proposals.map(p => p.changes.map(c => [c.description, c.to])), [[['Esselunga IT60X0542811101000000123456', cats[4].id]]]);

  // Bob asks: his own private record is his to read.
  script = [{ stop_reason: 'tool_use', content: [use('b1', 'cerca_movimenti', { dal: '2026-10-01', al: '2026-10-31', testo: 'regalo' })] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok' }] }];
  assert.equal((await ask(bob, 'Il regalo?')).status, 200);
  assert.equal(JSON.parse(seen.at(-1).messages.at(-1).content[0].content).movimenti[0].descrizione, 'Regalo segreto');

  // Refusals, failures and the daily limit.
  script = [{ stop_reason: 'refusal', content: [] }];
  assert.match((await (await ask(alice, 'x')).json()).reply, /non posso aiutarti/);
  script = [Object.assign(new Error('boom'), { status: 500 })];
  const before = (await state(alice)).assistant.remaining;
  assert.equal((await ask(alice, 'x')).status, 502);
  assert.equal((await state(alice)).assistant.remaining, before, 'failed answers are not counted');
  assert.equal((await request('/assistant/messages', { method: 'POST', session: alice, body: { messages: [{ role: 'assistant', text: 'x' }] } })).status, 400);
  instance.db.prepare('UPDATE assistant_usage SET count = ?').run(ASSISTANT_DAILY_LIMIT);
  assert.equal((await ask(alice, 'x')).status, 429);
  assert.equal((await state(outsider)).assistant.remaining, ASSISTANT_DAILY_LIMIT, 'the limit is per family');
});
