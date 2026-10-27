import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CalendarDays, CalendarClock, Clock, MapPin, Pencil, Plus, Recycle, Repeat, Trash2 } from 'lucide-react';
import { api } from './api';
import { Empty, Modal } from './components';
import { localDate } from './finance';
import { addDays, eventOccurrence, monday } from './schedule';
import type { CalendarEvent, FamilyState, User } from './types';
import type { Dialog, Page } from './pages';

const weekdays = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
// Family events share the house colour; personal ones take their member's colour
// (same lists as server/calendar.mjs).
export const familyColor = '#176854';
export const memberColors = [['#3f7cc0', 'Blu'], ['#c4673f', 'Arancio'], ['#8e5cb0', 'Viola'], ['#d1495b', 'Rosso'], ['#2a9d8f', 'Turchese'], ['#d99a2b', 'Ocra'], ['#be879b', 'Rosa'], ['#6b7a8f', 'Ardesia']];
const eventColor = (data: FamilyState, event: CalendarEvent) => event.owner_id ? data.calendarColors[event.owner_id] || familyColor : familyColor;
const ownerName = (data: FamilyState, event: CalendarEvent) => data.members.find(m => m.id === event.owner_id)?.name;
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
  // A repeating event asks whether to remove only this occurrence or the following ones too.
  const [deleting, setDeleting] = useState<{ event: CalendarEvent; start: string } | null>(null);
  const remove = (event: CalendarEvent, start: string) => {
    if (event.recurrence !== 'none') return setDeleting({ event, start });
    if (confirm(`Eliminare “${event.title}” dal calendario?`)) void act(`/calendar/${event.id}`, 'DELETE').catch(() => {});
  };
  const removeRepeating = (scope: 'one' | 'following') => {
    if (!deleting) return;
    void act(`/calendar/${deleting.event.id}`, 'DELETE', { scope, date: deleting.start }).then(() => setDeleting(null)).catch(() => {});
  };
  return <>
    <section className="panel calendar-month" aria-label={`Calendario di ${monthTitle(month)}`}>
      <div className="section-heading"><div><h2>{capital(monthTitle(month))}</h2><p>Eventi della famiglia e scadenze del mese. Tocca un giorno per vederne il programma.</p></div></div>
      <div className="calendar-legend" aria-label="Colori del calendario"><span><i style={{ background: familyColor }} />Famiglia</span>{data.members.map(m => <span key={m.id}><i style={{ background: data.calendarColors[m.id] }} />{m.name}</span>)}</div>
      <div className="calendar-grid" role="grid">
        <div className="calendar-row" role="row">{weekdays.map(d => <span className="calendar-weekday" role="columnheader" key={d}>{d}</span>)}</div>
        {Array.from({ length: days.length / 7 }, (_, row) => <div className="calendar-row" role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(date => {
          const items = eventsOn(data.calendar, date); const due = date.startsWith(month) ? deadlines(date) : [];
          const count = items.length + due.length;
          return <button role="gridcell" key={date} aria-selected={date === selected} aria-label={`${longDate(date)}${count ? `, ${count} ${count === 1 ? 'impegno' : 'impegni'}` : ''}`}
            className={`calendar-day ${date.startsWith(month) ? '' : 'outside'} ${date === today ? 'today' : ''} ${date === selected ? 'selected' : ''}`} onClick={() => setPicked(date)}>
            <span className="calendar-number">{Number(date.slice(8))}</span>
            <span className="calendar-chips">{items.slice(0, 3).map(({ event, start }) => <span className="calendar-chip" key={event.id} style={{ background: eventColor(data, event) }}>{start === date && event.start_time ? `${event.start_time} ` : ''}{event.title}</span>)}
              {due.slice(0, Math.max(0, 3 - items.length)).map(d => <span className="calendar-chip deadline" key={d.id}>{d.name}</span>)}
              {count > 3 && <span className="calendar-more">+{count - 3}</span>}</span>
            {count > 0 && <span className="calendar-dots" aria-hidden="true">{items.slice(0, 3).map(({ event }) => <i key={event.id} style={{ background: eventColor(data, event) }} />)}{due.length > 0 && items.length < 3 && <i className="deadline" />}</span>}
          </button>;
        })}</div>)}
      </div>
    </section>
    <div className="calendar-columns">
      <section className="panel calendar-agenda" aria-label="Programma del giorno">
        <div className="section-heading"><div><span className="eyebrow">{selected === today ? 'OGGI' : 'PROGRAMMA DEL GIORNO'}</span><h2>{capital(longDate(selected))}</h2></div><button className="icon-button" aria-label="Aggiungi un evento in questo giorno" onClick={() => open({ type: 'event', date: selected })}><Plus size={18} /></button></div>
        {agenda.map(({ event, start }) => <article className="calendar-event" key={event.id} style={{ borderColor: eventColor(data, event) }}>
          <div className="calendar-event-top"><div><strong>{event.title}</strong><span className="calendar-meta"><Clock size={13} />{timeLabel(event, start, selected)}{event.recurrence !== 'none' && <><Repeat size={13} />{recurrences[event.recurrence]}</>}</span><span className="calendar-owner" style={{ color: eventColor(data, event) }}>{event.owner_id ? `Personale · ${ownerName(data, event) || 'membro'}` : 'Famiglia'}</span></div>
            <div className="row-actions"><button className="icon-button" aria-label={`Modifica evento ${event.title}`} onClick={() => open({ type: 'event', event })}><Pencil size={16} /></button><button className="icon-button danger" aria-label={`Elimina evento ${event.title}`} disabled={busy} onClick={() => remove(event, start)}><Trash2 size={16} /></button></div></div>
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
          <span className="calendar-date-badge" style={{ background: eventColor(data, event) }}><b>{Number(date.slice(8))}</b>{new Intl.DateTimeFormat('it-IT', { month: 'short' }).format(new Date(`${date}T12:00:00`))}</span>
          <span><strong>{event.title}</strong><small>{date === today ? 'Oggi' : shortDate(date)} · {timeLabel(event, start, date)}</small></span></button>)
          : data.calendar.length ? <p className="form-hint calendar-empty">Nessun evento nei prossimi 30 giorni.</p>
          : <Empty icon={<CalendarDays size={28} />} title="Il calendario di casa" description="Visite, compleanni, riunioni a scuola, partenze: ogni impegno è visibile a tutta la famiglia." action="Aggiungi il primo evento" onAction={() => open({ type: 'event', date: selected })} />}
      </section>
    </div>
    {deleting && <Modal title="Eliminare l’evento ripetuto?" subtitle={`“${deleting.event.title}” del ${longDate(deleting.start)} si ripete ${recurrences[deleting.event.recurrence].toLowerCase()}.`} onClose={() => setDeleting(null)}>
      <div className="calendar-delete-choices"><button className="button secondary" disabled={busy} onClick={() => removeRepeating('one')}>Solo questo evento</button><button className="button danger" disabled={busy} onClick={() => removeRepeating('following')}>Questo e tutti i successivi</button></div>
      <p className="form-hint">Le ripetizioni precedenti restano nel calendario.</p>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={() => setDeleting(null)}>Annulla</button></div>
    </Modal>}
  </>;
}

