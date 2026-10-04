import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billStatus, monday, addDays } from '../src/schedule.ts';
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
