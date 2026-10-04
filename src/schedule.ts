import { localDate } from './finance.ts';
import type { Bill, Deadline } from './types';

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
