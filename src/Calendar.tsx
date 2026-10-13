import { useState, type FormEvent } from 'react';
import { CalendarDays, CalendarClock, Clock, MapPin, Pencil, Plus, Recycle, Repeat, Trash2 } from 'lucide-react';
import { Empty, Modal } from './components';
import { localDate } from './finance';
import { addDays, eventOccurrence, monday } from './schedule';
import type { CalendarEvent, FamilyState } from './types';
import type { Dialog, Page } from './pages';

const weekdays = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const colors = [['#176854', 'Verde'], ['#8099b0', 'Azzurro'], ['#e3a95c', 'Giallo'], ['#be879b', 'Rosa'], ['#74816b', 'Grigio'], ['#c4673f', 'Arancio']];
const recurrences = { none: 'Una sola volta', weekly: 'Ogni settimana', monthly: 'Ogni mese', yearly: 'Ogni anno' } as const;
const longDate = (date: string) => new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
const shortDate = (date: string) => new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));
const monthTitle = (month: string) => new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00`));
const capital = (value: string) => value.charAt(0).toLocaleUpperCase('it') + value.slice(1);
const weekday = (date: string) => (new Date(`${date}T12:00:00`).getDay() + 6) % 7;

// The events on a date, timed ones in order after those lasting all day.
export function eventsOn(events: CalendarEvent[], date: string) {
  return events.flatMap(event => { const start = eventOccurrence(event, date); return start ? [{ event, start }] : []; })
    .sort((a, b) => (a.start === date ? a.event.start_time : '').localeCompare(b.start === date ? b.event.start_time : '') || a.event.title.localeCompare(b.event.title));
}
function timeLabel(event: CalendarEvent, start: string, date: string) {
  const end = addDays(start, Math.round((Date.parse(event.end_date) - Date.parse(event.start_date)) / 86400_000));
  if (start !== end) {
    if (date === start) return event.start_time ? `Dalle ${event.start_time}` : `Fino al ${shortDate(end)}`;
    if (date === end) return event.end_time ? `Fino alle ${event.end_time}` : 'Ultimo giorno';
    return 'Tutto il giorno';
  }
  if (!event.start_time) return 'Tutto il giorno';
  return event.end_time ? `${event.start_time}–${event.end_time}` : event.start_time;
}
// Today's events, or the next one within a month, for the overview.
export function calendarCaption(events: CalendarEvent[], today = localDate()) {
  if (!events.length) return 'Aggiungi il primo evento di famiglia';
  const now = eventsOn(events, today);
  if (now.length) return `Oggi: ${now.map(e => e.event.title).join(', ')}`;
  for (let i = 1; i <= 30; i++) {
    const date = addDays(today, i); const next = eventsOn(events, date).find(e => e.start === date);
    if (next) return `Prossimo: ${next.event.title} · ${shortDate(date)}`;
  }
  return 'Nessun evento nei prossimi 30 giorni';
}

type Props = { data: FamilyState; month: string; open: (dialog: Dialog) => void; navigate: (page: Page) => void; act: (path: string, method: string, body?: unknown) => Promise<void>; busy: boolean };
export function Calendar({ data, month, open, navigate, act, busy }: Props) {
  const today = localDate();
  const [picked, setPicked] = useState(today);
  const selected = picked.startsWith(month) ? picked : today.startsWith(month) ? today : `${month}-01`;
  const first = monday(`${month}-01`);
  const last = addDays(monday(addDays(`${addDays(`${month}-01`, 31).slice(0, 7)}-01`, -1)), 6);
  const days: string[] = []; for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const deadlines = (date: string) => data.deadlines.filter(d => d.due_date === date);
  const agenda = eventsOn(data.calendar, selected);
  const waste = data.waste.filter(w => w.days.includes(weekday(selected)));
  const upcoming = Array.from({ length: 30 }, (_, i) => addDays(today, i)).flatMap(date => eventsOn(data.calendar, date).filter(e => e.start === date || date === today).map(e => ({ ...e, date }))).slice(0, 6);
  const remove = (event: CalendarEvent) => {
    if (confirm(event.recurrence === 'none' ? `Eliminare “${event.title}” dal calendario?` : `Eliminare “${event.title}” e tutte le sue ripetizioni?`)) void act(`/calendar/${event.id}`, 'DELETE').catch(() => {});
  };
  return <>
    <section className="panel calendar-month" aria-label={`Calendario di ${monthTitle(month)}`}>
      <div className="section-heading"><div><h2>{capital(monthTitle(month))}</h2><p>Eventi della famiglia e scadenze del mese. Tocca un giorno per vederne il programma.</p></div></div>
      <div className="calendar-grid" role="grid">
        <div className="calendar-row" role="row">{weekdays.map(d => <span className="calendar-weekday" role="columnheader" key={d}>{d}</span>)}</div>
        {Array.from({ length: days.length / 7 }, (_, row) => <div className="calendar-row" role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(date => {
          const items = eventsOn(data.calendar, date); const due = date.startsWith(month) ? deadlines(date) : [];
          const count = items.length + due.length;
          return <button role="gridcell" key={date} aria-selected={date === selected} aria-label={`${longDate(date)}${count ? `, ${count} ${count === 1 ? 'impegno' : 'impegni'}` : ''}`}
            className={`calendar-day ${date.startsWith(month) ? '' : 'outside'} ${date === today ? 'today' : ''} ${date === selected ? 'selected' : ''}`} onClick={() => setPicked(date)}>
            <span className="calendar-number">{Number(date.slice(8))}</span>
            <span className="calendar-chips">{items.slice(0, 3).map(({ event, start }) => <span className="calendar-chip" key={event.id} style={{ background: event.color }}>{start === date && event.start_time ? `${event.start_time} ` : ''}{event.title}</span>)}
              {due.slice(0, Math.max(0, 3 - items.length)).map(d => <span className="calendar-chip deadline" key={d.id}>{d.name}</span>)}
              {count > 3 && <span className="calendar-more">+{count - 3}</span>}</span>
            {count > 0 && <span className="calendar-dots" aria-hidden="true">{items.slice(0, 3).map(({ event }) => <i key={event.id} style={{ background: event.color }} />)}{due.length > 0 && items.length < 3 && <i className="deadline" />}</span>}
          </button>;
        })}</div>)}
      </div>
    </section>
    <div className="calendar-columns">
      <section className="panel calendar-agenda" aria-label="Programma del giorno">
        <div className="section-heading"><div><span className="eyebrow">{selected === today ? 'OGGI' : 'PROGRAMMA DEL GIORNO'}</span><h2>{capital(longDate(selected))}</h2></div><button className="icon-button" aria-label="Aggiungi un evento in questo giorno" onClick={() => open({ type: 'event', date: selected })}><Plus size={18} /></button></div>
        {agenda.map(({ event, start }) => <article className="calendar-event" key={event.id} style={{ borderColor: event.color }}>
          <div className="calendar-event-top"><div><strong>{event.title}</strong><span className="calendar-meta"><Clock size={13} />{timeLabel(event, start, selected)}{event.recurrence !== 'none' && <><Repeat size={13} />{recurrences[event.recurrence]}</>}</span></div>
            <div className="row-actions"><button className="icon-button" aria-label={`Modifica evento ${event.title}`} onClick={() => open({ type: 'event', event })}><Pencil size={16} /></button><button className="icon-button danger" aria-label={`Elimina evento ${event.title}`} disabled={busy} onClick={() => remove(event)}><Trash2 size={16} /></button></div></div>
          {event.location && <span className="calendar-meta"><MapPin size={13} />{event.location}</span>}
          {event.notes && <p>{event.notes}</p>}
          <small>Aggiunto da {event.author}</small>
        </article>)}
        {selected.startsWith(month) && deadlines(selected).map(d => <button className="calendar-event calendar-deadline" key={d.id} onClick={() => navigate('bills')}><strong><CalendarClock size={15} />{d.name}</strong><span className="calendar-meta">{d.managed ? 'Scadenza gestita' : 'Scadenza da gestire'} · vai alle Scadenze</span></button>)}
        {waste.length > 0 && <button className="calendar-event calendar-waste" onClick={() => navigate('waste')}><strong><Recycle size={15} />Conferimento: {waste.map(w => w.name).join(', ')}</strong>{waste.some(w => w.time_window) && <span className="calendar-meta">{waste.filter(w => w.time_window).map(w => `${w.name}: ${w.time_window}`).join(' · ')}</span>}</button>}
        {!agenda.length && !(selected.startsWith(month) && deadlines(selected).length) && <p className="form-hint calendar-empty">Nessun evento in programma. <button className="text-button" onClick={() => open({ type: 'event', date: selected })}>Aggiungi un evento</button></p>}
      </section>
      <section className="panel calendar-upcoming" aria-label="Prossimi eventi">
        <div className="section-heading"><div><span className="eyebrow">I PROSSIMI 30 GIORNI</span><h2>In arrivo</h2></div><CalendarDays size={22} /></div>
        {upcoming.length ? upcoming.map(({ event, start, date }) => <button className="calendar-upcoming-item" key={`${event.id}-${date}`} onClick={() => setPicked(date)} aria-label={`${event.title}, ${longDate(date)}`}>
          <span className="calendar-date-badge" style={{ background: event.color }}><b>{Number(date.slice(8))}</b>{new Intl.DateTimeFormat('it-IT', { month: 'short' }).format(new Date(`${date}T12:00:00`))}</span>
          <span><strong>{event.title}</strong><small>{date === today ? 'Oggi' : shortDate(date)} · {timeLabel(event, start, date)}</small></span></button>)
          : data.calendar.length ? <p className="form-hint calendar-empty">Nessun evento nei prossimi 30 giorni.</p>
          : <Empty icon={<CalendarDays size={28} />} title="Il calendario di casa" description="Visite, compleanni, riunioni a scuola, partenze: ogni impegno è visibile a tutta la famiglia." action="Aggiungi il primo evento" onAction={() => open({ type: 'event', date: selected })} />}
      </section>
    </div>
  </>;
}

type EventValue = Extract<NonNullable<Dialog>, { type: 'event' }>;
export function CalendarDialog({ dialog, onClose, mutate }: { dialog: EventValue; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const event = dialog.event;
  const [startDate, setStartDate] = useState(event?.start_date || dialog.date || localDate());
  const [endDate, setEndDate] = useState(event && event.end_date !== event.start_date ? event.end_date : '');
  const [allDay, setAllDay] = useState(event ? !event.start_time : true);
  const [recurrence, setRecurrence] = useState<CalendarEvent['recurrence']>(event?.recurrence || 'none');
  const [color, setColor] = useState(event?.color || colors[0][0]);
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setPending(true); setError('');
    const body = { title: form.get('title'), startDate, endDate: endDate || startDate, startTime: allDay ? '' : form.get('startTime'), endTime: allDay ? '' : form.get('endTime'),
      recurrence, recurrenceUntil: recurrence === 'none' ? null : form.get('recurrenceUntil') || null, location: form.get('location'), notes: form.get('notes'), color };
    try { await mutate(event ? `/calendar/${event.id}` : '/calendar', event ? 'PUT' : 'POST', body); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setPending(false); }
  }
  return <Modal title={event ? 'Modifica evento' : 'Nuovo evento'} subtitle="Il calendario è condiviso con tutti i membri della famiglia." onClose={onClose}><form onSubmit={e => void submit(e)}>
    <label>Titolo<input name="title" defaultValue={event?.title} placeholder="Ad esempio: visita dal pediatra" required maxLength={120} /></label>
    <div className="form-columns"><label>Data<input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); if (endDate && endDate < e.target.value) setEndDate(''); }} min="1900-01-01" max="2199-12-31" required /></label>
      <label>Fino al <span className="optional">facoltativo</span><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate} max="2199-12-31" /></label></div>
    <label className="checkbox-label"><input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />Tutto il giorno</label>
    {!allDay && <div className="form-columns"><label>Ora di inizio<input name="startTime" type="time" defaultValue={event?.start_time || '09:00'} required /></label><label>Ora di fine <span className="optional">facoltativa</span><input name="endTime" type="time" defaultValue={event?.end_time} /></label></div>}
    <div className="form-columns"><label>Ripetizione<select value={recurrence} onChange={e => setRecurrence(e.target.value as CalendarEvent['recurrence'])}>{Object.entries(recurrences).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {recurrence !== 'none' && <label>Ripeti fino al <span className="optional">facoltativo</span><input name="recurrenceUntil" type="date" defaultValue={event?.recurrence_until || ''} min={startDate} max="2199-12-31" /></label>}</div>
    <label>Luogo <span className="optional">facoltativo</span><input name="location" defaultValue={event?.location} placeholder="Ad esempio: studio medico, via Roma 12" maxLength={120} /></label>
    <label>Note <span className="optional">facoltative</span><textarea name="notes" defaultValue={event?.notes} placeholder="Cosa portare, chi accompagna…" maxLength={1000} rows={3} /></label>
    <label>Colore<select value={color} onChange={e => setColor(e.target.value)}>{colors.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {event && event.recurrence !== 'none' && <p className="form-hint">Le modifiche valgono per tutte le ripetizioni dell’evento.</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Annulla</button><button className="button primary" disabled={pending}>{pending ? 'Salvataggio…' : event ? 'Salva evento' : 'Aggiungi evento'}</button></div>
  </form></Modal>;
}
