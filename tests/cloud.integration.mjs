import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';
import { createCloudApp } from '../server/cloud.mjs';
import { createCloudBackups } from '../server/cloud-backups.mjs';
import { verifyInstanceBackup, restoreInstanceBackup } from '../server/backups.mjs';
import { openPostgres } from '../server/postgres.mjs';
import { restoreCloudBackup } from '../server/cloud-backup-cli.mjs';

const connectionString = process.env.CASA_TEST_DATABASE_URL;
if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('I test cloud richiedono CASA_TEST_DATABASE_URL su un PostgreSQL temporaneo locale. Non usare un database reale.');
let instances, servers, instance, base;
async function start() {
  const app = await createCloudApp({ connectionString, local: true, cronSecret: 'test-cron-local-only' });
  const server = app.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  instances.push(app); servers.push(server);
  return { app, base: `http://127.0.0.1:${server.address().port}/api` };
}
beforeEach(async () => {
  const pool = new Pool({ connectionString });
  try { await pool.query('DROP SCHEMA IF EXISTS casa CASCADE'); } finally { await pool.end(); }
  instances = []; servers = []; const started = await start(); instance = started.app; base = started.base;
});
afterEach(async () => {
  for (const server of servers) await new Promise(r => server.close(r));
  for (const app of instances) await app.db.close();
});
async function request(route, { method = 'GET', body, session, headers = {}, target = base } = {}) {
  const raw = Buffer.isBuffer(body);
  return fetch(target + route, {
    method,
    headers: { 'x-requested-with': 'Casa', 'x-forwarded-proto': 'https', ...(body ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...headers },
    body: body ? raw ? body : JSON.stringify(body) : undefined,
  });
}
async function json(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function register(email = 'owner@example.test', inviteCode) {
  const response = await request('/auth/register', { method: 'POST', body: { name: 'Prova', email, password: 'test-password-123', householdName: 'Famiglia test cloud', inviteCode } });
  const data = await json(response, 201); assert.match(response.headers.get('set-cookie'), /Secure/);
  return { ...data, cookie: response.headers.get('set-cookie').split(';')[0] };
}
const create = async (route, body, session) => json(await request(route, { method: 'POST', body, session }), 201);
const state = async session => json(await request('/state?month=2026-10&week=2026-10-05', { session }));
async function attach(session, note, bytes) {
  const upload = await create(`/notes/${note.id}/uploads`, { name: 'documento.bin', mime: 'application/octet-stream', size: bytes.length }, session);
  for (let index = 0; index < Math.max(1, Math.ceil(bytes.length / 2097152)); index++) {
    await json(await request(`/notes/${note.id}/uploads/${upload.id}/chunks/${index}`, { method: 'PUT', body: bytes.subarray(index * 2097152, (index + 1) * 2097152), session }));
  }
  return create(`/notes/${note.id}/uploads/${upload.id}/complete`, undefined, session);
}

test('upload responses wait for the PostgreSQL transaction to commit', async () => {
  const owner = await register();
  const note = await create('/notes', { title: 'Commit', content: '', color: 'mint', pinned: false }, owner);
  const bytes = Buffer.from('salvato prima della conferma');
  async function committedRequest(route, options, status) {
    const original = instance.db.atomic;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const callbackFinished = new Promise(resolve => { entered = resolve; });
    instance.db.atomic = callback => original(async () => {
      const result = await callback(); entered(); await gate; return result;
    });
    let responded = false;
    const pending = request(route, { ...options, session: owner }).then(response => { responded = true; return response; });
    try {
      await callbackFinished;
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(responded, false, 'HTTP success must wait for COMMIT');
    } finally { release(); instance.db.atomic = original; }
    return json(await pending, status);
  }
  const upload = await committedRequest(`/notes/${note.id}/uploads`, { method: 'POST', body: { name: 'commit.txt', size: bytes.length } }, 201);
  await committedRequest(`/notes/${note.id}/uploads/${upload.id}/chunks/0`, { method: 'PUT', body: bytes }, 200);
  const file = await committedRequest(`/notes/${note.id}/uploads/${upload.id}/complete`, { method: 'POST' }, 201);
  assert.deepEqual(await instance.db.files.get(file.id), bytes);
});

test('PostgreSQL preserves accounts, sharing, financial workflows and isolation across instances', async () => {
  const owner = await register(); const invitation = await json(await request('/invitation', { method: 'POST', session: owner }));
  const member = await register('member@example.test', invitation.code); const stranger = await register('stranger@example.test');
  const categoryId = (await state(owner)).categories[0].id;
  await create('/transactions', { kind: 'income', amount: 250000, description: 'Entrata test', date: '2026-10-01' }, owner);
  const goal = await create('/goals', { title: 'Viaggio', horizon: 'medium', target: 50000, saved: 0 }, owner);
  await create(`/goals/${goal.id}/contributions`, { amount: 1000 }, member);
  const bill = await create('/bills', { name: 'Internet', amount: 2500, categoryId, dueDay: 31, startMonth: '2026-10', reminderDays: 3 }, owner);
  const other = await start();
  const payments = await Promise.all([base, other.base].map(target => request(`/bills/${bill.id}/payments`, { method: 'POST', body: { month: '2026-10', amount: 2500, paymentDate: '2026-10-04' }, session: owner, target })));
  assert.deepEqual(payments.map(p => p.status).sort(), [201, 409]);
  const meal = await create('/meals', { date: '2026-10-05', slot: 'lunch', title: 'Pasta', servings: 2, ingredients: [{ name: 'Pasta', quantity: '200 g', section: 'Dispensa' }], notes: '' }, member);
  await json(await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: member }));
  await json(await request(`/meals/${meal.id}/shopping`, { method: 'POST', session: member }));
  const shared = await state(owner); assert.equal(shared.transactions.length, 2); assert.equal(shared.goals[0].saved, 1000); assert.equal(shared.shopping.length, 1); assert.ok(shared.bills[0].payment);
  const separate = await state(stranger); assert.equal(separate.transactions.length, 0); assert.equal(separate.meals.length, 0);
  assert.equal((await request(`/goals/${goal.id}`, { method: 'DELETE', session: stranger })).status, 404);
  assert.equal((await request('/shopping', { method: 'POST', session: owner, headers: { 'x-csrf-token': '' }, body: { name: 'No', quantity: '1', section: 'Dispensa' } })).status, 403);
  const result = await json(await request('/state?month=2026-10', { session: owner, target: other.base })); assert.equal(result.transactions.length, 2);
});

