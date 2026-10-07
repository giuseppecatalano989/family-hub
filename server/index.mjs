import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const instance = createApp({
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, '.data')),
  production: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  distDir: path.join(root, 'dist'),
  automaticBackups: process.env.AUTO_BACKUPS !== '0',
  backupDir: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : undefined,
});
instance.backups.start();
if (instance.bank.configured) {
  const syncBanks = () => instance.bank.synchronizeAll().catch(error => console.error('Aggiornamento bancario non riuscito:', error.message));
  setTimeout(syncBanks, 60000).unref();
  setInterval(syncBanks, 3600000).unref();
}
const server = instance.app.listen(port, '0.0.0.0', () => console.log(`Casa: server in ascolto sulla porta ${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { instance.close(); process.exit(0); }));
