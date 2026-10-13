import { randomUUID } from 'node:crypto';
import { CALENDAR_SCHEMA } from './schema.mjs';

export const CALENDAR_COLORS = ['#176854', '#8099b0', '#e3a95c', '#be879b', '#74816b', '#c4673f'];
export const CALENDAR_RECURRENCES = ['none', 'weekly', 'monthly', 'yearly'];
// An occurrence must end before the next one starts.
const MAX_SPAN = { none: 60, weekly: 6, monthly: 27, yearly: 60 };
const DAY = 86400000;
const stamp = value => Date.parse(`${value}T00:00:00Z`);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const lastDay = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// Start date of the occurrence that falls in the given month or week, if any:
// monthly and yearly events on a missing day (31, 29 February) move to the last one.
function startIn(event, year, month) {
  const [, , day] = event.start_date.split('-').map(Number);
  return iso(Date.UTC(year, month, Math.min(day, lastDay(year, month))));
}
// The occurrence that covers the date, as its start date, or null.
export function occurrenceOn(event, date) {
  const span = Math.round((stamp(event.end_date) - stamp(event.start_date)) / DAY);
  for (let back = 0; back <= span; back++) {
    const start = iso(stamp(date) - back * DAY);
    if (start < event.start_date || (event.recurrence_until && start > event.recurrence_until)) continue;
    const [year, month] = start.split('-').map(Number);
    const matches = event.recurrence === 'none' ? start === event.start_date
      : event.recurrence === 'weekly' ? Math.round((stamp(start) - stamp(event.start_date)) / DAY) % 7 === 0
      : event.recurrence === 'monthly' ? start === startIn(event, year, month - 1)
      : Number(event.start_date.slice(5, 7)) === month && start === startIn(event, year, month - 1);
    if (matches) return start;
  }
  return null;
}

export function installCalendar(app, { db, all, run, owned, fail, text, date, now }) {
  if (!db.cloud) db.exec(CALENDAR_SCHEMA);
  function input(body) {
    const startDate = date(body.startDate); const endDate = body.endDate ? date(body.endDate) : startDate;
    if (endDate < startDate) fail('La fine dell’evento non può precedere l’inizio.');
    if (!CALENDAR_RECURRENCES.includes(body.recurrence)) fail('Ripetizione non valida.');
    if (Math.round((stamp(endDate) - stamp(startDate)) / DAY) > MAX_SPAN[body.recurrence]) fail(body.recurrence === 'none' ? 'Un evento può durare al massimo 60 giorni.' : 'Ogni ripetizione deve finire prima che inizi la successiva.');
    const startTime = body.startTime ? body.startTime : ''; const endTime = body.endTime ? body.endTime : '';
    if ((startTime && !time(startTime)) || (endTime && !time(endTime)) || (endTime && !startTime)) fail('Orario non valido.');
    if (endTime && startDate === endDate && endTime <= startTime) fail('L’orario di fine deve seguire quello di inizio.');
    const until = body.recurrence === 'none' || !body.recurrenceUntil ? null : date(body.recurrenceUntil);
    if (until && until < startDate) fail('La ripetizione deve terminare dopo il primo evento.');
    if (!CALENDAR_COLORS.includes(body.color)) fail('Colore non valido.');
    return [text(body.title, 'Titolo', 120), startDate, endDate, startTime, endTime, text(body.location, 'Luogo', 120, true), text(body.notes, 'Note', 1000, true), body.color, body.recurrence, until];
  }
  app.post('/api/calendar', async (req, res) => {
    const values = input(req.body); const id = randomUUID(); const created = now();
    await run('INSERT INTO calendar_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...values, req.user.id, created, created);
    res.status(201).json({ id });
  });
  app.put('/api/calendar/:id', async (req, res) => {
    await owned('calendar_events', req.params.id, req.user);
    const values = input(req.body);
    await run(`UPDATE calendar_events SET title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, location = ?, notes = ?, color = ?, recurrence = ?, recurrence_until = ?, updated_at = ?
      WHERE id = ? AND household_id = ?`, ...values, now(), req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  // Removing a repeating event removes the whole series.
  app.delete('/api/calendar/:id', async (req, res) => {
    await owned('calendar_events', req.params.id, req.user);
    await run('DELETE FROM calendar_events WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
    res.json({ ok: true });
  });
  return {
    async state(hid) {
      return all(`SELECT e.id, e.title, e.start_date, e.end_date, e.start_time, e.end_time, e.location, e.notes, e.color, e.recurrence, e.recurrence_until, u.name AS author
        FROM calendar_events e JOIN users u ON u.id = e.author_id WHERE e.household_id = ? ORDER BY e.start_date, e.start_time, e.title`, hid);
    },
  };
}
