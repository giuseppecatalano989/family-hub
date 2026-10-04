import { parseArgs } from 'node:util';
import { openPostgres } from './postgres.mjs';
import { createCloudBackups } from './cloud-backups.mjs';
import { removeMember } from './member-removal.mjs';

let db;
try {
  const { values } = parseArgs({ options: { 'request-id': { type: 'string' }, member: { type: 'string' }, admin: { type: 'string' } } });
  if (!process.env.DATABASE_URL) throw new Error('Configurazione database assente.');
  db = await openPostgres(process.env.DATABASE_URL);
  const backups = createCloudBackups(db);
  const result = await removeMember({ db, requestId: values['request-id'], memberName: values.member, adminName: values.admin, takeBackup: () => backups.take() });
  console.log('MEMBER_REMOVAL_RESULT ' + JSON.stringify(result));
} catch (error) {
  // Database errors may contain account data. Log only our operator messages.
  const safe = ['Configurazione database assente.', 'Configurazione della rimozione non valida.', 'Account da rimuovere non identificato in modo univoco nella famiglia indicata. Nessun account eliminato.', 'Copia privata non confermata. Nessun account eliminato.', 'Rimozione non confermata.'];
  console.error(safe.includes(error.message) ? error.message : 'Rimozione account non riuscita. Nessun risultato confermato.');
  process.exitCode = 1;
} finally { await db?.close(); }
