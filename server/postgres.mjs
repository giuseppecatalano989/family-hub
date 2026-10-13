import { Pool, types } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RECOVERY_SCHEMA } from './recovery.mjs';
import { BASE_SCHEMA, WORKFLOW_SCHEMA, UPLOAD_SCHEMA, PLANNING_SCHEMA, WASTE_SCHEMA, CALENDAR_SCHEMA, DEADLINE_SCHEMA, BANK_SCHEMA, NOTIFICATION_SCHEMA, ADVISOR_SCHEMA, PANTRY_SCHEMA } from './schema.mjs';

// Epoch milliseconds and COUNT(*) fit safely in the application's integer range.
types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Valore numerico fuori intervallo.');
  return number;
});
const LOCK = 180620261;
const placeholders = sql => { let index = 0; return sql.replaceAll('?', () => `$${++index}`); };

export async function openPostgres(connectionString, { local = false, requireEmptySchema = false } = {}) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL deve essere un URL PostgreSQL.');
  if (local && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('La modalità senza TLS è consentita solo per test su loopback.');
  // Explicit verification must not be overridden by URL sslmode options.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 10000, allowExitOnIdle: true, ssl: local ? false : { rejectUnauthorized: true } });
  const context = new AsyncLocalStorage();
  // One round trip opens the transaction: every query costs a trip to the database.
  const BEGIN = 'BEGIN; SET LOCAL search_path TO casa, public';
  const LOCKED = `BEGIN; SELECT pg_advisory_xact_lock(${LOCK}); SET LOCAL search_path TO casa, public`;
  const reads = sql => /^\s*SELECT\b/i.test(sql) && !/;\s*\S/.test(sql);
  async function transaction(locked, callback) {
    const client = await pool.connect();
    const store = { client, locked };
    try {
      await client.query(locked ? LOCKED : BEGIN);
      const result = await context.run(store, callback);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw Object.assign(new Error('Questo elemento esiste già. Aggiorna la pagina.'), { status: 409 });
      throw error;
    } finally { client.release(); }
  }
  // Serializes compound writes and snapshots across serverless instances. A read
  // that turns into a write takes the lock before its first change.
  async function lock(store) {
    if (store.locked) return;
    await store.client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    store.locked = true;
  }
  async function atomic(callback) {
    const store = context.getStore();
    if (!store) return transaction(true, callback);
    await lock(store);
    return callback();
  }
  // Many reads on one connection, without waiting for the shared lock.
  async function read(callback) {
    if (context.getStore()) return callback();
    return transaction(false, callback);
  }
  async function query(sql, args = []) {
    const store = context.getStore();
    if (!store) return reads(sql) ? read(() => query(sql, args)) : atomic(() => query(sql, args));
    if (!reads(sql)) await lock(store);
    return store.client.query(placeholders(sql), args);
  }
  const db = {
    cloud: true, atomic, read, query,
    prepare(sql) { return {
      async run(...args) { const result = await query(sql, args); return { changes: result.rowCount }; },
      async get(...args) { return (await query(sql, args)).rows[0]; },
      async all(...args) { return (await query(sql, args)).rows; },
    }; },
    close() { return pool.end(); },
  };
  try {
    await atomic(async () => {
      if (requireEmptySchema && (await query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'casa') AS exists")).rows[0].exists) throw new Error('Il database di destinazione contiene già lo schema casa. Usa un nuovo database per preservare i dati esistenti.');
      await query('CREATE SCHEMA IF NOT EXISTS casa');
      await query(BASE_SCHEMA.replace(/\s*PRAGMA[^;]*;/g, '').replace('invite_expires INTEGER', 'invite_expires BIGINT').replace('expires INTEGER', 'expires BIGINT'));
      await query(RECOVERY_SCHEMA);
      await query(WORKFLOW_SCHEMA);
      await query(PLANNING_SCHEMA);
      await query(WASTE_SCHEMA);
      await query(CALENDAR_SCHEMA);
      await query(DEADLINE_SCHEMA);
      const frequency = (await query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'deadlines_frequency_check' AND conrelid = 'deadlines'::regclass")).rows[0];
      if (!frequency?.def.includes('quarterly')) await query(`ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS deadlines_frequency_check;
        ALTER TABLE deadlines ADD CONSTRAINT deadlines_frequency_check CHECK(frequency IN ('once','monthly','quarterly','semiannual','yearly'))`);
      await query(BANK_SCHEMA);
      await query(NOTIFICATION_SCHEMA);
      await query(ADVISOR_SCHEMA);
      await query(PANTRY_SCHEMA);
      await query(UPLOAD_SCHEMA.replaceAll(' BLOB ', ' BYTEA '));
      await query(`CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BYTEA NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS backup_archives (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data BYTEA NOT NULL);
        CREATE TABLE IF NOT EXISTS backup_state (id INTEGER PRIMARY KEY CHECK(id = 1), error TEXT);
        CREATE TABLE IF NOT EXISTS auth_attempts (address TEXT PRIMARY KEY, start BIGINT NOT NULL, count INTEGER NOT NULL);`);
    });
  } catch (error) { await pool.end(); throw error; }
  db.files = {
    async put(name, bytes) {
      await atomic(async () => {
        const { used } = (await query('SELECT COALESCE(SUM(octet_length(data)), 0)::bigint AS used FROM files')).rows[0];
        if (used + bytes.length > 40 * 1024 * 1024) throw Object.assign(new Error('Spazio allegati esaurito (40 MB totali). Scarica una copia e rimuovi i file che non servono.'), { status: 413 });
        await query('INSERT INTO files VALUES (?, ?, ?)', [name, bytes, new Date().toISOString()]);
      });
    },
    async get(name) {
      const file = (await query('SELECT data FROM files WHERE name = ?', [name])).rows[0];
      if (!file) throw Object.assign(new Error('File non trovato.'), { status: 404 });
      return file.data;
    },
    async remove(name) { await query('DELETE FROM files WHERE name = ?', [name]); },
  };
  db.checkAuthAttempt = async address => atomic(async () => {
    const stamp = Date.now();
    await query('DELETE FROM auth_attempts WHERE start <= ?', [stamp - 900000]);
    const result = await query('INSERT INTO auth_attempts VALUES (?, ?, 1) ON CONFLICT(address) DO UPDATE SET count = auth_attempts.count + 1 RETURNING count', [address, stamp]);
    return result.rows[0].count <= 30;
  });
  return db;
}
