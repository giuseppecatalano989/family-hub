import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateBudget, budgetIncome, parseMoney, totals } from '../src/finance.ts';

test('Italian decimals are parsed as integer cents without floating point rounding', () => {
  assert.equal(parseMoney('19,99'), 1999);
  assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney('2500'), 250000);
  for (const input of ['-1', '1.001', '1e3', 'NaN', '1.000,00', '', '10000001']) assert.throws(() => parseMoney(input));
});
test('rounding remainders are allocated so all category budgets sum to the income', () => {
  const categories = [ { id: 'a', percentage: 3333 }, { id: 'b', percentage: 3333 }, { id: 'c', percentage: 3334 } ];
  for (const income of [0, 1, 2, 3, 10001, 356299]) {
    const allocation = allocateBudget(income, categories);
    assert.equal(Object.values(allocation).reduce((sum, value) => sum + value, 0), income);
    assert.ok(Object.values(allocation).every(Number.isInteger));
  }
  assert.deepEqual(allocateBudget(1, categories), { a: 0, b: 0, c: 1 });
});
test('monthly totals retain negative balances and exact cent values', () => {
  assert.deepEqual(totals([{ kind: 'income', amount: 10 }, { kind: 'expense', amount: 20 }, { kind: 'expense', amount: 1 }]), { income: 10, expense: 21, balance: -11 });
});

test('only recurring incomes fund the budget; one-off incomes stay in the totals', () => {
  const rows = [{ kind: 'income', amount: 180000, recurring_id: 'salary' }, { kind: 'income', amount: 175000, recurring_id: null }, { kind: 'income', amount: 5000 }, { kind: 'expense', amount: 9000, recurring_id: 'rent' }];
  assert.equal(budgetIncome(rows), 180000);
  assert.equal(totals(rows).income, 360000);
});
