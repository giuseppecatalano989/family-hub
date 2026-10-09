import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ZipArchive } from 'archiver';

const FORMAT = 'casa-instance-backup/v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
function fileInfo(filename) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Il backup contiene un file non regolare.');
  return { size: info.size, sha256: digest(filename) };
}
function assertStorageName(name) { if (typeof name !== 'string' || !uuid.test(name)) throw new Error('Percorso allegato non valido nel backup.'); }

// Synchronous DB snapshot and file copies form one event-loop operation: requests
// cannot delete/replace attachments between the SQLite snapshot and the copies.
export function snapshotInstance(db, dataDir, destination, createdAt = new Date().toISOString()) {
  mkdirSync(destination, { mode: 0o700 });
  try {
    const database = path.join(destination, 'casa.sqlite');
    db.prepare('VACUUM INTO ?').run(database); chmodSync(database, 0o600);
    const snapshot = new DatabaseSync(database);
    let attachments;
    try {
      for (const table of ['password_resets', 'bank_auth_requests']) if (snapshot.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table)) snapshot.exec(`DELETE FROM ${table}`);
      snapshot.exec('VACUUM');
      attachments = snapshot.prepare('SELECT storage_name FROM attachments').all();
    }
    finally { snapshot.close(); }
    mkdirSync(path.join(destination, 'uploads'), { mode: 0o700 });
    const files = attachments.map(({ storage_name }) => {
      assertStorageName(storage_name);
      const source = path.join(dataDir, 'uploads', storage_name); fileInfo(source);
      const target = path.join(destination, 'uploads', storage_name);
      copyFileSync(source, target); chmodSync(target, 0o600);
      return { name: storage_name, ...fileInfo(target) };
    });
    const manifest = { format: FORMAT, createdAt, database: fileInfo(database), files };
    writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    verifyInstanceBackup(destination);
    return manifest;
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function verifyInstanceBackup(directory) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (lstatSync(manifestFile).size > 10 * 1024 * 1024) throw new Error('Manifest troppo grande.');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files) || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Formato backup non supportato.');
  const check = (filename, expected) => {
    const actual = fileInfo(filename);
    if (!expected || actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error('Integrità del backup non valida.');
  };
  const database = path.join(directory, 'casa.sqlite'); check(database, manifest.database);
  const names = new Set();
  for (const file of manifest.files) {
    assertStorageName(file.name);
    if (names.has(file.name)) throw new Error('Allegato duplicato nel manifest.'); names.add(file.name);
    check(path.join(directory, 'uploads', file.name), file);
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database del backup non valido.');
    const attachments = db.prepare('SELECT storage_name FROM attachments').all();
    if (attachments.length !== names.size || attachments.some(a => !names.has(a.storage_name))) throw new Error('Gli allegati non corrispondono al database.');
  } finally { db.close(); }
  return manifest;
}

