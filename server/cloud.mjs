import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { waitUntil } from '@vercel/functions';
import { openPostgres } from './postgres.mjs';
import { createCloudBackups } from './cloud-backups.mjs';

export async function createCloudApp({ connectionString = process.env.DATABASE_URL, cronSecret = process.env.CRON_SECRET, local = false, resetMailer, appUrl, bankProvider, clock, pushSender, advisorModel } = {}) {
  if (!connectionString) throw new Error('Configura DATABASE_URL per il database persistente prima di pubblicare.');
  const database = await openPostgres(connectionString, { local });
  try {
    const cloudBackups = createCloudBackups(database, { scheduled: !!cronSecret });
    return createApp({
      database, cloudBackups, cronSecret, resetMailer, appUrl, bankProvider, clock, pushSender, ...(advisorModel !== undefined ? { advisorModel } : {}),
      scheduleResetDelivery: local ? undefined : promise => waitUntil(promise),
      scheduleBackground: local ? undefined : promise => waitUntil(promise),
      production: true, trustProxy: true,
      dataDir: path.join(os.tmpdir(), 'casa-cloud-runtime'),
      distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
    });
  } catch (error) { await database.close(); throw error; }
}
