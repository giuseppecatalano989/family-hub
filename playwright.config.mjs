import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-browser-'));
process.env.CASA_E2E_DATA_DIR = dataDir;
// Throwaway key pair for the local Enable Banking double.
const bankKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key, type) => key.export({ type, format: 'pem' }).toString().replaceAll('\n', '\\n');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  globalTeardown: './tests/e2e/cleanup.mjs',
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath } },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: [{
    command: 'node tests/e2e/bank-mock.mjs',
    env: { MOCK_BANK_PORT: '3101', MOCK_BANK_PUBLIC_KEY: pem(bankKeys.publicKey, 'spki') },
    url: 'http://127.0.0.1:3101/health',
    reuseExistingServer: false,
    timeout: 20000,
  }, {
    command: 'node server/index.mjs',
    env: { NODE_ENV: 'production', PORT: '3100', DATA_DIR: dataDir, ENABLE_BANKING_APP_ID: 'e2e-app', ENABLE_BANKING_PRIVATE_KEY: pem(bankKeys.privateKey, 'pkcs8'), ENABLE_BANKING_API_URL: 'http://127.0.0.1:3101', ENABLE_BANKING_REDIRECT_URL: 'http://127.0.0.1:3100/api/bank/callback', ANTHROPIC_API_KEY: 'e2e-anthropic-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3101' },
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 20000,
  }],
});
