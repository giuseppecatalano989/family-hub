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
import { removeMember } from '../server/member-removal.mjs';

const connectionString = process.env.CASA_TEST_DATABASE_URL;
if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('I test cloud richiedono CASA_TEST_DATABASE_URL su un PostgreSQL temporaneo locale. Non usare un database reale.');
let instances, servers, instance, base;
async function start(options = {}) {
  const app = await createCloudApp({ connectionString, local: true, cronSecret: 'test-cron-local-only', ...options });
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
  const wasteSchedule = await create('/waste', { name:'Carta', days:[0,4], timeWindow:'20:00–22:00', notes:'Cartoni piegati', color:'#8099b0' }, owner);
  const categoryId = (await state(owner)).categories[0].id;
  const deadline = await create('/deadlines', { name:'Scadenza da ripristinare', startDate:'2026-10-14', frequency:'once', requiresPayment:true, amount:990, categoryId, reminderDays:3 }, owner);
  const receipt = await create(`/deadlines/${deadline.id}/manage`, { month:'2026-10', handledDate:'2026-10-14' }, owner);
  const free = await create('/deadlines', { name:'Appuntamento', startDate:'2026-10-15', frequency:'once', requiresPayment:false, reminderDays:0 }, owner);
  await create(`/deadlines/${free.id}/manage`, { month:'2026-10', handledDate:'2026-10-15' }, owner);
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
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM budget_templates').get()).count, 5);
        assert.deepEqual(JSON.parse((await restored.db.prepare('SELECT days FROM waste_schedules WHERE id = ?').get(wasteSchedule.id)).days), [0,4]);
        assert.equal((await restored.db.prepare('SELECT active_template_id FROM budget_settings').get()).active_template_id, preset.id);
        assert.deepEqual(await restored.db.files.get(file.id), bytes);
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM deadlines').get()).count, 2);
        assert.equal((await restored.db.prepare('SELECT COUNT(*) AS count FROM deadline_receipts').get()).count, 2);
        assert.equal((await restored.db.prepare('SELECT transaction_id FROM deadline_receipts WHERE deadline_id = ?').get(deadline.id)).transaction_id, receipt.transactionId);
        assert.equal((await restored.db.prepare('SELECT transaction_id FROM deadline_receipts WHERE deadline_id = ?').get(free.id)).transaction_id, null);
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
  assert.equal(data.recurring_rules.length,2);assert.equal(data.recurring_versions.length,2);assert.equal(data.recurring_occurrences.length,4);assert.equal(data.budget_templates.length,5);
  assert.equal((await state(stranger)).recurring.length,0);
});

test('waste calendars persist across cloud instances and are isolated by family', async () => {
  const owner=await register();const stranger=await register('waste-stranger@example.test');
  const body={name:'Organico',days:[0,3,6],timeWindow:'Dalle 20:00',notes:'Esporre il contenitore',color:'#176854'};
  const schedule=await create('/waste',body,owner);const second=await start();
  const shared=await json(await request('/state?month=2026-10',{session:owner,target:second.base}));assert.deepEqual(shared.waste[0].days,body.days);assert.equal(shared.waste[0].time_window,body.timeWindow);
  assert.equal((await state(stranger)).waste.length,0);
  assert.equal((await request(`/waste/${schedule.id}`,{method:'PUT',session:stranger,body,target:second.base})).status,404);
  const exported=await request('/backups/export',{session:owner,target:second.base});const zip=unzipSync(new Uint8Array(await exported.arrayBuffer()));assert.equal(JSON.parse(Buffer.from(zip['casa.json'])).data.waste_schedules[0].id,schedule.id);
  await json(await request(`/waste/${schedule.id}`,{method:'DELETE',session:owner,target:second.base}));assert.equal((await state(owner)).waste.length,0);
});


