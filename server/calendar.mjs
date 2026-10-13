import { randomUUID } from 'node:crypto';
import { CALENDAR_SCHEMA } from './schema.mjs';

// Family events share the house colour; personal ones take their member's colour.
export const FAMILY_COLOR = '#176854';
export const MEMBER_COLORS = ['#3f7cc0', '#c4673f', '#8e5cb0', '#d1495b', '#2a9d8f', '#d99a2b', '#be879b', '#6b7a8f'];
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
    if (start < event.start_date || (event.recurrence_until && start > event.recurrence_until) || event.skipped?.includes(start)) continue;
    const [year, month] = start.split('-').map(Number);
    const matches = event.recurrence === 'none' ? start === event.start_date
      : event.recurrence === 'weekly' ? Math.round((stamp(start) - stamp(event.start_date)) / DAY) % 7 === 0
      : event.recurrence === 'monthly' ? start === startIn(event, year, month - 1)
      : Number(event.start_date.slice(5, 7)) === month && start === startIn(event, year, month - 1);
    if (matches) return start;
  }
  return null;
}

export function installCalendar(app, { db, one, all, run, atomic, owned, fail, text, date, now }) {
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
    if (typeof body.personal !== 'boolean') fail('Scegli se l’evento è della famiglia o personale.');
    return [text(body.title, 'Titolo', 120), startDate, endDate, startTime, endTime, text(body.location, 'Luogo', 120, true), text(body.notes, 'Note', 1000, true), FAMILY_COLOR, body.recurrence, until];
  }
  // Each member chooses their own colour, different from the others'.
  app.put('/api/calendar/color', async (req, res) => {
    const color = req.body?.color;
    if (!MEMBER_COLORS.includes(color)) fail('Colore non valido.');
    await atomic(async () => {
      const taken = await one('SELECT u.name FROM member_colors c JOIN users u ON u.id = c.user_id WHERE u.household_id = ? AND c.color = ? AND u.id <> ?', req.user.household_id, color, req.user.id);
      if (taken) fail(`Questo colore è già di ${taken.name}.`, 409);
      await run('INSERT INTO member_colors VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET color = excluded.color', req.user.id, color);
    });
    res.json({ ok: true });
  });
  app.post('/api/calendar', async (req, res) => {
    const values = input(req.body); const id = randomUUID(); const created = now();
    await atomic(async () => {
      await run('INSERT INTO calendar_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, req.user.household_id, ...values, req.user.id, created, created);
      if (req.body.personal) await run('INSERT INTO calendar_owners VALUES (?, ?)', id, req.user.id);
    });
    res.status(201).json({ id });
  });
  app.put('/api/calendar/:id', async (req, res) => {
    const values = input(req.body);
    await atomic(async () => {
      await owned('calendar_events', req.params.id, req.user);
      await run(`UPDATE calendar_events SET title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, location = ?, notes = ?, color = ?, recurrence = ?, recurrence_until = ?, updated_at = ?
        WHERE id = ? AND household_id = ?`, ...values, now(), req.params.id, req.user.household_id);
      // A personal event stays its member's; one that becomes personal is the editor's.
      if (!req.body.personal) await run('DELETE FROM calendar_owners WHERE event_id = ?', req.params.id);
      else await run('INSERT INTO calendar_owners VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING', req.params.id, req.user.id);
    });
    res.json({ ok: true });
  });
  // A repeating event loses one occurrence, the occurrences from a date on, or the whole series.
  app.delete('/api/calendar/:id', async (req, res) => {
    const scope = req.body?.scope ?? 'all';
    if (!['all', 'one', 'following'].includes(scope)) fail('Scelta non valida.');
    await atomic(async () => {
      const event = await owned('calendar_events', req.params.id, req.user);
      if (scope !== 'all' && event.recurrence !== 'none') {
        const from = date(req.body.date);
        event.skipped = (await all('SELECT start_date FROM calendar_skips WHERE event_id = ?', event.id)).map(r => r.start_date);
        if (occurrenceOn(event, from) !== from) fail('Questa data non è una ripetizione dell’evento.');
        if (scope === 'one') return run('INSERT INTO calendar_skips VALUES (?, ?) ON CONFLICT(event_id, start_date) DO NOTHING', event.id, from);
        // Ending the series keeps it only while an earlier occurrence remains.
        let earlier = false;
        for (let ms = stamp(event.start_date); ms < stamp(from) && !earlier; ms += DAY) earlier = occurrenceOn(event, iso(ms)) === iso(ms);
        if (earlier) {
          await run('UPDATE calendar_events SET recurrence_until = ?, updated_at = ? WHERE id = ?', iso(stamp(from) - DAY), now(), event.id);
          await run('DELETE FROM calendar_skips WHERE event_id = ? AND start_date >= ?', event.id, from);
          return;
        }
      }
      await run('DELETE FROM calendar_events WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
    });
    res.json({ ok: true });
  });
  // Members without a colour get the first free one, kept from then on.
  async function colors(hid) {
    const members = await all('SELECT u.id, c.color FROM users u LEFT JOIN member_colors c ON c.user_id = u.id WHERE u.household_id = ? ORDER BY u.role, u.id', hid);
    if (members.some(m => !m.color)) await atomic(async () => {
      const used = new Set(members.map(m => m.color).filter(Boolean));
      for (const member of members.filter(m => !m.color)) {
        member.color = MEMBER_COLORS.find(c => !used.has(c)) || MEMBER_COLORS[used.size % MEMBER_COLORS.length];
        used.add(member.color);
        await run('INSERT INTO member_colors VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING', member.id, member.color);
      }
    });
    return Object.fromEntries(members.map(m => [m.id, m.color]));
  }
  return {
    async state(hid) {
      const events = await all(`SELECT e.id, e.title, e.start_date, e.end_date, e.start_time, e.end_time, e.location, e.notes, e.recurrence, e.recurrence_until, o.user_id AS owner_id, u.name AS author
        FROM calendar_events e JOIN users u ON u.id = e.author_id LEFT JOIN calendar_owners o ON o.event_id = e.id WHERE e.household_id = ? ORDER BY e.start_date, e.start_time, e.title`, hid);
      const skips = await all('SELECT s.event_id, s.start_date FROM calendar_skips s JOIN calendar_events e ON e.id = s.event_id WHERE e.household_id = ?', hid);
      return { calendar: events.map(e => ({ ...e, skipped: skips.filter(s => s.event_id === e.id).map(s => s.start_date) })), calendarColors: await colors(hid) };
    },
  };
}
