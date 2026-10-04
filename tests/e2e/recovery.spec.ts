import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.mjs';

test('email recovery opens a clean link, resets the password and invalidates previous access', async ({ page, browser }, info) => {
  const root = mkdtempSync(path.join(tmpdir(), 'family-hub-recovery-browser-'));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const messages: { token: string; url: string }[] = [];
  const app = createApp({ dataDir: root, production: true, distDir: path.resolve('dist'), appUrl: origin, resetMailer: async (message: { token: string; url: string }) => messages.push(message) });
  server.on('request', app.app);
  const context = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    await page.goto(origin);
    await page.getByLabel('Il tuo nome').fill('Anna');
    await page.getByLabel('Email', { exact: true }).fill('anna@example.test');
    await page.getByLabel('Password', { exact: true }).fill('old-password-123');
    await page.getByLabel('Nome del vostro spazio').fill('Casa Anna');
    await page.getByRole('button', { name: 'Entra a casa' }).click();
    await expect(page.locator('.family-switch')).toContainText('Casa Anna');
    const recovery = await context.newPage();
    await recovery.goto(origin);
    await recovery.getByRole('button', { name: 'Accedi', exact: true }).click();
    await recovery.getByRole('button', { name: 'Password dimenticata?' }).click();
    await expect(recovery.getByLabel('Password', { exact: true })).toHaveCount(0);
    await recovery.getByLabel('Email', { exact: true }).fill('anna@example.test');
    await recovery.getByRole('button', { name: 'Invia link di recupero' }).click();
    await expect(recovery.getByRole('status')).toContainText('Se l’indirizzo è registrato');
    expect(messages.length).toBe(1);
    await recovery.goto(messages[0].url);
    await expect(recovery.getByRole('heading', { name: 'Una nuova password.' })).toBeVisible();
    expect(recovery.url()).not.toContain('reset=');
    await recovery.getByLabel('Nuova password', { exact: true }).fill('new-password-456');
    await recovery.getByLabel('Conferma nuova password').fill('different-password');
    await recovery.getByRole('button', { name: 'Reimposta password' }).click();
    await expect(recovery.getByRole('alert')).toContainText('non coincidono');
    await recovery.getByLabel('Conferma nuova password').fill('new-password-456');
    await recovery.screenshot({ path: info.outputPath('nuova-password.png'), fullPage: true });
    await recovery.getByRole('button', { name: 'Reimposta password' }).click();
    await expect(recovery.getByRole('status')).toContainText('Password aggiornata');
    await page.reload();
    await expect(page.getByLabel('Il tuo nome')).toBeVisible();
    await recovery.getByLabel('Email', { exact: true }).fill('anna@example.test');
    await recovery.getByLabel('Password', { exact: true }).fill('old-password-123');
    await recovery.getByRole('button', { name: 'Accedi', exact: true }).last().click();
    await expect(recovery.getByRole('alert')).toContainText('Email o password non corretti');
    await recovery.getByLabel('Password', { exact: true }).fill('new-password-456');
    await recovery.getByRole('button', { name: 'Accedi', exact: true }).last().click();
    await expect(recovery.locator('.family-switch')).toContainText('Casa Anna');
    // An already signed-in browser must also render recovery instead of ignoring the link.
    await recovery.goto(messages[0].url);
    await expect(recovery.getByRole('heading', { name: 'Una nuova password.' })).toBeVisible();
    await recovery.getByLabel('Nuova password', { exact: true }).fill('other-password-789');
    await recovery.getByLabel('Conferma nuova password').fill('other-password-789');
    await recovery.getByRole('button', { name: 'Reimposta password' }).click();
    await expect(recovery.getByRole('alert')).toContainText('non valido o scaduto');
    expect(await recovery.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close(); rmSync(root, { recursive: true, force: true });
  }
});
