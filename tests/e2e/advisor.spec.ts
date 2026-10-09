import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: 'Apri menu' }).isVisible()) await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}

// Claude is replaced by the local API double: the report comes back at once.
test('budget reports are turned on in settings and a suggested split applies to one month', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe'); await page.getByLabel('Email', { exact: true }).fill(`advisor-${info.project.name}-${Date.now()}@example.test`); await page.getByLabel('Password', { exact: true }).fill('test-password-123'); await page.getByLabel('Nome del vostro spazio').fill('Famiglia consigli'); await page.getByRole('button', { name: 'Entra a casa' }).click();
  await go(page, 'Uscite'); await page.getByRole('button', { name: 'Nuova uscita', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome', { exact: true }).fill('Cena fuori'); await dialog.getByLabel('Importo (€)').fill('120'); await dialog.getByLabel('Categoria').selectOption({ label: 'Tempo libero' });
  await dialog.getByRole('button', { name: 'Aggiungi uscita' }).click(); await expect(dialog).toHaveCount(0);

  await go(page, 'Panoramica'); await expect(page.getByRole('heading', { name: 'Consigli del budget' })).toHaveCount(0);
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Consigli IA/ }).click(); await expect(page).toHaveURL(/#settings\/consigli$/);
  await expect(page.getByText('IBAN, numeri lunghi, email, nomi dei familiari e dati di accesso non vengono inviati.', { exact: false })).toBeVisible();
  await page.getByRole('checkbox', { name: /Prepara ogni settimana/ }).check(); await expect(page.getByRole('checkbox', { name: /Prepara ogni settimana/ })).toBeChecked();
  await page.screenshot({ path: info.outputPath('impostazioni-consigli.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await go(page, 'Panoramica');
  const card = page.locator('.advice-panel');
  await card.getByRole('button', { name: 'Preparalo ora' }).click();
  await page.reload();
  await expect(card.getByRole('heading', { name: 'Svago corre più veloce del previsto' })).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('Rivedete le cene fuori')).toBeVisible();
  const month = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date());
  await card.getByRole('button', { name: `Applica solo a ${month}` }).click();
  await expect(card.getByText(`Applicata a ${month}`)).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('panoramica-consigli.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The budget shows the temporary split; the next month returns to the usual one.
  await go(page, 'Ripartizione budget');
  await expect(page.getByText(`Per ${month} vale una ripartizione temporanea suggerita dal report.`, { exact: false })).toBeVisible();
  await expect(page.locator('.budget-category', { hasText: 'Tempo libero' }).locator('.percentage-badge')).toHaveText('5%');
  await page.getByRole('button', { name: 'Mese successivo' }).click();
  await expect(page.getByText('vale una ripartizione temporanea', { exact: false })).toHaveCount(0);
  await expect(page.locator('.budget-category', { hasText: 'Tempo libero' }).locator('.percentage-badge')).toHaveText('10%');
  await page.getByRole('button', { name: 'Mese precedente' }).click();
  await page.getByRole('button', { name: 'Torna alla abituale' }).click();
  await expect(page.locator('.budget-category', { hasText: 'Tempo libero' }).locator('.percentage-badge')).toHaveText('10%');
  expect(errors).toEqual([]);
});
