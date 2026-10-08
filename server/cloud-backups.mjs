import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import { BASE_SCHEMA, WORKFLOW_SCHEMA, TABLES, PLANNING_SCHEMA, WASTE_SCHEMA, DEADLINE_SCHEMA, BANK_SCHEMA } from './schema.mjs';
import { snapshotInstance, streamFamilyBackup } from './backups.mjs';

const conditions = {
  households: 'id = ?',
  sessions: 'user_id IN (SELECT id FROM users WHERE household_id = ?)',
  contributions: 'goal_id IN (SELECT id FROM goals WHERE household_id = ?)',
  attachments: 'note_id IN (SELECT id FROM notes WHERE household_id = ?)',
  deadline_receipts: 'deadline_id IN (SELECT id FROM deadlines WHERE household_id = ?)',
  bill_payments: 'bill_id IN (SELECT id FROM bills WHERE household_id = ?)',
  recurring_versions: 'rule_id IN (SELECT id FROM recurring_rules WHERE household_id = ?)',
  recurring_occurrences: 'rule_id IN (SELECT id FROM recurring_rules WHERE household_id = ?)',
  meal_shopping: 'meal_id IN (SELECT id FROM meals WHERE household_id = ?)',
  private_transactions: 'transaction_id IN (SELECT id FROM transactions WHERE household_id = ?)',
  salary_payers: 'rule_id IN (SELECT id FROM recurring_rules WHERE household_id = ?)',
  savings_contributions: 'transaction_id IN (SELECT id FROM transactions WHERE household_id = ?)',
  savings_allocations: 'transaction_id IN (SELECT id FROM transactions WHERE household_id = ?)',
  goal_plans: 'goal_id IN (SELECT id FROM goals WHERE household_id = ?)',
  user_preferences: 'user_id IN (SELECT id FROM users WHERE household_id = ?)',
};

// Every writer uses the same PostgreSQL advisory lock. Database rows and file
// bytes are read while that lock is held, then the portable SQLite copy is used.
async function portableCopy(db, householdId) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'casa-cloud-copy-'));
  const dataDir = path.join(root, 'data'); mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(path.join(dataDir, 'uploads'), { mode: 0o700 });
  const copy = new DatabaseSync(path.join(dataDir, 'casa.sqlite'));
  try {
    copy.exec(BASE_SCHEMA); copy.exec(WORKFLOW_SCHEMA); copy.exec(PLANNING_SCHEMA); copy.exec(WASTE_SCHEMA); copy.exec(DEADLINE_SCHEMA); copy.exec(BANK_SCHEMA);
    await db.atomic(async () => {
      copy.exec('BEGIN');
      for (const table of TABLES) {
        const sql = `SELECT * FROM ${table}` + (householdId ? ` WHERE ${conditions[table] || 'household_id = ?'}` : '');
        const rows = await db.prepare(sql).all(...(householdId ? [householdId] : []));
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const insert = copy.prepare(`INSERT INTO ${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) insert.run(...columns.map(c => row[c]));
      }
      copy.exec('COMMIT');
      for (const file of copy.prepare('SELECT storage_name FROM attachments').all()) {
        writeFileSync(path.join(dataDir, 'uploads', file.storage_name), await db.files.get(file.storage_name), { mode: 0o600 });
      }
    });
    return { root, dataDir, copy, close() { copy.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { copy.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

async function zipDirectory(directory) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('error', reject); archive.on('warning', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
  });
  archive.directory(directory, false);
  await archive.finalize();
  return finished;
}

export function createCloudBackups(db, { scheduled = false, clock = Date.now } = {}) {
  async function status() {
    const last = await db.prepare('SELECT created_at FROM backup_archives ORDER BY created_at DESC LIMIT 1').get();
    const state = await db.prepare('SELECT error FROM backup_state WHERE id = 1').get();
    const next = new Date(clock()); next.setUTCHours(0, 0, 0, 0); next.setUTCDate(next.getUTCDate() + 1);
    return { mode: 'cloud', enabled: scheduled, lastAt: last?.created_at || null, nextAt: scheduled ? next.toISOString() : null, retention: 7, error: state?.error || null };
  }
  async function take() {
    const temporary = await portableCopy(db);
    try {
      const destination = path.join(temporary.root, 'snapshot');
      const manifest = snapshotInstance(temporary.copy, temporary.dataDir, destination, new Date(clock()).toISOString());
      const bytes = await zipDirectory(destination);
      const id = randomUUID();
      await db.atomic(async () => {
        await db.prepare('INSERT INTO backup_archives VALUES (?, ?, ?)').run(id, manifest.createdAt, bytes);
        await db.prepare('DELETE FROM backup_archives WHERE id NOT IN (SELECT id FROM backup_archives ORDER BY created_at DESC LIMIT 7)').run();
        await db.prepare('INSERT INTO backup_state VALUES (1, NULL) ON CONFLICT(id) DO UPDATE SET error = NULL').run();
      });
      return { id, manifest };
    } finally { temporary.close(); }
  }
  return {
    status, take,
    async runIfDue() {
      try {
        await db.atomic(async () => {
          await db.prepare('DELETE FROM file_uploads WHERE expires <= ?').run(clock());
          await db.prepare('DELETE FROM files WHERE created_at < ? AND name NOT IN (SELECT storage_name FROM attachments)').run(new Date(clock() - 3600_000).toISOString());
          const latest = await db.prepare('SELECT created_at FROM backup_archives ORDER BY created_at DESC LIMIT 1').get();
          // Hobby cron can run at different minutes each day; calendar-day
          // comparison avoids skipping a day because fewer than 24 hours passed.
          if (latest?.created_at.slice(0, 10) === new Date(clock()).toISOString().slice(0, 10)) return;
          await take();
        });
      }
      catch {
        await db.prepare('INSERT INTO backup_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET error = EXCLUDED.error').run('Il backup automatico non è riuscito. Controlla la configurazione e lo spazio del database.');
      }
    },
    // Serverless jobs run via the protected Vercel cron endpoint, without timers.
    start() {}, stop() {},
    async exportFamily(householdId, response, next) {
      const temporary = await portableCopy(db, householdId);
      if (response.destroyed) { temporary.close(); return; }
      const cleanup = () => temporary.close();
      let cleaned = false;
      const once = () => { if (!cleaned) { cleaned = true; cleanup(); } };
      response.once('finish', once); response.once('close', once);
      streamFamilyBackup(temporary.copy, temporary.dataDir, householdId, response, error => { once(); next(error); });
    },
  };
}