test('10 MB uploads use bounded chunks, preserve exact bytes and enforce private ownership', async () => {
  const owner = await register(); const stranger = await register('stranger@example.test');
  const note = await create('/notes', { title: 'Documento', content: '', color: 'mint', pinned: true }, owner);
  const bytes = randomBytes(10 * 1024 * 1024);
  const file = await attach(owner, note, bytes);
  const response = await request(`/attachments/${file.id}`, { session: owner }); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await request(`/attachments/${file.id}`, { session: stranger })).status, 404);
  const other = await start();
  const persistent = await request(`/attachments/${file.id}`, { session: owner, target: other.base }); assert.deepEqual(Buffer.from(await persistent.arrayBuffer()), bytes);
  const exported = await request('/backups/export', { session: owner }); assert.equal(exported.status, 200);
  const zip = unzipSync(new Uint8Array(await exported.arrayBuffer())); assert.deepEqual(Buffer.from(zip[`allegati/${file.id}`]), bytes);
  const payload = JSON.parse(Buffer.from(zip['casa.json'])); assert.equal(payload.members.length, 1); assert.equal(JSON.stringify(payload).includes('password_hash'), false); assert.equal(JSON.stringify(payload).includes('stranger@example.test'), false);
  await json(await request(`/attachments/${file.id}`, { method: 'DELETE', session: owner }));
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM files').get()).count, 0);
});

test('daily cloud backups retain seven verified snapshots and restore exact account and file data', async () => {
  const owner = await register();
  const month = new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Rome', year:'numeric', month:'2-digit' }).format(new Date());
  await create('/recurring', { kind:'income', name:'Reddito da ripristinare', amount:100000, day:1, startMonth:month, enabled:true }, owner);
  const preset = (await state(owner)).budgetTemplates[0];
  await json(await request(`/budget-templates/${preset.id}/apply`, { method:'POST', session:owner })); const note = await create('/notes', { title: 'Copia', content: 'Test', color: 'mint', pinned: false }, owner);
  const bytes = Buffer.from('allegato da ripristinare'); const file = await attach(owner, note, bytes);
  let stamp = Date.UTC(2026, 9, 4);
  const manager = createCloudBackups(instance.db, { scheduled: true, clock: () => stamp });
  assert.equal((await request('/internal/backup')).status, 401);
  assert.equal((await request('/internal/backup', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  for (let i = 0; i < 8; i++) { await manager.take(); stamp += 86400_000; }
  await Promise.all([manager.runIfDue(), manager.runIfDue()]);
  const today = new Date(stamp).toISOString().slice(0, 10);
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM backup_archives WHERE substr(created_at, 1, 10) = ?').get(today)).count, 1);
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM backup_archives').get()).count, 7);
  const archive = await instance.db.prepare('SELECT data FROM backup_archives ORDER BY created_at DESC LIMIT 1').get();
  const zip = unzipSync(archive.data); const temp = mkdtempSync(path.join(os.tmpdir(), 'casa-cloud-restore-'));
  try {
    const source = path.join(temp, 'snapshot'); mkdirSync(source);
    for (const [name, content] of Object.entries(zip)) {
      if (name.endsWith('/')) { mkdirSync(path.join(source, name), { recursive: true }); continue; }
      assert.ok(!name.includes('..')); mkdirSync(path.dirname(path.join(source, name)), { recursive: true }); writeFileSync(path.join(source, name), content);
    }
    verifyInstanceBackup(source); const destination = path.join(temp, 'restored'); restoreInstanceBackup(source, destination);
    assert.deepEqual(readFileSync(path.join(destination, 'uploads', file.id)), bytes);
    await assert.rejects(restoreCloudBackup(source, connectionString, { local: true }), /contiene già lo schema casa/);
    const pool = new Pool({ connectionString });
    const target = new URL(connectionString); target.pathname = '/casa_restore_test';
    try {
      await pool.query('DROP DATABASE IF EXISTS casa_restore_test');
      await pool.query('CREATE DATABASE casa_restore_test');
      await restoreCloudBackup(source, target.toString(), { local: true });
      const restored = await createCloudApp({ connectionString: target.toString(), local: true });
      try {
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM users').get()).count, 1);
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM recurring_rules').get()).count, 1);
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM recurring_occurrences').get()).count, 1);
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM budget_templates').get()).count, 6);
        assert.equal((await restored.db.prepare('SELECT active_template_id FROM budget_settings').get()).active_template_id, preset.id);
        assert.deepEqual(await restored.db.files.get(file.id), bytes);
      } finally { await restored.close(); }
    } finally { await pool.query('DROP DATABASE IF EXISTS casa_restore_test'); await pool.end(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const successful = await json(await request('/internal/backup', { headers: { authorization: 'Bearer test-cron-local-only' } })); assert.equal(successful.status, 'ok');
});

test('cloud authentication limits survive fresh instances and TLS bypass is restricted to local tests', async () => {
  await register();
  for (let i = 0; i < 29; i++) assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'owner@example.test', password: 'incorrect-password' } })).status, 401);
  const other = await start();
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'owner@example.test', password: 'test-password-123' }, target: other.base })).status, 429);
  await assert.rejects(openPostgres('postgresql://user:example@remote.example.test/db', { local: true }), /solo per test su loopback/);
});

