import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openPostgres } from './postgres.mjs';
import { TABLES } from './schema.mjs';
import { verifyInstanceBackup } from './backups.mjs';

export async function restoreCloudBackup(source, connectionString, options = {}) {
  const manifest = verifyInstanceBackup(source);
  const db = await openPostgres(connectionString, { ...options, requireEmptySchema: true });
  const copy = new DatabaseSync(path.join(source, 'casa.sqlite'), { readOnly: true });
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    await db.atomic(async () => {
      for (const table of TABLES) {
        const rows = copy.prepare(`SELECT * FROM ${table}`).all();
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const insert = db.prepare(`INSERT INTO ${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) await insert.run(...columns.map(c => row[c]));
      }
      for (const file of manifest.files) {
        const bytes = readFileSync(path.join(source, 'uploads', file.name));
        if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('Un allegato del backup è cambiato durante il ripristino.');
        await db.files.put(file.name, bytes);
      }
      if (digest(readFileSync(path.join(source, 'casa.sqlite'))) !== manifest.database.sha256) throw new Error('Il database del backup è cambiato durante il ripristino.');
    });
    return manifest;
  } finally { copy.close(); await db.close(); }
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'restore') {
    if (!first || !process.env.RESTORE_DATABASE_URL) throw new Error('Uso: cloud:backup -- restore <directory-verificata>; configura RESTORE_DATABASE_URL con un nuovo database senza schema casa.');
    const manifest = await restoreCloudBackup(first, process.env.RESTORE_DATABASE_URL);
    console.log(`Ripristino riuscito: ${manifest.createdAt}, ${manifest.files.length} allegati. Configura il nuovo DATABASE_URL nell’hosting e ridistribuisci l’app.`);
    return;
  }
  if (!['list', 'download'].includes(command) || !process.env.DATABASE_URL) throw new Error('Uso: cloud:backup -- list | download <id> <nuovo-file.zip>. Configura DATABASE_URL in un ambiente riservato.');
  const db = await openPostgres(process.env.DATABASE_URL);
  try {
    if (command === 'list') {
      const rows = await db.prepare('SELECT id, created_at, octet_length(data) AS bytes FROM backup_archives ORDER BY created_at DESC').all();
      for (const row of rows) console.log(`${row.id}  ${row.created_at}  ${row.bytes} byte`);
      if (!rows.length) console.log('Nessun backup automatico disponibile.');
    } else {
      if (!first || !second) throw new Error('Indica l’id del backup e un nuovo percorso ZIP.');
      const backup = await db.prepare('SELECT data FROM backup_archives WHERE id = ?').get(first);
      if (!backup) throw new Error('Backup non trovato.');
      writeFileSync(second, backup.data, { flag: 'wx', mode: 0o600 });
      console.log('Backup riservato salvato. Estrailo in una nuova directory e verifica l’integrità prima del ripristino.');
    }
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Operazione non riuscita. Controlla comando, configurazione riservata, integrità del backup e che la destinazione sia nuova.');
  process.exitCode = 1;
});
