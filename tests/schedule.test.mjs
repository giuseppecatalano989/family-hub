import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billStatus, monday, addDays, eventOccurrence } from '../src/schedule.ts';
import { occurrenceOn } from '../server/calendar.mjs';
import { dueDate } from '../server/workflows.mjs';

test('reminders distinguish upcoming, same-day, overdue and paid bills even across daylight saving changes', () => {
  const bill = { due_date: '2026-10-26', reminder_days: 3, payment: null };
  assert.equal(billStatus(bill, '2026-10-22').key, 'planned');
  assert.equal(billStatus(bill, '2026-10-23').label, 'Tra 3 giorni');
  assert.equal(billStatus(bill, '2026-10-25').label, 'Tra 1 giorno');
  assert.equal(billStatus(bill, '2026-10-26').label, 'Scade oggi');
  assert.equal(billStatus(bill, '2026-10-27').key, 'overdue');
  assert.equal(billStatus({ ...bill, payment: {} }, '2026-10-27').key, 'paid');
});
test('weekly menu anchors Sundays to the previous Monday and crosses months and years', () => {
  assert.equal(monday('2026-10-04'), '2026-09-28');
  assert.equal(monday('2026-10-05'), '2026-10-05');
  assert.equal(addDays('2026-12-28', 6), '2027-01-03');
  assert.equal(dueDate('2028-02', 31), '2028-02-29');
  assert.equal(dueDate('2026-04', 31), '2026-04-30');
});

test('calendar repetitions agree between interface and server', () => {
  const event = (recurrence, start_date, end_date = start_date, recurrence_until = null) => ({ recurrence, start_date, end_date, recurrence_until });
  const cases = [
    [event('none', '2026-10-15', '2026-10-17'), '2026-10-16', '2026-10-15'], [event('none', '2026-10-15'), '2026-10-16', null],
    [event('weekly', '2026-10-02'), '2026-10-16', '2026-10-16'], [event('weekly', '2026-10-02'), '2026-10-17', null], [event('weekly', '2026-10-02'), '2026-09-25', null],
    [event('weekly', '2026-10-02', '2026-10-02', '2026-10-09'), '2026-10-16', null],
    [event('monthly', '2026-01-31'), '2026-02-28', '2026-02-28'], [event('monthly', '2026-01-31'), '2026-03-31', '2026-03-31'], [event('monthly', '2026-01-31'), '2026-03-30', null],
    [event('monthly', '2026-01-30', '2026-02-01'), '2026-03-01', '2026-02-28'],
    [event('yearly', '2024-02-29'), '2026-02-28', '2026-02-28'], [event('yearly', '2024-02-29'), '2028-02-29', '2028-02-29'], [event('yearly', '2025-12-31', '2026-01-01'), '2027-01-01', '2026-12-31'],
  ];
  for (const [e, date, expected] of cases) {
    assert.equal(occurrenceOn(e, date), expected, `${e.recurrence} ${e.start_date} on ${date}`);
    assert.equal(eventOccurrence(e, date), expected, `${e.recurrence} ${e.start_date} on ${date} (interface)`);
  }
});
