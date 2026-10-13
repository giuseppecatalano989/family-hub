import { localDate } from './finance.ts';
import type { Bill, CalendarEvent, Deadline } from './types';

export function monday(value: string) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return localDate(date);
}
export function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return localDate(date);
}
export function billStatus(bill: Bill, today = localDate()) {
  if (bill.payment) return { key: 'paid', label: 'Pagata' };
  const days = Math.round((new Date(`${bill.due_date}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) / 86400_000);
  if (days < 0) return { key: 'overdue', label: 'Scaduta' };
  if (days === 0) return { key: 'soon', label: 'Scade oggi' };
  if (days <= bill.reminder_days) return { key: 'soon', label: `Tra ${days} ${days === 1 ? 'giorno' : 'giorni'}` };
  return { key: 'planned', label: 'Da pagare' };
}

export function deadlineStatus(deadline: Deadline, today = localDate()) {
  if (deadline.managed) return { key: 'paid', label: 'Gestita' };
  const status = billStatus({ payment: null, due_date: deadline.due_date, reminder_days: deadline.reminder_days } as Bill, today);
  return status.key === 'planned' ? { key: 'planned', label: 'Da gestire' } : status;
}

// Start date of the calendar occurrence that covers the date, or null. Monthly
// and yearly events on a missing day (31, 29 February) move to the month's last day.
// Same rule as occurrenceOn in server/calendar.mjs.
export function eventOccurrence(event: CalendarEvent, date: string) {
  const stamp = (value: string) => Date.parse(`${value}T00:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const span = Math.round((stamp(event.end_date) - stamp(event.start_date)) / 86400_000);
  const day = Number(event.start_date.slice(8));
  for (let back = 0; back <= span; back++) {
    const start = iso(stamp(date) - back * 86400_000);
    if (start < event.start_date || (event.recurrence_until && start > event.recurrence_until)) continue;
    const [year, month] = start.split('-').map(Number);
    const clamped = iso(Date.UTC(year, month - 1, Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate())));
    const matches = event.recurrence === 'none' ? start === event.start_date
      : event.recurrence === 'weekly' ? Math.round((stamp(start) - stamp(event.start_date)) / 86400_000) % 7 === 0
      : event.recurrence === 'monthly' ? start === clamped
      : Number(event.start_date.slice(5, 7)) === month && start === clamped;
    if (matches) return start;
  }
  return null;
}
