import { rmSync } from 'node:fs';
export default function cleanup() {
  if (process.env.CASA_E2E_DATA_DIR) {
    rmSync(process.env.CASA_E2E_DATA_DIR, { recursive: true, force: true });
    rmSync(process.env.CASA_E2E_DATA_DIR + '-backups', { recursive: true, force: true });
  }
}