test('incomplete uploads cannot cross families and failed cloud backup is reported without changing live data', async () => {
  const owner = await register(); const stranger = await register('stranger@example.test');
  const note = await create('/notes', { title: 'Riservato', content: 'Da preservare', color: 'mint', pinned: false }, owner);
  const pending = await create(`/notes/${note.id}/uploads`, { name: 'test.txt', size: 4 }, owner);
  assert.equal((await request(`/notes/${note.id}/uploads/${pending.id}/chunks/0`, { method: 'PUT', body: Buffer.from('test'), session: stranger })).status, 404);
  assert.equal((await request(`/notes/${note.id}/uploads/${pending.id}/complete`, { method: 'POST', session: owner })).status, 400);
  await json(await request(`/notes/${note.id}/uploads/${pending.id}/chunks/0`, { method: 'PUT', body: Buffer.from('test'), session: owner }));
  await json(await request(`/notes/${note.id}/uploads/${pending.id}/chunks/0`, { method: 'PUT', body: Buffer.from('test'), session: owner }));
  const file = await create(`/notes/${note.id}/uploads/${pending.id}/complete`, undefined, owner);
  await instance.db.files.remove(file.id); // Simulate storage damage in this disposable database.
  await instance.backups.runIfDue();
  assert.ok((await instance.backups.status()).error);
  assert.equal((await state(owner)).notes[0].content, 'Da preservare');
  assert.equal((await request('/internal/backup', { headers: { authorization: 'Bearer test-cron-local-only' } })).status, 503);
});

test('recurrences synchronize concurrent cloud instances and templates remain family-scoped through backups', async () => {
  const owner=await register();const stranger=await register('other@example.test');
  const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit'}).format(new Date());
  const categoryId=(await state(owner)).categories[0].id;
  await create('/recurring',{kind:'income',name:'Reddito',amount:200001,day:31,startMonth:current,enabled:true},owner);
  const cost=await create('/recurring',{kind:'expense',name:'Affitto',amount:80000,day:1,startMonth:current,categoryId,enabled:true},owner);
  const second=await start();
  const [year, monthNumber] = current.split('-').map(Number);
  const future = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
  const views=await Promise.all(Array.from({length:6},(_,i)=>request(`/state?month=${future}`,{session:owner,target:i%2?base:second.base}).then(r=>json(r))));
  assert.ok(views.every(v=>v.transactions.length===2));
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM recurring_occurrences').get()).count,4);
  assert.equal((await request(`/recurring/${cost.id}/stop`,{method:'POST',session:stranger,body:{effectiveMonth:current}})).status,404);
  const template=views[0].budgetTemplates.find(t=>t.template_key==='prudent');
  await json(await request(`/budget-templates/${template.id}/apply`,{method:'POST',session:owner}));
  const shared=await json(await request(`/state?month=${current}`,{session:owner,target:second.base}));
  assert.equal(shared.activeTemplateId,template.id);assert.equal(shared.categories[0].percentage,3500);
  const exported=await request('/backups/export',{session:owner});const zip=unzipSync(new Uint8Array(await exported.arrayBuffer()));const data=JSON.parse(Buffer.from(zip['casa.json'])).data;
  assert.equal(data.recurring_rules.length,2);assert.equal(data.recurring_versions.length,2);assert.equal(data.recurring_occurrences.length,4);assert.equal(data.budget_templates.length,6);
  assert.equal((await state(stranger)).recurring.length,0);
});