test('deadline management is atomic across cloud instances, optional and private in family backups', async () => {
  const owner = await register(); const stranger = await register('deadline-stranger@example.test');
  const categoryId = (await instance.db.prepare('SELECT id FROM categories WHERE household_id = ? ORDER BY position').get(owner.user.householdId)).id;
  const legacy = await create('/bills', { name:'Storica', amount:2500, categoryId, dueDay:31, startMonth:'2026-02', reminderDays:3 }, owner);
  const oldPayment = await create(`/bills/${legacy.id}/payments`, { month:'2026-10', paymentDate:'2026-10-03', amount:2490 }, owner);
  await instance.db.prepare('DELETE FROM deadline_receipts WHERE deadline_id = ?').run(legacy.id);
  await instance.db.prepare('DELETE FROM deadlines WHERE id = ?').run(legacy.id);
  const second = await start();
  const migrations = await Promise.all([base,second.base].map(target => request('/state?month=2026-10', { session:owner, target }).then(r => json(r))));
  for (const current of migrations) { assert.equal(current.deadlines.length,1); assert.equal(current.deadlines[0].managed.transaction_id, oldPayment.transactionId); }
  const paid = await create('/deadlines', { name:'Revisione', startDate:'2026-10-03', frequency:'once', requiresPayment:true, amount:8000, categoryId, reminderDays:3 }, owner);
  const results = await Promise.all([base,second.base].map(target => request(`/deadlines/${paid.id}/manage`, { method:'POST', body:{month:'2026-10',handledDate:'2026-10-03'}, session:owner, target })));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const receipt = await results.find(r=>r.status===201).json();
  assert.equal((await state(owner)).transactions.length,2);
  const free = await create('/deadlines', { name:'Appuntamento', startDate:'2026-10-03', frequency:'once', requiresPayment:false, reminderDays:3 }, owner);
  assert.equal((await create(`/deadlines/${free.id}/manage`, { month:'2026-10',handledDate:'2026-10-03',amount:7000 }, owner)).transactionId,null);
  assert.equal((await request(`/deadlines/${paid.id}/manage/2026-10`,{method:'DELETE',session:stranger})).status,404);
  assert.equal((await state(stranger)).deadlines.length,0);
  const exported = await request('/backups/export',{session:owner,target:second.base}); assert.equal(exported.status,200);
  const zip = unzipSync(new Uint8Array(await exported.arrayBuffer())); const payload = JSON.parse(Buffer.from(zip['casa.json']));
  assert.equal(payload.data.deadlines.length,3); assert.equal(payload.data.deadline_receipts.length,3);
  await json(await request(`/deadlines/${paid.id}/manage/2026-10`,{method:'DELETE',session:owner,target:second.base}));
  assert.equal((await state(owner)).transactions.some(t=>t.id===receipt.transactionId),false);
  assert.equal((await state(owner)).deadlines.find(d=>d.id===paid.id).managed,null);
  await json(await request(`/deadlines/${legacy.id}/manage/2026-10`,{method:'DELETE',session:owner,target:second.base}));
  assert.equal((await state(owner)).deadlines.find(d=>d.id===legacy.id).managed,null);
  const mixed = await Promise.all([
    request(`/bills/${legacy.id}/payments`,{method:'POST',body:{month:'2026-10',paymentDate:'2026-10-31',amount:2500},session:owner}),
    request(`/deadlines/${legacy.id}/manage`,{method:'POST',body:{month:'2026-10',handledDate:'2026-10-31',amount:2500},session:owner,target:second.base}),
  ]);
  assert.deepEqual(mixed.map(r=>r.status).sort(),[201,409]);
  assert.equal((await state(owner)).transactions.length,1);
});

