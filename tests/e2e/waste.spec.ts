import { test, expect, type Page } from '@playwright/test';
async function goTo(page: Page, name: string) {
  await page.getByRole('navigation').waitFor({state:'attached'});
  if(await page.getByRole('button',{name:'Apri menu'}).isVisible())await page.getByRole('button',{name:'Apri menu'}).click();
  await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
}
const go = (page: Page) => goTo(page, 'Conferimento rifiuti');
test('a family configures waste days and plans shared calendar events on desktop and mobile',async({page},info)=>{
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
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Elimina conferimento Carta e cartone'}).click();await expect(page.locator('.waste-type')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Prepariamo il calendario di casa'})).toBeVisible();
  // The same family plans shared events in the calendar (one account keeps the suite under the sign-in limit).
  await goTo(page,'Calendario');await expect(page.getByRole('heading',{name:'Il calendario di famiglia.'})).toBeVisible();await expect(page.getByRole('heading',{name:'Il calendario di casa'})).toBeVisible();
  await page.context().grantPermissions(['geolocation']);await page.context().setGeolocation({latitude:45.4642,longitude:9.19});await page.getByRole('button',{name:'Nuovo evento'}).click();dialog=page.getByRole('dialog');
  await dialog.getByLabel('Titolo').fill('Pediatra');await expect(dialog.getByRole('radio',{name:'Famiglia'})).toBeChecked();await dialog.getByRole('radio',{name:'Personale'}).check();await dialog.getByRole('checkbox',{name:'Tutto il giorno'}).uncheck();await dialog.getByLabel('Ora di inizio').fill('17:30');await dialog.getByLabel('Ora di fine').fill('18:15');
  await dialog.getByLabel('Luogo').fill('Posto inesistente');await expect(dialog.getByRole('status')).toHaveText('Nessun luogo trovato: puoi scriverlo a mano.');await dialog.getByLabel('Luogo').fill('S');const places=dialog.getByRole('listbox',{name:'Luoghi suggeriti'});await expect(places.getByRole('option')).toHaveCount(2);await expect(places.getByRole('option').first()).toContainText('Via Roma 12, Milano');await expect(places.getByRole('option').nth(1)).toContainText(/\d+ km · Lazio, Italia/);await expect(dialog.getByText('Dati © OpenStreetMap')).toBeVisible();await expect(places).toBeInViewport();await page.screenshot({path:info.outputPath('calendario-luoghi.png')});await places.getByRole('option',{name:/Via Roma 12, Milano/}).click();await expect(dialog.getByLabel('Luogo')).toHaveValue('Studio Bianchi, Via Roma 12, Milano');await expect(places).toHaveCount(0);await dialog.getByLabel('Note').fill('Portare il libretto');await dialog.getByRole('button',{name:'Aggiungi evento'}).click();
  const agenda=page.getByRole('region',{name:'Programma del giorno'});
  await expect(agenda).toContainText('Pediatra');await expect(agenda).toContainText('17:30–18:15');await expect(agenda).toContainText('Studio Bianchi, Via Roma 12, Milano');await expect(agenda).toContainText('Aggiunto da Giuseppe');await expect(agenda).toContainText('Personale · Giuseppe');await expect(page.getByLabel('Colori del calendario')).toContainText('Giuseppe');
  await expect(page.getByRole('region',{name:'Prossimi eventi'})).toContainText('Pediatra');
  await page.getByRole('button',{name:'Aggiungi un evento in questo giorno'}).click();dialog=page.getByRole('dialog');
  await dialog.getByLabel('Titolo').fill('Calcetto');await dialog.getByLabel('Ripetizione').selectOption('weekly');await dialog.getByRole('button',{name:'Aggiungi evento'}).click();
  await expect(agenda).toContainText('Ogni settimana');await expect(agenda.locator('.calendar-event')).toHaveCount(2);
  await page.getByRole('button',{name:'Modifica evento Pediatra'}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Titolo').fill('Visita dal pediatra');await dialog.getByRole('button',{name:'Salva evento'}).click();
  await expect(agenda).toContainText('Visita dal pediatra');
  await page.reload();await expect(page.getByRole('region',{name:'Programma del giorno'})).toContainText('Visita dal pediatra');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('calendario.png'),fullPage:true});
  await page.getByRole('button',{name:'Elimina evento Calcetto'}).click();await page.getByRole('dialog').getByRole('button',{name:'Solo questo evento'}).click();await expect(page.getByRole('region',{name:'Programma del giorno'}).locator('.calendar-event')).toHaveCount(1);await expect(page.getByRole('region',{name:'Prossimi eventi'})).toContainText('Calcetto');
  await goTo(page,'Panoramica');await expect(page.getByRole('main').getByRole('button',{name:'Calendario',exact:true})).toContainText('Oggi: Visita dal pediatra');expect(errors).toEqual([]);
});
