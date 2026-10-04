export interface User { id: string; name: string; email: string; role: 'admin' | 'member'; householdId: string }
export interface Category { id: string; name: string; color: string; percentage: number }
export interface Transaction { id: string; kind: 'income' | 'expense'; amount: number; category_id: string | null; description: string; date: string; author: string; recurring_id?: string | null }
export interface Goal { id: string; title: string; horizon: 'short' | 'medium' | 'long'; target: number; saved: number; due_date: string | null }
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
  categories: Category[]; transactions: Transaction[]; goals: Goal[]; shopping: ShoppingItem[]; notes: Note[];
  deadlines: Deadline[]; waste: WasteSchedule[]; bills: Bill[]; meals: Meal[]; week: string; backups: BackupStatus | null;
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
  frequency: 'once' | 'monthly' | 'yearly'; requires_payment: number; amount: number | null;
  category_id: string | null; reminder_days: number; active: number;
  managed: { transaction_id: string | null; amount: number | null; category_id: string | null; handled_date: string; author: string } | null;
}
