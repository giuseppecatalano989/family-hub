import { test, expect, type Page } from '@playwright/test';
async function go(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: 'Apri menu' }).isVisible()) await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
test('a member links a bank in read-only mode, sees the family balance and imported expenses', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe'); await page.getByLabel('Email', { exact: true }).fill(`bank-${info.project.name}-${Date.now()}@example.test`); await page.getByLabel('Password', { exact: true }).fill('test-password-123'); await page.getByLabel('Nome del vostro spazio').fill('Famiglia banca'); await page.getByRole('button', { name: 'Entra a casa' }).click();
  await go(page, 'Conti bancari'); await expect(page.getByRole('heading', { name: 'I conti di famiglia.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nessun conto collegato' })).toBeVisible();
  await page.getByRole('button', { name: 'Collega una banca' }).first().click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Cerca la tua banca').fill('intesa');
  await dialog.getByRole('listbox', { name: 'Banca' }).selectOption('Intesa Sanpaolo');
  await expect(dialog.getByRole('radio', { name: /Saldo e movimenti/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Continua sul sito della banca' }).click();
  await expect(page.getByRole('alert')).toContainText('Conto collegato');
  await expect(page).toHaveURL(/\/#bank$/);
  const card = page.locator('.bank-card'); await expect(card).toContainText('Conto Famiglia'); await expect(card).toContainText('2.345,67'); await expect(card).toContainText('•••• 3456'); await expect(card).toContainText('Saldo disponibile');
  await expect(page.locator('.transactions-panel')).toContainText('Esselunga'); await expect(page.locator('.transactions-panel')).toContainText('Aggiunto alle registrazioni');
  await expect(page.locator('.bank-savings')).toContainText('Trade Republic Bank GmbH');
  await page.screenshot({ path: info.outputPath('conti-bancari.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await go(page, 'Uscite'); const row = page.locator('.transaction-row', { hasText: 'Esselunga' }); await expect(row).toContainText('Alimentari'); await expect(row).toContainText('Banca: Conto Famiglia');
  await expect(page.locator('.transaction-row', { hasText: 'Trade Republic' })).toContainText('Risparmio');
  await go(page, 'Entrate'); await expect(page.locator('.transaction-row', { hasText: 'Stipendio Rossi' })).toContainText('1.800,00');
  await go(page, 'Panoramica'); await expect(page.getByRole('button', { name: 'Saldo dei conti collegati: vai ai conti bancari' })).toContainText('2.345,67');
  await page.getByRole('button', { name: 'Saldo dei conti collegati: vai ai conti bancari' }).click();
  await page.getByLabel('Con la famiglia condividi').selectOption('balance'); await expect(card.locator('.badge')).toHaveText('Movimenti privati'); await go(page, 'Uscite'); await expect(page.locator('.transaction-row', { hasText: 'Esselunga' })).toContainText('Privato'); await go(page, 'Conti bancari');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Scollega Intesa Sanpaolo' }).click();
  await expect(page.getByRole('heading', { name: 'Nessun conto collegato' })).toBeVisible();
  await go(page, 'Uscite'); await expect(page.locator('.transaction-row', { hasText: 'Esselunga' })).toBeVisible();
  expect(errors).toEqual([]);
});
