import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { openPostgres } from './postgres.mjs';
import { createCloudBackups } from './cloud-backups.mjs';

export async function createCloudApp({ connectionString = process.env.DATABASE_URL, cronSecret = process.env.CRON_SECRET, local = false } = {}) {
  if (!connectionString) throw new Error('Configura DATABASE_URL per il database persistente prima di pubblicare.');
  const database = await openPostgres(connectionString, { local });
  try {
    const cloudBackups = createCloudBackups(database, { scheduled: !!cronSecret });
    return createApp({
      database, cloudBackups, cronSecret,
      production: true, trustProxy: true,
      dataDir: path.join(os.tmpdir(), 'casa-cloud-runtime'),
      distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
    });
  } catch (error) { await database.close(); throw error; }
}