test('account settings and recurring deletion stay isolated and consistent across cloud instances', async () => {
  const owner=await register();const stranger=await register('settings-stranger@example.test');const second=await start();
  await json(await request('/account',{method:'PUT',session:owner,body:{name:'Giuseppe Catalano',email:owner.user.email},target:second.base}));
  assert.equal((await json(await request('/session',{session:owner}))).user.name,'Giuseppe Catalano');
  await json(await request('/household',{method:'PUT',session:owner,body:{name:'Casa Catalano'},target:second.base}));
  assert.equal((await state(owner)).household.name,'Casa Catalano');assert.equal((await state(stranger)).household.name,'Famiglia test cloud');
  const loginResponse=await request('/auth/login',{method:'POST',body:{email:owner.user.email,password:'test-password-123'},target:second.base});const login=await json(loginResponse);
  const other={cookie:loginResponse.headers.get('set-cookie').split(';')[0],csrf:login.csrf};
  await json(await request('/account/password',{method:'PUT',session:owner,body:{currentPassword:'test-password-123',newPassword:'replacement-password-456'}}));
  assert.equal((await request('/state?month=2026-10',{session:other,target:second.base})).status,401);
  const view=await state(owner);const template=view.budgetTemplates.find(t=>t.template_key==='conservative');
  assert.equal((await request(`/budget-templates/${template.id}`,{method:'PUT',session:owner,body:{entries:template.entries},target:second.base})).status,403);
  const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit'}).format(new Date());
  const rule=await create('/recurring',{kind:'income',name:'Entrata errata',amount:5000,day:1,startMonth:current,enabled:true},owner);
  assert.equal((await request(`/recurring/${rule.id}`,{method:'DELETE',session:stranger,target:second.base})).status,404);
  const results=await Promise.all([
    request(`/state?month=${current}`,{session:owner,target:second.base}),
    request(`/recurring/${rule.id}`,{method:'DELETE',session:owner}),
  ]);for(const r of results)await json(r);
  const final=await json(await request(`/state?month=${current}`,{session:owner,target:second.base}));assert.equal(final.recurring.length,0);assert.equal(final.transactions.length,0);
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM recurring_occurrences').get()).count,0);
});

test('concurrent savings corrections keep cloud totals and their history consistent across instances', async () => {
  const owner = await register();
  const stranger = await register('savings-stranger@example.test');
  const second = await start();
  const goal = await create('/goals', { title: 'Viaggio', horizon: 'medium', target: 100000, saved: 5000 }, owner);
  const first = await create(`/goals/${goal.id}/contributions`, { amount: 2500 }, owner);
  const other = await create(`/goals/${goal.id}/contributions`, { amount: 3000 }, owner);
  const editPath = `/goals/${goal.id}/contributions/${first.id}`;
  assert.equal((await request(editPath, { method: 'PUT', body: { amount: 1000 }, session: stranger, target: second.base })).status, 404);
  const writes = await Promise.all([
    request(editPath, { method: 'PUT', body: { amount: 1500 }, session: owner }),
    request(`/goals/${goal.id}/initial-savings`, { method: 'PUT', body: { amount: 2000 }, session: owner, target: second.base }),
    request(`/goals/${goal.id}/contributions/${other.id}`, { method: 'DELETE', session: owner, target: second.base }),
    request(`/goals/${goal.id}/contributions`, { method: 'POST', body: { amount: 700 }, session: owner }),
  ]);
  for (const response of writes) assert.ok([200, 201].includes(response.status), await response.clone().text());
  const shared = await json(await request('/state?month=2026-10', { session: owner, target: second.base }));
  assert.equal(shared.goals[0].saved, 4200);
  assert.equal(shared.goals[0].initial_saved, 2000);
  assert.equal(shared.contributions.reduce((sum, item) => sum + item.amount, 0), 2200);
  assert.equal(shared.contributions.length, 2);
  const raced = await Promise.all([
    request(editPath, { method: 'PUT', body: { amount: 1000 }, session: owner }),
    request(editPath, { method: 'DELETE', session: owner, target: second.base }),
  ]);
  assert.ok(raced.every(response => [200, 404].includes(response.status)));
  const final = await state(owner);
  assert.equal(final.goals[0].saved, 2700);
  assert.equal(final.goals[0].initial_saved, 2000);
  assert.equal(final.contributions.length, 1);
  assert.equal(final.transactions.length, 0);
  await json(await request(`/goals/${goal.id}/initial-savings`, { method: 'DELETE', session: owner, target: second.base }));
  assert.equal((await state(owner)).goals[0].saved, 700);
  assert.equal((await state(stranger)).contributions.length, 0);
});

