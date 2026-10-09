import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: 'Apri menu' }).isVisible()) await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}

// Claude is replaced by the local API double: reports come back at once.
test('budget reports arrive by themselves, light up the report button and a suggested split applies to one month', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe'); await page.getByLabel('Email', { exact: true }).fill(`advisor-${info.project.name}-${Date.now()}@example.test`); await page.getByLabel('Password', { exact: true }).fill('test-password-123'); await page.getByLabel('Nome del vostro spazio').fill('Famiglia consigli'); await page.getByRole('button', { name: 'Entra a casa' }).click();
  // One expense this month and one last month: there is always a report to write.
  const now = new Date(); const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const [name, amount, date] of [['Cena fuori', '120', iso(now)], ['Cinema', '30', iso(lastMonth)]]) {
    await go(page, 'Uscite'); await page.getByRole('button', { name: 'Nuova uscita', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Nome', { exact: true }).fill(name); await dialog.getByLabel('Importo (€)').fill(amount); await dialog.getByLabel('Categoria').selectOption({ label: 'Tempo libero' }); await dialog.getByLabel('Data', { exact: true }).fill(date);
    await dialog.getByRole('button', { name: 'Aggiungi uscita' }).click(); await expect(dialog).toHaveCount(0);
  }

  await go(page, 'Panoramica'); await expect(page.getByRole('button', { name: /^Report del budget/ })).toHaveCount(0);
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Consigli IA/ }).click(); await expect(page).toHaveURL(/#settings\/consigli$/);
  await expect(page.getByText('IBAN, numeri lunghi, email, nomi dei familiari e dati di accesso non vengono inviati.', { exact: false })).toBeVisible();
  await page.getByRole('checkbox', { name: /Prepara ogni settimana/ }).check(); await expect(page.getByRole('checkbox', { name: /Prepara ogni settimana/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Suggerita/ })).toBeChecked();
  await page.getByRole('radio', { name: /^Automatica/ }).check(); await expect(page.getByRole('radio', { name: /^Automatica/ })).toBeChecked();
  await page.reload(); await expect(page.getByRole('radio', { name: /^Automatica/ })).toBeChecked();
  await page.screenshot({ path: info.outputPath('impostazioni-consigli.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Nothing to request: turning it on prepares the reports, and the button lights up.
  await go(page, 'Panoramica');
  const button = page.getByRole('button', { name: 'Report del budget: nuovo report da leggere' });
  await expect(async () => { await page.reload(); await expect(button).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 20000 });
  await expect(page.locator('.advice-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Preparalo ora|Aggiorna/ })).toHaveCount(0);
  const [pickerBox, buttonBox] = [await page.locator('.month-picker').boundingBox(), await button.boundingBox()];
  expect(Math.abs((pickerBox!.y + pickerBox!.height / 2) - (buttonBox!.y + buttonBox!.height / 2))).toBeLessThan(4);
  expect(buttonBox!.x).toBeGreaterThan(pickerBox!.x + pickerBox!.width);
  await page.screenshot({ path: info.outputPath('panoramica-icona-report.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await button.click();
  const reports = page.getByRole('dialog', { name: 'Report del budget' });
  await expect(reports.getByRole('heading', { name: 'Svago corre più veloce del previsto' }).first()).toBeVisible();
  await expect(reports.getByText('Rivedete le cene fuori').first()).toBeVisible();
  // A refresh of the state while reading keeps the dialog where it was.
  const modal = page.locator('.modal');
  await modal.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const scrolled = await modal.evaluate(el => el.scrollTop);
  const refreshed = page.waitForResponse(r => r.url().includes('/api/state'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed; await page.waitForTimeout(300);
  expect(await modal.evaluate(el => el.scrollTop)).toBe(scrolled);
  const month = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(now);
  await reports.getByRole('button', { name: `Applica solo a ${month}` }).first().click();
  await expect(reports.getByText(`Applicata a ${month}`).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('report-del-budget.png') });
  await reports.getByRole('button', { name: 'Chiudi finestra' }).click();
  // Read: the highlight goes away, also after reloading.
  await expect(page.getByRole('button', { name: 'Report del budget', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Report del budget', exact: true })).toBeVisible();

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

  // The overview card is optional and shows the same reports.
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Panoramica/ }).click();
  await page.getByRole('checkbox', { name: 'Report del budget (quando attivi)' }).check();
  await go(page, 'Panoramica');
  await expect(page.locator('.advice-panel').getByRole('heading', { name: 'Svago corre più veloce del previsto' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
