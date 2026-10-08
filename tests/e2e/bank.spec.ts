import { test, expect, type Page } from '@playwright/test';
async function go(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: 'Apri menu' }).isVisible()) await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
test('a member links a bank in read-only mode, sees the family balance and imported expenses', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe'); await page.getByLabel('Email', { exact: true }).fill(`bank-${info.project.name}-${Date.now()}@example.test`); await page.getByLabel('Password', { exact: true }).fill('test-password-123'); await page.getByLabel('Nome del vostro spazio').fill('Famiglia banca'); await page.getByRole('button', { name: 'Entra a casa' }).click();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Conti bancari', exact: true })).toHaveCount(0);
  await go(page, 'Impostazioni'); await expect(page.getByRole('heading', { name: 'Impostazioni.' })).toBeVisible(); await expect(page.getByRole('tab', { name: /^Conti bancari/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Nessun conto collegato' })).toBeVisible();
  await expect(page.getByLabel('Mese selezionato')).toHaveCount(0);
  await page.getByRole('button', { name: 'Collega una banca' }).first().click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Cerca la tua banca').fill('intesa');
  await dialog.getByRole('listbox', { name: 'Banca' }).selectOption('Intesa Sanpaolo');
  await expect(dialog.getByRole('radio', { name: /Saldo e movimenti/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Continua sul sito della banca' }).click();
  await expect(page.getByRole('alert')).toContainText('Conto collegato');
  await expect(page).toHaveURL(/\/#bank$/);
  const group = page.locator('.bank-group'); await expect(group).toContainText('Intesa Sanpaolo'); await expect(group).toContainText('Consenso valido fino al');
  const card = page.locator('.bank-card', { hasText: 'Conto Famiglia' }); await expect(card).toContainText('•••• 3456');
  // Cards are never linked; removing one of two current accounts keeps the bank and hides it.
  await expect(page.locator('.bank-card')).toHaveCount(2); await expect(group).not.toContainText('Carta di credito');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Rimuovi Conto secondario' }).click();
  await expect(page.locator('.bank-card')).toHaveCount(1); await expect(group).not.toContainText('Conto secondario'); await expect(page.getByRole('button', { name: 'Ripristina' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rimuovi Conto Famiglia' })).toHaveCount(0);
  // Linking only: no balances, refresh or movements in this section.
  await expect(group).not.toContainText('2.345,67'); await expect(page.locator('.transactions-panel')).toHaveCount(0); await expect(page.getByRole('button', { name: /^Aggiorna/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('conti-bancari.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // No separate movements section: imported expenses without a category are classified in Uscite.
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Movimenti', exact: true })).toHaveCount(0);
  await go(page, 'Uscite'); await page.getByLabel('Filtra per categoria').selectOption({ label: 'Da classificare' });
  const ledger = page.locator('.transactions-panel').last(); await expect(ledger.locator('.transaction-row')).toHaveCount(1); await expect(ledger).toContainText('Negozio Vario');
  await page.getByRole('button', { name: 'Modifica Negozio Vario' }).click(); await page.getByRole('dialog').getByLabel('Categoria').selectOption({ label: 'Casa e utenze' });
  await page.getByRole('dialog').getByRole('button', { name: 'Salva modifiche' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(ledger.locator('.transaction-row')).toHaveCount(0); await page.getByLabel('Filtra per categoria').selectOption('all');
  await go(page, 'Uscite'); const row = page.locator('.transaction-row', { hasText: 'Esselunga' }); await expect(row).toContainText('Alimentari'); await expect(row).toContainText('Banca: Conto Famiglia');
  await expect(page.locator('.transaction-row', { hasText: 'Trade Republic' })).toContainText('Risparmio');
  await go(page, 'Entrate'); await expect(page.locator('.transaction-row', { hasText: 'Stipendio Rossi' })).toContainText('1.800,00');
  await go(page, 'Obiettivi'); await page.getByRole('button', { name: 'Nuovo obiettivo' }).click();
  const goalDialog = page.getByRole('dialog'); await goalDialog.getByLabel('Nome dell’obiettivo').fill('Fondo emergenze'); await goalDialog.getByLabel('Importo da raggiungere (€)').fill('5000');
  await goalDialog.getByLabel(/Accantonamento mensile/).fill('300'); await goalDialog.getByLabel(/Obiettivo primario/).check(); await goalDialog.getByRole('button', { name: 'Crea obiettivo' }).click();
  const goalCard = page.locator('.goal-card', { hasText: 'Fondo emergenze' }); await expect(goalCard).toContainText('300,00 € al mese'); await expect(goalCard).toContainText('Primario');
  // Only the monthly balance; the real balance is an optional line set in the account.
  await go(page, 'Panoramica'); const balance = page.locator('.balance-card'); await expect(balance).not.toContainText('Oggi sui conti'); await expect(page.getByText('Saldo dei conti collegati')).toHaveCount(0);
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Panoramica/ }).click(); await expect(page).toHaveURL(/#settings\/panoramica$/);
  await page.getByLabel(/Mostra in Panoramica, sotto il saldo del mese/).check(); await expect(page.getByText('Modifiche salvate.')).toBeVisible();
  // Cards can be hidden and reordered; the choice is kept by the server.
  await page.getByLabel('Risparmi per gli obiettivi', { exact: true }).uncheck(); await page.getByRole('button', { name: 'Sposta su Gli ultimi movimenti' }).click();
  await expect(page.locator('.dashboard-card-list').last().locator('li').nth(2)).toContainText('Gli ultimi movimenti');
  await page.screenshot({ path: info.outputPath('impostazioni-panoramica.png'), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.getByLabel('Risparmi per gli obiettivi', { exact: true })).not.toBeChecked();
  await go(page, 'Panoramica'); await expect(page.locator('.stat-card')).toHaveCount(3); await expect(page.locator('.overview-bottom .panel').first()).toContainText('Gli ultimi movimenti');
  await page.screenshot({ path: info.outputPath('panoramica-personalizzata.png'), fullPage: true });
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Panoramica/ }).click(); await page.getByRole('button', { name: 'Ripristina predefinita' }).click();
  await expect(page.getByLabel('Risparmi per gli obiettivi', { exact: true })).toBeChecked(); await expect(page.getByLabel(/Mostra in Panoramica, sotto il saldo del mese/)).toBeChecked();
  await page.getByRole('tab', { name: /^Conti bancari/ }).click(); await page.getByLabel('Se il risparmio del mese non copre tutte le quote').selectOption('primary'); await expect(page.getByLabel('Se il risparmio del mese non copre tutte le quote')).toHaveValue('primary');
  await page.screenshot({ path: info.outputPath('impostazioni.png'), fullPage: true });
  await go(page, 'Panoramica'); await expect(balance).toContainText('Oggi sui conti: 2.345,67');
  // Savings accounts are marked by their owner; their balance moves to the savings card.
  await go(page, 'Impostazioni'); const savingsBox = card.getByLabel('Conto risparmio o investimento'); await expect(savingsBox).not.toBeChecked();
  page.once('dialog', d => d.accept()); await savingsBox.click(); await expect(savingsBox).toBeChecked(); await expect(card.locator('.badge', { hasText: 'Risparmio' })).toBeVisible();
  await go(page, 'Panoramica'); await expect(page.locator('.stat-card', { hasText: 'Risparmi per gli obiettivi' })).toContainText('Sui conti risparmio: 2.345,67'); await expect(balance).not.toContainText('Oggi sui conti');
  await page.screenshot({ path: info.outputPath('panoramica-risparmi.png') });
  await go(page, 'Impostazioni'); page.once('dialog', d => d.accept()); await card.getByLabel('Conto risparmio o investimento').click(); await expect(card.locator('.badge', { hasText: 'Risparmio' })).toHaveCount(0);
  await card.getByLabel('Con la famiglia condividi').selectOption('balance'); await expect(card.locator('.badge')).toHaveText('Movimenti privati'); await go(page, 'Uscite'); await expect(page.locator('.transaction-row', { hasText: 'Esselunga' })).toContainText('Privato'); await go(page, 'Impostazioni');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Scollega banca' }).click();
  await expect(page.getByRole('heading', { name: 'Nessun conto collegato' })).toBeVisible();
  await go(page, 'Uscite'); await expect(page.locator('.transaction-row', { hasText: 'Esselunga' })).toBeVisible();
  expect(errors).toEqual([]);
});