// The location field suggests places from the map (through the server) while typing;
// any text can still be written by hand.
type Place = { label: string; detail: string };
function PlaceInput({ defaultValue }: { defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue || '');
  const [places, setPlaces] = useState<Place[]>([]);
  const [active, setActive] = useState(-1); const [open, setOpen] = useState(false);
  // What the search is doing when there is nothing to pick: searching, no result or unavailable.
  const [note, setNote] = useState('');
  const chosen = useRef(defaultValue || '');
  useEffect(() => {
    const query = value.trim();
    if (!query.length || query === chosen.current) { setPlaces([]); setNote(''); return; }
    setPlaces([]); setActive(-1); setNote('');
    let stale = false;
    const timer = setTimeout(() => {
      setNote('Ricerca dei luoghi…');
      api<{ places: Place[] }>(`/places?q=${encodeURIComponent(query)}`)
        .then(r => { if (!stale) { setPlaces(r.places); setActive(-1); setNote(r.places.length ? '' : 'Nessun luogo trovato: puoi scriverlo a mano.'); } })
        .catch((err: Error) => { if (!stale) { setPlaces([]); setNote(err.message); } });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [value]);
  const shown = open && places.length > 0;
  // The field sits low in the dialog: the suggestions scroll into view when they open.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { if (shown) list.current?.scrollIntoView({ block: 'nearest' }); }, [shown]);
  const pick = (place: Place) => { chosen.current = place.label; setValue(place.label); setPlaces([]); setNote(''); };
  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (!shown) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const down = e.key === 'ArrowDown'; setActive(i => down ? (i + 1) % places.length : i <= 0 ? places.length - 1 : i - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(places[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }
  return <span className="place-field">
    <input name="location" aria-label="Luogo" role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls="place-options" aria-activedescendant={shown && active >= 0 ? `place-option-${active}` : undefined} autoComplete="off"
      value={value} onChange={e => { setValue(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={keys} placeholder="Cerca un luogo o un indirizzo, ad esempio via Roma 12" maxLength={120} />
    {shown && <ul ref={list} className="place-options" id="place-options" role="listbox" aria-label="Luoghi suggeriti">{places.map((place, i) => <li key={place.label} id={`place-option-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
      onMouseDown={e => { e.preventDefault(); pick(place); }} onMouseEnter={() => setActive(i)}><MapPin size={15} /><span><strong>{place.label}</strong>{place.detail && <small>{place.detail}</small>}</span></li>)}</ul>}
    {shown && <span className="place-attribution">Google Maps</span>}
    {open && !shown && note && <span className="place-note" role="status">{note}</span>}
  </span>;
}

type EventValue = Extract<NonNullable<Dialog>, { type: 'event' }>;
export function CalendarDialog({ dialog, data, user, onClose, mutate }: { dialog: EventValue; data: FamilyState; user: User; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const event = dialog.event;
  const [startDate, setStartDate] = useState(event?.start_date || dialog.date || localDate());
  const [endDate, setEndDate] = useState(event && event.end_date !== event.start_date ? event.end_date : '');
  const [allDay, setAllDay] = useState(event ? !event.start_time : true);
  const [recurrence, setRecurrence] = useState<CalendarEvent['recurrence']>(event?.recurrence || 'none');
  const [personal, setPersonal] = useState(!!event?.owner_id);
  const owner = event?.owner_id || user.id;
  const ownerLabel = owner === user.id ? 'Personale' : `Personale di ${data.members.find(m => m.id === owner)?.name || 'un membro'}`;
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setPending(true); setError('');
    const body = { title: form.get('title'), startDate, endDate: endDate || startDate, startTime: allDay ? '' : form.get('startTime'), endTime: allDay ? '' : form.get('endTime'),
      recurrence, recurrenceUntil: recurrence === 'none' ? null : form.get('recurrenceUntil') || null, location: form.get('location'), notes: form.get('notes'), personal };
    try { await mutate(event ? `/calendar/${event.id}` : '/calendar', event ? 'PUT' : 'POST', body); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setPending(false); }
  }
  return <Modal title={event ? 'Modifica evento' : 'Nuovo evento'} subtitle="Il calendario è condiviso con tutti i membri della famiglia." onClose={onClose}><form onSubmit={e => void submit(e)}>
    <label>Titolo<input name="title" defaultValue={event?.title} placeholder="Ad esempio: visita dal pediatra" required maxLength={120} /></label>
    <fieldset className="waste-day-picker calendar-scope"><legend>Di chi è l’impegno</legend><div>
      <label className={`checkbox-label ${personal ? '' : 'selected'}`}><input type="radio" name="scope" checked={!personal} onChange={() => setPersonal(false)} /><i style={{ background: familyColor }} />Famiglia</label>
      <label className={`checkbox-label ${personal ? 'selected' : ''}`}><input type="radio" name="scope" checked={personal} onChange={() => setPersonal(true)} /><i style={{ background: data.calendarColors[owner] || familyColor }} />{ownerLabel}</label>
    </div></fieldset>
    <div className="form-columns"><label>Data<input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); if (endDate && endDate < e.target.value) setEndDate(''); }} min="1900-01-01" max="2199-12-31" required /></label>
      <label>Fino al <span className="optional">facoltativo</span><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate} max="2199-12-31" /></label></div>
    <label className="checkbox-label"><input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />Tutto il giorno</label>
    {!allDay && <div className="form-columns"><label>Ora di inizio<input name="startTime" type="time" defaultValue={event?.start_time || '09:00'} required /></label><label>Ora di fine <span className="optional">facoltativa</span><input name="endTime" type="time" defaultValue={event?.end_time} /></label></div>}
    <div className="form-columns"><label>Ripetizione<select value={recurrence} onChange={e => setRecurrence(e.target.value as CalendarEvent['recurrence'])}>{Object.entries(recurrences).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {recurrence !== 'none' && <label>Ripeti fino al <span className="optional">facoltativo</span><input name="recurrenceUntil" type="date" defaultValue={event?.recurrence_until || ''} min={startDate} max="2199-12-31" /></label>}</div>
    <label>Luogo <span className="optional">facoltativo</span><PlaceInput defaultValue={event?.location} /></label>
    <label>Note <span className="optional">facoltative</span><textarea name="notes" defaultValue={event?.notes} placeholder="Cosa portare, chi accompagna…" maxLength={1000} rows={3} /></label>
    {event && event.recurrence !== 'none' && <p className="form-hint">Le modifiche valgono per tutte le ripetizioni dell’evento.</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Annulla</button><button className="button primary" disabled={pending}>{pending ? 'Salvataggio…' : event ? 'Salva evento' : 'Aggiungi evento'}</button></div>
  </form></Modal>;
}