test('email password resets commit across instances and can only be consumed once', async () => {
  const owner = await register(); const member = await register('member@example.test', (await json(await request('/invitation', { method: 'POST', session: owner }))).code);
  const messages = [];
  const second = await start({ resetMailer: async message => messages.push(message) });
  const known = await json(await request('/auth/forgot-password', { method: 'POST', body: { email: 'member@example.test' }, target: second.base }));
  const unknown = await json(await request('/auth/forgot-password', { method: 'POST', body: { email: 'unknown@example.test' }, target: second.base }));
  assert.deepEqual(known, unknown); assert.equal(messages.length, 1);
  const stored = await instance.db.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').get(member.user.id);
  assert.notEqual(stored.token_hash, messages[0].token);
  const body = { token: messages[0].token, newPassword: 'recovered-password-123' };
  const responses = await Promise.all([request('/auth/reset-password', { method: 'POST', body }), request('/auth/reset-password', { method: 'POST', body, target: second.base })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal((await json(await request('/session', { session: member }))).user, null);
  assert.equal((await request('/state?month=2026-10', { session: owner })).status, 200);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'member@example.test', password: 'test-password-123' } })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'member@example.test', password: 'recovered-password-123' } })).status, 200);
});

test('operator member removal preserves shared records, requires a backup and never removes a recreated account on retry', async () => {
  const owner = await register();
  await json(await request('/account', { method: 'PUT', session: owner, body: { name: 'Giuseppe Catalano', email: owner.user.email } }));
  const invitation = await json(await request('/invitation', { method: 'POST', session: owner }));
  const member = await register('simona@example.test', invitation.code);
  await json(await request('/account', { method: 'PUT', session: member, body: { name: 'Simona Biscardi', email: member.user.email } }));
  const stranger = await register('stranger@example.test');
  const categoryId = (await state(owner)).categories[0].id;
  const transaction = await create('/transactions', { kind: 'expense', amount: 1234, categoryId, description: 'Da preservare', date: '2026-10-05' }, member);
  const goal = await create('/goals', { title: 'Viaggio', horizon: 'medium', target: 50000, saved: 0 }, member);
  await create(`/goals/${goal.id}/contributions`, { amount: 1000 }, member);
  await create('/shopping', { name: 'Pane', quantity: '1', section: 'Altro' }, member);
  const note = await create('/notes', { title: 'Condivisa', content: 'Da preservare', color: 'mint', pinned: true }, member);
  const bytes = Buffer.from('conservare il file');
  const attachment = await attach(member, note, bytes);
  const upload = await create(`/notes/${note.id}/uploads`, { name: 'incompleto.txt', size: 4 }, member);
  await json(await request(`/notes/${note.id}/uploads/${upload.id}/chunks/0`, { method: 'PUT', body: Buffer.from('test'), session: member }));
  await create('/meals', { date: '2026-10-05', slot: 'lunch', title: 'Pasta', servings: 2, ingredients: [], notes: '' }, member);
  await create('/recurring', { kind: 'income', name: 'Reddito', amount: 150000, day: 1, startMonth: '2026-10', enabled: true }, member);
  const deadline = await create('/deadlines', { name: 'Appuntamento', startDate: '2026-10-05', frequency: 'once', requiresPayment: false, reminderDays: 0 }, member);
  await create(`/deadlines/${deadline.id}/manage`, { month: '2026-10', handledDate: '2026-10-05' }, member);
  await instance.db.prepare('INSERT INTO password_resets VALUES (?, ?, ?)').run('test-hash', member.user.id, Date.now() + 10000);
  const options = { db: instance.db, requestId: 'test-member-removal-once', memberName: 'Simona Biscardi', adminName: 'Giuseppe Catalano', takeBackup: () => instance.backups.take() };
  await assert.rejects(removeMember({ ...options, adminName: 'Wrong family' }), /non identificato/);
  await assert.rejects(removeMember({ ...options, memberName: 'Giuseppe Catalano' }), /non identificato/);
  await assert.rejects(removeMember({ ...options, takeBackup: async () => { throw new Error('backup unavailable'); } }), /backup unavailable/);
  assert.ok(await instance.db.prepare('SELECT id FROM users WHERE id = ?').get(member.user.id));
  const result = await removeMember(options);
  assert.equal(result.removed, true);
  assert.ok(result.preservedRecords >= 7);
  assert.ok(await instance.db.prepare('SELECT id FROM backup_archives WHERE id = ?').get(result.backupId));
  assert.equal(await instance.db.prepare('SELECT id FROM users WHERE id = ?').get(member.user.id), undefined);
  for (const table of ['sessions', 'password_resets', 'file_uploads']) assert.equal((await instance.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(member.user.id)).count, 0);
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS count FROM file_upload_chunks').get()).count, 0);
  for (const table of ['transactions', 'contributions', 'shopping', 'notes', 'meals', 'recurring_rules', 'deadline_receipts']) assert.equal((await instance.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE author_id = ?`).get(member.user.id)).count, 0);
  assert.equal((await instance.db.prepare('SELECT author_id FROM transactions WHERE id = ?').get(transaction.id)).author_id, owner.user.id);
  assert.deepEqual(await instance.db.files.get(attachment.id), bytes);
  assert.equal((await json(await request('/session', { session: member }))).user, null);
  assert.equal((await state(owner)).notes[0].content, 'Da preservare');
  assert.equal((await state(stranger)).transactions.length, 0);
  const recreated = await register('simona@example.test', invitation.code);
  await json(await request('/account', { method: 'PUT', session: recreated, body: { name: 'Simona Biscardi', email: recreated.user.email } }));
  assert.equal((await removeMember(options)).repeated, true);
  assert.ok(await instance.db.prepare('SELECT id FROM users WHERE id = ?').get(recreated.user.id));
});

test('bank links share balances across instances, sync from the protected cron and stay out of family exports', async () => {
  const NOW = Date.parse('2026-10-15T10:00:00Z');
  const calls = []; const extra = [];
  const provider = { secret: Buffer.alloc(32, 9),
    async banks() { return [{ name: 'Intesa Sanpaolo', country: 'IT', maxConsentSeconds: 15552000 }]; },
    async startAuthorization({ state: value }) { return `https://bank.example/auth?state=${value}`; },
    async createSession(code) { return { sessionId: `sess-${code}`, validUntil: '2027-04-01T00:00:00Z', accounts: [{ uid: `uid-${code}`, iban: code === 'a' ? 'IT60X0542811101000000123456' : 'IT02A0301503200000003517230', name: `Conto ${code}`, currency: 'EUR' }] }; },
    async balances(uid) { return [{ balance_type: 'ITAV', balance_amount: { amount: uid === 'uid-a' ? '12345678.90' : '-5.50', currency: 'EUR' } }]; },
    async transactions(uid) { calls.push(uid); return [{ entry_reference: `${uid}-1`, transaction_amount: { amount: '19.90', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-10-02', creditor: { name: 'Esselunga' } }, ...(uid === 'uid-a' ? extra : [])]; },
    async endSession() {},
  };
  const first = await start({ bankProvider: provider, clock: () => NOW });
  const second = await start({ bankProvider: provider, clock: () => NOW });
  const owner = await register();
  const invitation = await json(await request('/invitation', { method: 'POST', session: owner }));
  const member = await register('member-bank@example.test', invitation.code);
  async function link(session, code, visibility, target) {
    const started = await json(await request('/bank/connections', { method: 'POST', session, body: { bank: 'Intesa Sanpaolo', visibility }, target }), 201);
    const response = await fetch(`${target}/bank/callback?code=${code}&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: session.cookie, 'x-forwarded-proto': 'https' } });
    assert.equal(response.headers.get('location'), '/?banca=collegato#bank');
  }
  await link(owner, 'a', 'shared', first.base);
  await link(member, 'b', 'balance', second.base);
  const data = await json(await request('/state?month=2026-10&week=2026-10-05', { session: owner, target: second.base }));
  assert.equal(data.bank.total, 1234567890 - 550);
  assert.equal(data.transactions.filter(t => t.description === 'Esselunga').length, 1);
  assert.equal(data.transactions.find(t => t.description === 'Esselunga').category_id, data.categories[1].id);
  assert.equal(data.bank.movements.length, 1, 'the member keeps balance-only movements private');
  assert.deepEqual(data.transactions.filter(t => t.privacy === 'others').map(t => [t.description, t.amount]), [['Spese di Prova', 1990]], 'private movements still count in the budget');
  const pool = new Pool({ connectionString });
  try {
    const secrets = (await pool.query('SELECT session_secret FROM casa.bank_connections')).rows;
    assert.ok(secrets.every(r => r.session_secret.startsWith('v1.') && !r.session_secret.includes('sess-')));
    await pool.query("UPDATE casa.bank_connections SET last_attempt_at = '2026-10-15T03:00:00.000Z'");
  } finally { await pool.end(); }
  const before = calls.length;
  assert.equal((await fetch(`${second.base}/internal/backup`, { headers: { authorization: 'Bearer test-cron-local-only' } })).status, 200);
  assert.equal(calls.length, before + 2);
  assert.equal((await json(await request('/state?month=2026-10&week=2026-10-05', { session: owner, target: first.base }))).transactions.filter(t => t.description === 'Esselunga').length, 1, 'cron re-sync does not duplicate imports');
  // Savings: a Trade Republic deposit is filed under Risparmio and feeds the linked goal.
  extra.push({ entry_reference: 'tr-1', transaction_amount: { amount: '200.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-10-05', creditor: { name: 'Trade Republic Bank GmbH' }, creditor_account: { iban: 'IT55T0300203280000000000777' } });
  const goal = await create('/goals', { title: 'Fondo emergenze', horizon: 'short', target: 100000 }, owner);
  const reset = new Pool({ connectionString });
  try { await reset.query("UPDATE casa.bank_connections SET last_attempt_at = '2026-10-15T03:00:00.000Z'"); } finally { await reset.end(); }
  assert.equal((await fetch(`${first.base}/internal/backup`, { headers: { authorization: 'Bearer test-cron-local-only' } })).status, 200);
  let saving = await json(await request('/state?month=2026-10&week=2026-10-05', { session: member, target: second.base }));
  assert.equal(saving.transactions.find(t => t.amount === 20000).category_id, saving.categories[5].id);
  assert.deepEqual(saving.bank.savings.map(d => [d.name, d.linked, d.enabled]), [['Trade Republic Bank GmbH', false, true]]);
  await json(await request(`/bank/savings/${saving.bank.savings[0].id}`, { method: 'PATCH', session: member, body: { goalId: goal.id }, target: second.base }));
  extra.push({ entry_reference: 'tr-2', transaction_amount: { amount: '150.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-10-12', creditor: { name: 'TRB' }, creditor_account: { iban: 'IT55T0300203280000000000777' } });
  const again = new Pool({ connectionString });
  try { await again.query('UPDATE casa.bank_connections SET last_attempt_at = NULL'); } finally { await again.end(); }
  assert.equal((await json(await request('/bank/refresh', { method: 'POST', session: owner, target: first.base }))).synced, 2, 'own account with the owner present, the other one past the unattended limit');
  saving = await json(await request('/state?month=2026-10&week=2026-10-05', { session: owner, target: second.base }));
  assert.equal(saving.goals.find(g => g.id === goal.id).saved, 15000);
  const deposit = saving.transactions.find(t => t.amount === 15000);
  await json(await request(`/transactions/${deposit.id}`, { method: 'DELETE', session: owner, target: first.base }));
  assert.equal((await json(await request('/state?month=2026-10&week=2026-10-05', { session: owner, target: second.base }))).goals.find(g => g.id === goal.id).saved, 0);
  const exported = await request('/backups/export', { session: owner, target: first.base });
  const payload = JSON.parse(Buffer.from(unzipSync(new Uint8Array(await exported.arrayBuffer()))['casa.json']).toString('utf8'));
  assert.equal(JSON.stringify(payload).includes('session_secret'), false);
  assert.equal(payload.data.bank_accounts.length, 2); assert.equal(payload.data.bank_movements.length, 3, 'shared movements only'); assert.equal(payload.data.savings_destinations.length, 1);
});
