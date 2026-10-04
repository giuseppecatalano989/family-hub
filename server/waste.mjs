import { randomUUID } from 'node:crypto';
import { WASTE_SCHEMA } from './schema.mjs';

export const WASTE_COLORS = ['#176854', '#8099b0', '#e3a95c', '#be879b', '#74816b'];
export function installWaste(app, { db, all, run, owned, fail, text }) {
  if (!db.cloud) db.exec(WASTE_SCHEMA);
  function input(body) {
    if (!Array.isArray(body.days) || !body.days.length || body.days.length > 7 || body.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(body.days).size !== body.days.length) fail('Scegli almeno un giorno di conferimento, senza ripetizioni.');
    if (!WASTE_COLORS.includes(body.color)) fail('Colore non valido.');
    return [text(body.name, 'Tipologia', 80), JSON.stringify([...body.days].sort((a, b) => a - b)), text(body.timeWindow, 'Orario', 100, true), text(body.notes, 'Indicazioni', 1000, true), body.color];
  }
  app.post('/api/waste', async (req, res) => {
    const values = input(req.body); const id = randomUUID();
    await run('INSERT INTO waste_schedules VALUES (?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...values);
    res.status(201).json({ id });
  });
  app.put('/api/waste/:id', async (req, res) => {
    await owned('waste_schedules', req.params.id, req.user);
    const values = input(req.body);
    await run('UPDATE waste_schedules SET name = ?, days = ?, time_window = ?, notes = ?, color = ? WHERE id = ? AND household_id = ?', ...values, req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  app.delete('/api/waste/:id', async (req, res) => {
    await owned('waste_schedules', req.params.id, req.user);
    await run('DELETE FROM waste_schedules WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  return { async state(hid) { return (await all('SELECT * FROM waste_schedules WHERE household_id = ? ORDER BY name', hid)).map(row => ({ ...row, days: JSON.parse(row.days) })); } };
}
