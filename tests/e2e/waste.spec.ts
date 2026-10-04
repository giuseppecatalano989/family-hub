import { test, expect, type Page } from '@playwright/test';
async function go(page: Page) {
  await page.getByRole('navigation').waitFor({state:'attached'});
  if(await page.getByRole('button',{name:'Apri menu'}).isVisible())await page.getByRole('button',{name:'Apri menu'}).click();
  await page.getByRole('navigation').getByRole('button',{name:'Conferimento rifiuti',exact:true}).click();
}
test('a family configures waste days, hours and instructions on desktop and mobile',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await page.getByLabel('Il tuo nome').fill('Giuseppe');await page.getByLabel('Email',{exact:true}).fill(`waste-${info.project.name}-${Date.now()}@example.test`);await page.getByLabel('Password',{exact:true}).fill('test-password-123');await page.getByLabel('Nome del vostro spazio').fill('Famiglia rifiuti');await page.getByRole('button',{name:'Entra a casa'}).click();
  await go(page);await expect(page.getByRole('heading',{name:'Ogni rifiuto, nel giorno giusto.'})).toBeVisible();
  await page.getByRole('button',{name:'Organico',exact:true}).click();let dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Tipologia di rifiuto')).toHaveValue('Organico');await expect(dialog.getByRole('button',{name:'Aggiungi conferimento'})).toBeDisabled();
  for(const day of ['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato','Domenica'])await dialog.getByRole('checkbox',{name:day,exact:true}).check();
  await dialog.getByLabel('Orario o fascia di conferimento').fill('20:00–22:00');await dialog.getByLabel('Indicazioni').fill('Sacchetti compostabili');await dialog.getByRole('button',{name:'Aggiungi conferimento'}).click();
  await expect(page.getByRole('region',{name:'Conferimenti oggi'})).toContainText('Organico');await expect(page.getByRole('region',{name:'Conferimenti domani'})).toContainText('Sacchetti compostabili');await expect(page.locator('.waste-day-item')).toHaveCount(7);
  await page.getByRole('button',{name:'Modifica conferimento Organico'}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Tipologia di rifiuto').fill('Carta e cartone');
  for(const day of ['Lunedì','Martedì','Giovedì','Venerdì','Sabato','Domenica'])await dialog.getByRole('checkbox',{name:day,exact:true}).uncheck();
  await dialog.getByLabel('Indicazioni').fill('Piegare i cartoni');await dialog.getByRole('button',{name:'Salva conferimento'}).click();await expect(page.locator('.waste-type')).toContainText('Mercoledì');await expect(page.locator('.waste-day-item')).toHaveCount(1);
  await page.reload();await expect(page.locator('.waste-type')).toContainText('Piegare i cartoni');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('calendario-rifiuti.png'),fullPage:true});
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Elimina conferimento Carta e cartone'}).click();await expect(page.locator('.waste-type')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Prepariamo il calendario di casa'})).toBeVisible();expect(errors).toEqual([]);
});
