import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: 'Apri menu' }).isVisible()) await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}

test('notifications are turned on per device and chosen per account', async ({ page, context }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  // The browser's push service is replaced by a local double: no message leaves the test.
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    const fake = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device', options: { applicationServerKey: null }, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; }, async unsubscribe() { sessionStorage.removeItem('e2e-push'); return true; } });
    if ('PushManager' in window) {
      PushManager.prototype.subscribe = async function () { sessionStorage.setItem('e2e-push', '1'); return fake() as unknown as PushSubscription; };
      PushManager.prototype.getSubscription = async function () { return sessionStorage.getItem('e2e-push') ? fake() as unknown as PushSubscription : null; };
    }
  });
  await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe'); await page.getByLabel('Email', { exact: true }).fill(`push-${info.project.name}-${Date.now()}@example.test`); await page.getByLabel('Password', { exact: true }).fill('test-password-123'); await page.getByLabel('Nome del vostro spazio').fill('Famiglia notifiche'); await page.getByRole('button', { name: 'Entra a casa' }).click();
  await go(page, 'Impostazioni'); await page.getByRole('tab', { name: /^Notifiche/ }).click(); await expect(page).toHaveURL(/#settings\/notifiche$/);
  if (info.project.name === 'mobile') {
    // On iPhone the app must be added to the Home screen first.
    await expect(page.getByText('Su iPhone e iPad le notifiche arrivano solo dall’app sulla schermata Home.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attiva su questo dispositivo' })).toHaveCount(0);
  } else {
    await expect(page.getByText('Non attive su questo dispositivo.')).toBeVisible();
    await page.getByRole('button', { name: 'Attiva su questo dispositivo' }).click();
    await expect(page.getByText('Notifiche attive su questo dispositivo.')).toBeVisible();
    await expect(page.getByText('Un dispositivo attivo per il tuo account.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invia una notifica di prova' })).toBeVisible();
  }
  const shopping = page.getByRole('checkbox', { name: /Lista della spesa/ });
  await expect(shopping).toBeChecked(); await shopping.uncheck(); await expect(page.getByText('Modifiche salvate.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('impostazioni-notifiche.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.getByRole('checkbox', { name: /Lista della spesa/ })).not.toBeChecked();
  if (info.project.name !== 'mobile') await expect(page.getByText('Attive su questo dispositivo.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Lavagna di famiglia/ })).toBeChecked();
  if (info.project.name !== 'mobile') {
    await page.getByRole('button', { name: 'Disattiva su questo dispositivo' }).click();
    await expect(page.getByText('Notifiche disattivate su questo dispositivo.')).toBeVisible();
    await expect(page.getByText('Nessun dispositivo attivo per il tuo account.', { exact: false })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
