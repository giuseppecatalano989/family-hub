import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const dataDir = path.resolve(env.DATA_DIR || '.data');
  const backupDir = path.resolve(env.BACKUP_DIR || `${dataDir}-backups`);
  const normalize = (value: string) => value.replaceAll('\\', '/');
  return {
  plugins: [react()],
  server: { port: 5173, strictPort: true,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/casa.sqlite*', `${normalize(dataDir)}/**`, `${normalize(backupDir)}/**`] },
    proxy: { '/api': `http://127.0.0.1:${env.PORT || '3000'}` },
  },
  };
});
