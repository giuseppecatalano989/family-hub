import { test, expect, type Page } from '@playwright/test';
async function go(page: Page, label: string) {
  await page.getByRole('navigation').waitFor({ state:'attached' });
  if(await page.getByRole('button',{name:'Apri menu'}).isVisible())await page.getByRole('button',{name:'Apri menu'}).click();
  await page.getByRole('navigation').getByRole('button',{name:label,exact:true}).click();
}
test('income sources, monthly costs and editable budget templates work on desktop and mobile', async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByLabel('Il tuo nome').fill('Sara');await page.getByLabel('Email',{exact:true}).fill(`planning-${info.project.name}-${Date.now()}@example.test`);await page.getByLabel('Password',{exact:true}).fill('test-password-123');await page.getByLabel('Nome del vostro spazio').fill('Famiglia pianificata');await page.getByRole('button',{name:'Entra a casa'}).click();
  await go(page,'Redditi familiari');await page.getByRole('button',{name:'Nuovo reddito',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.getByLabel('Nome',{exact:true}).fill('Stipendio Sara');await dialog.getByLabel('Importo mensile (€)').fill('2500,01');await dialog.getByRole('button',{name:'Crea reddito'}).click();
  await expect(page.locator('.recurring-card')).toContainText('2.500,01');
  await page.getByRole('button',{name:'Modifica ricorrenza Stipendio Sara'}).click();await page.getByLabel('Importo mensile (€)').fill('2600,01');await page.getByRole('button',{name:'Salva ricorrenza'}).click();await expect(page.locator('.mini-stats')).toContainText('2.600,01');
  await go(page,'Movimenti ricorrenti');await page.getByRole('button',{name:'Affitto / mutuo',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Importo mensile (€)').fill('800');await dialog.getByRole('button',{name:'Crea ricorrenza'}).click();
  await go(page,'Panoramica');await expect(page.locator('.balance-card')).toContainText('1.800,01');
  await go(page,'Movimenti');await expect(page.locator('.transaction-row')).toHaveCount(2);await page.reload();await expect(page.locator('.transaction-row')).toHaveCount(2);
  await go(page,'Budget familiare');const conservative=page.locator('.template-card').filter({has:page.getByRole('heading',{name:'Conservativa',exact:true})});
  await page.getByRole('button',{name:'Applica template Conservativa'}).click();await expect(page.locator('.budget-category').last()).toContainText('35%');
  await page.getByRole('button',{name:'Modifica template Conservativa'}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Percentuale Casa e bollette').fill('25');await expect(dialog.getByRole('button',{name:'Salva template'})).toBeDisabled();await dialog.getByLabel('Percentuale Risparmio').fill('45');await expect(dialog.getByRole('button',{name:'Salva template'})).toBeDisabled();await dialog.getByLabel('Percentuale Risparmio').fill('40,00');await dialog.getByRole('button',{name:'Salva template'}).click();await expect(conservative).toContainText('40%');
  await page.getByRole('button',{name:'Modifica template Personalizzato'}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Nome categoria 1').fill('Casa nostra');await dialog.getByRole('button',{name:'Salva template'}).click();
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Reimposta template'}).click();await expect(conservative).toContainText('35%');await expect(page.locator('.template-card').filter({has:page.getByRole('heading',{name:'Personalizzato',exact:true})})).toContainText('Casa nostra');
  await page.getByRole('button',{name:'Applica template Personalizzato'}).click();await expect(page.locator('.budget-category').first()).toContainText('Casa nostra');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('template-budget.png'),fullPage:true});
  await go(page,'Redditi familiari');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
