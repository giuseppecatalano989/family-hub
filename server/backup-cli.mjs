import path from 'node:path';
import { verifyInstanceBackup, restoreInstanceBackup } from './backups.mjs';

const [action, source, destination] = process.argv.slice(2);
try {
  if (action === 'verify' && source && !destination) {
    const result = verifyInstanceBackup(path.resolve(source));
    console.log(`Backup verificato: database integro e ${result.files.length} allegati validi.`);
  } else if (action === 'restore' && source && destination) {
    const result = restoreInstanceBackup(path.resolve(source), path.resolve(destination));
    console.log(`Ripristino verificato in una nuova directory: ${result.files.length} allegati. Avvia il server con DATA_DIR impostato alla destinazione.`);
  } else throw new Error('Uso: npm run backup:verify -- <directory-backup> oppure npm run backup:restore -- <directory-backup> <nuova-directory-dati>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
