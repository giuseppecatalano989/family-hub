import type { Category, Transaction } from './types.ts';

export const money = (cents: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: true }).format(cents / 100);
export function parseMoney(value: string): number {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Inserisci un importo con al massimo due decimali.');
  const [whole, decimals = ''] = normalized.split('.');
  const result = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1_000_000_000) throw new Error('Importo troppo grande.');
  return result;
}
export const toInput = (cents: number) => (cents / 100).toFixed(2);
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const readableDate = (date: string) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
export function totals(transactions: Transaction[]) {
  const income = transactions.filter(t => t.kind === 'income').reduce((sum, t) => sum + t.amount, 0);
  const expense = transactions.filter(t => t.kind === 'expense').reduce((sum, t) => sum + t.amount, 0);
  return { income, expense, balance: income - expense };
}
// Only recurring incomes (salaries and incomes set as recurring) fund the budget;
// one-off incomes stay in Entrate and in the monthly balance.
export const budgetIncome = (transactions: Pick<Transaction, 'kind' | 'amount' | 'recurring_id'>[]) => transactions.filter(t => t.kind === 'income' && t.recurring_id).reduce((sum, t) => sum + t.amount, 0);
// Months before the first recurring income use that month's base (from the server).
export const budgetBase = (data: { transactions: Pick<Transaction, 'kind' | 'amount' | 'recurring_id'>[]; budgetFallback?: { amount: number } | null }) => budgetIncome(data.transactions) || data.budgetFallback?.amount || 0;
// Allocate rounding cents deterministically so the category budgets equal the income.
export function allocateBudget(income: number, categories: Category[]) {
  const rows = categories.map((c, index) => ({ id: c.id, amount: Math.floor(income * c.percentage / 10000), remainder: income * c.percentage % 10000, index }));
  let left = income - rows.reduce((sum, c) => sum + c.amount, 0);
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    row.amount++; left--;
  }
  return Object.fromEntries(rows.map(row => [row.id, row.amount])) as Record<string, number>;
}