export function restoreInstanceBackup(source, destination) {
  const manifest = verifyInstanceBackup(source);
  if (existsSync(destination)) throw new Error('La destinazione esiste già: scegli una nuova directory per preservare i dati attuali.');
  mkdirSync(destination, { mode: 0o700 });
  try {
    copyFileSync(path.join(source, 'casa.sqlite'), path.join(destination, 'casa.sqlite'));
    chmodSync(path.join(destination, 'casa.sqlite'), 0o600);
    mkdirSync(path.join(destination, 'uploads'), { mode: 0o700 });
    for (const file of manifest.files) {
      const target = path.join(destination, 'uploads', file.name);
      copyFileSync(path.join(source, 'uploads', file.name), target); chmodSync(target, 0o600);
    }
    // Rehash restored files, so an interrupted/changed source cannot look restored.
    if (digest(path.join(destination, 'casa.sqlite')) !== manifest.database.sha256 || manifest.files.some(f => digest(path.join(destination, 'uploads', f.name)) !== f.sha256)) throw new Error('Verifica del ripristino non riuscita.');
    return manifest;
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function createBackupManager({ db, dataDir, backupDir = `${dataDir}-backups`, enabled = true, intervalMs = 86400_000, retention = 7, clock = Date.now }) {
  if (path.resolve(backupDir) === path.resolve(dataDir)) throw new Error('La directory backup deve essere distinta dai dati.');
  let timer; let error = null;
  function history() {
    if (!existsSync(backupDir)) return [];
    let entries;
    try { entries = readdirSync(backupDir, { withFileTypes: true }); }
    catch { error = 'Impossibile leggere la destinazione dei backup. Controlla il percorso e i permessi.'; return []; }
    return entries.filter(e => e.isDirectory() && /^backup-\d+-[a-f0-9-]+$/.test(e.name)).flatMap(e => {
      try {
        const manifest = JSON.parse(readFileSync(path.join(backupDir, e.name, 'manifest.json'), 'utf8'));
        return manifest.format === FORMAT && Number.isFinite(Date.parse(manifest.createdAt)) ? [{ name: e.name, createdAt: manifest.createdAt }] : [];
      } catch { return []; }
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  function status() {
    const last = history()[0];
    return { enabled, lastAt: last?.createdAt || null, nextAt: enabled ? new Date(last ? Date.parse(last.createdAt) + intervalMs : clock()).toISOString() : null, retention, error };
  }
  function take() {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const name = `backup-${clock()}-${randomUUID()}`; const pending = path.join(backupDir, `.partial-${randomUUID()}`);
    const manifest = snapshotInstance(db, dataDir, pending, new Date(clock()).toISOString());
    renameSync(pending, path.join(backupDir, name));
    error = null;
    for (const previous of history().slice(retention)) rmSync(path.join(backupDir, previous.name), { recursive: true, force: true });
    return { directory: path.join(backupDir, name), manifest };
  }
  function runIfDue() {
    if (!enabled) return;
    const last = history()[0];
    if (!last || clock() - Date.parse(last.createdAt) >= intervalMs) {
      try { take(); }
      catch (e) { error = 'Il backup automatico non è riuscito. Controlla la destinazione e lo spazio disponibile.'; console.error('Backup automatico non riuscito:', e.message); }
    }
  }
  return { status, take, runIfDue,
    start() { if (enabled && !timer) { runIfDue(); timer = setInterval(runIfDue, 60000); timer.unref(); } },
    stop() { clearInterval(timer); timer = undefined; },
  };
}

export function streamFamilyBackup(db, dataDir, householdId, response, next) {
  const temporary = path.join(os.tmpdir(), `casa-export-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  const cleanup = () => rmSync(temporary, { recursive: true, force: true });
  try {
    const query = (sql, ...args) => db.prepare(sql).all(...args);
    const own = table => query(`SELECT * FROM ${table} WHERE household_id = ?`, householdId);
    const data = Object.fromEntries(['categories', 'transactions', 'goals', 'shopping', 'notes', 'bills', 'meals', 'recurring_rules', 'budget_templates', 'budget_settings', 'budget_versions', 'waste_schedules', 'deadlines', 'budget_month_overrides', 'advisor_settings', 'advisor_reports'].map(table => [table, own(table)]));
    data.contributions = query('SELECT c.* FROM contributions c JOIN goals g ON g.id = c.goal_id WHERE g.household_id = ?', householdId);
    data.recurring_versions = query('SELECT v.* FROM recurring_versions v JOIN recurring_rules r ON r.id = v.rule_id WHERE r.household_id = ?', householdId);
    data.recurring_occurrences = query('SELECT o.* FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id WHERE r.household_id = ?', householdId);
    data.deadline_receipts = query('SELECT r.* FROM deadline_receipts r JOIN deadlines d ON d.id = r.deadline_id WHERE d.household_id = ?', householdId);
    data.bill_payments = query('SELECT p.* FROM bill_payments p JOIN bills b ON b.id = p.bill_id WHERE b.household_id = ?', householdId);
    // Bank data: no provider sessions or IBAN hashes; private movements stay with their owner.
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'bank_accounts'").get()) {
      const hidden = new Set(query('SELECT p.transaction_id FROM private_transactions p JOIN transactions t ON t.id = p.transaction_id WHERE t.household_id = ?', householdId).map(r => r.transaction_id));
      data.transactions = data.transactions.map(t => hidden.has(t.id) ? { ...t, description: 'Movimento bancario privato' } : t);
      data.bank_connections = query('SELECT id, user_id, aspsp_name, aspsp_country, valid_until, status, last_sync_at, created_at FROM bank_connections WHERE household_id = ?', householdId);
      data.bank_accounts = query('SELECT id, connection_id, name, iban_last4, currency, visibility, import_from, balance, balance_kind, balance_at, created_at FROM bank_accounts WHERE household_id = ?', householdId);
      data.savings_destinations = query('SELECT id, name, goal_id, enabled, created_at FROM savings_destinations WHERE household_id = ?', householdId);
      data.savings_allocations = query('SELECT s.* FROM savings_allocations s JOIN transactions t ON t.id = s.transaction_id WHERE t.household_id = ?', householdId);
      data.savings_balance_allocations = query('SELECT * FROM savings_balance_allocations WHERE household_id = ?', householdId);
      data.goal_plans = query('SELECT p.* FROM goal_plans p JOIN goals g ON g.id = p.goal_id WHERE g.household_id = ?', householdId);
      data.savings_settings = query('SELECT * FROM savings_settings WHERE household_id = ?', householdId);
      data.bank_movements = query("SELECT m.id, m.account_id, m.kind, m.amount, m.date, m.description, m.status, m.transaction_id, m.created_at FROM bank_movements m JOIN bank_accounts a ON a.id = m.account_id WHERE m.household_id = ? AND a.visibility = 'shared'", householdId);
    }
    data.meal_shopping = query('SELECT s.* FROM meal_shopping s JOIN meals m ON m.id = s.meal_id WHERE m.household_id = ?', householdId);
    const attachments = query('SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.household_id = ?', householdId);
    data.attachments = attachments.map(({ storage_name, ...attachment }) => {
      assertStorageName(storage_name);
      const source = path.join(dataDir, 'uploads', storage_name); fileInfo(source);
      const target = path.join(temporary, storage_name); copyFileSync(source, target); chmodSync(target, 0o600);
      return { ...attachment, file: `allegati/${attachment.id}`, ...fileInfo(target) };
    });
    const payload = { format: 'casa-family/v1', createdAt: new Date().toISOString(),
      household: db.prepare('SELECT id, name FROM households WHERE id = ?').get(householdId),
      members: query('SELECT id, name, role FROM users WHERE household_id = ?', householdId), data };
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const onError = error => { cleanup(); if (response.headersSent) response.destroy(error); else next(error); };
    archive.on('error', onError); archive.on('warning', onError);
    response.on('finish', cleanup);
    response.on('close', () => { archive.abort(); cleanup(); });
    response.attachment(`casa-famiglia-${new Date().toISOString().slice(0, 10)}.zip`).type('application/zip');
    archive.pipe(response);
    archive.append(JSON.stringify(payload, null, 2), { name: 'casa.json' });
    for (const attachment of attachments) archive.file(path.join(temporary, attachment.storage_name), { name: `allegati/${attachment.id}` });
    archive.finalize().catch(onError);
  } catch (error) { cleanup(); next(error); }
}
