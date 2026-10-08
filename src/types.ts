export interface User { id: string; name: string; email: string; role: 'admin' | 'member'; householdId: string }
export interface Category { id: string; name: string; color: string; percentage: number }
export interface Transaction { id: string; kind: 'income' | 'expense'; amount: number; category_id: string | null; description: string; date: string; author: string; recurring_id?: string | null; bank_account?: string | null; privacy?: 'mine' | 'others' }
export interface Goal { id: string; title: string; horizon: 'short' | 'medium' | 'long'; target: number; saved: number; initial_saved: number; due_date: string | null; monthly: number; is_primary: number }
export interface Contribution { id: string; goal_id: string; amount: number; author: string; created_at: string; automatic: number }
export interface ShoppingItem { id: string; name: string; quantity: string; section: string; checked: number; author: string }
export interface Attachment { id: string; original_name: string; size: number }
export interface Note { id: string; title: string; content: string; color: string; pinned: number; author: string; updated_at: string; attachments: Attachment[] }
export interface Bill {
  id: string; name: string; amount: number; category_id: string; due_day: number;
  start_month: string; reminder_days: number; active: number; due_date: string;
  payment: { transaction_id: string; amount: number; date: string; author: string } | null;
}
export interface Ingredient { id?: string; name: string; quantity: string; section: string }
export interface Meal { id: string; date: string; slot: 'lunch' | 'dinner'; title: string; servings: number; ingredients: Ingredient[]; notes: string; author: string; shoppingAdded: string[] }
export interface BackupStatus { mode?: 'cloud'; enabled: boolean; lastAt: string | null; nextAt: string | null; retention: number; error: string | null }
export interface FamilyState {
  household: { id: string; name: string };
  members: { id: string; name: string; role: string }[];
  recurring: RecurringRule[]; budgetTemplates: BudgetTemplate[]; activeTemplateId: string | null;
  categories: Category[]; transactions: Transaction[]; history: MonthSummary[]; budgetFallback: { month: string; amount: number } | null; budgetSplit: Record<string, number> | null; goals: Goal[]; contributions: Contribution[]; shopping: ShoppingItem[]; notes: Note[];
  deadlines: Deadline[]; waste: WasteSchedule[]; bills: Bill[]; meals: Meal[]; week: string; backups: BackupStatus | null;
  bank: BankState;
  notifications: { publicKey: string; types: Record<NotificationType, boolean>; devices: number };
  preferences: { showBankBalance: boolean; quickActions: boolean; dashboard: { order: DashboardCard[]; hidden: DashboardCard[] } };
}
export interface RecurringRule {
  id: string; kind: 'income' | 'expense'; start_month: string; effective_month: string;
  name: string; amount: number; category_id: string | null; day: number; end_month: string | null;
  enabled: number; active: boolean; author: string;
}
export interface BudgetTemplate {
  id: string; template_key: string; name: string; description: string;
  entries: { id: string; name: string; percentage: number }[];
}

export interface WasteSchedule { id: string; name: string; days: number[]; time_window: string; notes: string; color: string }

export interface Deadline {
  id: string; name: string; start_date: string; due_day: number; due_date: string;
  frequency: 'once' | 'monthly' | 'quarterly' | 'semiannual' | 'yearly'; requires_payment: number; amount: number | null;
  category_id: string | null; reminder_days: number; active: number;
  managed: { transaction_id: string | null; amount: number | null; category_id: string | null; handled_date: string; author: string } | null;
}

export interface BankAccount {
  id: string; connection_id: string; name: string; bank: string; owner: string; mine: boolean; iban_last4: string | null; currency: string;
  visibility: 'shared' | 'balance'; savings: boolean; import_from: string | null; balance: number | null; balance_kind: 'available' | 'booked' | null; balance_at: string | null;
  status: 'active' | 'expired' | 'error'; valid_until: string; last_sync_at: string | null; last_error: string | null;
}
export interface BankConnection { id: string; bank: string; country: string; status: 'active' | 'expired' | 'error'; valid_until: string; last_error: string | null }
export interface BankState { configured: boolean; total: number; savingsTotal: number; accounts: BankAccount[]; connections: BankConnection[]; savingsStrategy: 'primary' | 'proportional'; savingsUnassigned: number }
export type DashboardCard = 'income' | 'expense' | 'balance' | 'savings' | 'spending' | 'home' | 'goals' | 'recent' | 'comparison';
export type NotificationType = 'notes' | 'shopping' | 'meals' | 'deadlines' | 'budget' | 'waste' | 'bank';

// Totals of a past month for the comparison; categories maps category id ('' for unclassified) to cents.
export type MonthSummary = { month: string; income: number; budgetIncome: number; expense: number; categories: Record<string, number> };
