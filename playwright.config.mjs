import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'casa-browser-'));
process.env.CASA_E2E_DATA_DIR = dataDir;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  globalTeardown: './tests/e2e/cleanup.mjs',
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath } },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: {
    command: 'node server/index.mjs',
    env: { NODE_ENV: 'production', PORT: '3100', DATA_DIR: dataDir },
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
