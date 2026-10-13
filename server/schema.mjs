export const BASE_SCHEMA = `
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_hash TEXT, invite_expires INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
      name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
      name TEXT NOT NULL, color TEXT NOT NULL, percentage INTEGER NOT NULL CHECK(percentage BETWEEN 0 AND 10000), position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
      kind TEXT NOT NULL CHECK(kind IN ('income','expense')), amount INTEGER NOT NULL CHECK(amount > 0),
      category_id TEXT REFERENCES categories(id), description TEXT NOT NULL, date TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transactions_month ON transactions(household_id, date);
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), title TEXT NOT NULL,
      horizon TEXT NOT NULL CHECK(horizon IN ('short','medium','long')), target INTEGER NOT NULL CHECK(target > 0),
      saved INTEGER NOT NULL DEFAULT 0 CHECK(saved >= 0), due_date TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK(amount > 0), author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shopping (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), name TEXT NOT NULL,
      quantity TEXT NOT NULL, section TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
      author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), title TEXT NOT NULL,
      content TEXT NOT NULL, color TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      author_id TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL, storage_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL
    );
  `;
export const WORKFLOW_SCHEMA = `
    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
      name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      category_id TEXT NOT NULL REFERENCES categories(id), due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
      start_month TEXT NOT NULL, reminder_days INTEGER NOT NULL CHECK(reminder_days BETWEEN 0 AND 30),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), month TEXT NOT NULL,
      due_date TEXT NOT NULL, transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
      UNIQUE(bill_id, month)
    );
    CREATE TABLE IF NOT EXISTS meals (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), date TEXT NOT NULL,
      slot TEXT NOT NULL CHECK(slot IN ('lunch','dinner')), title TEXT NOT NULL,
      servings INTEGER NOT NULL CHECK(servings BETWEEN 1 AND 20), ingredients TEXT NOT NULL,
      notes TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id),
      UNIQUE(household_id, date, slot)
    );
    CREATE TABLE IF NOT EXISTS meal_shopping (
      meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL,
      shopping_id TEXT NOT NULL UNIQUE REFERENCES shopping(id) ON DELETE CASCADE,
      PRIMARY KEY(meal_id, ingredient_id)
    );
  `;
export const TABLES = ['households', 'users', 'sessions', 'categories', 'transactions', 'goals', 'contributions', 'shopping', 'notes', 'attachments', 'bills', 'bill_payments', 'meals', 'meal_shopping'];
export const UPLOAD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_uploads (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, expires BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS file_upload_chunks (
    upload_id TEXT NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY(upload_id, chunk_index)
  );
`;
export const PLANNING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recurring_rules (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
    kind TEXT NOT NULL CHECK(kind IN ('income','expense')), start_month TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recurring_versions (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES recurring_rules(id), effective_month TEXT NOT NULL,
    name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), category_id TEXT REFERENCES categories(id),
    day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), end_month TEXT, enabled INTEGER NOT NULL,
    UNIQUE(rule_id, effective_month)
  );
  CREATE TABLE IF NOT EXISTS recurring_occurrences (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES recurring_rules(id), month TEXT NOT NULL,
    transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE SET NULL, overridden INTEGER NOT NULL DEFAULT 0,
    UNIQUE(rule_id, month)
  );
  CREATE TABLE IF NOT EXISTS budget_templates (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), template_key TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL, entries TEXT NOT NULL,
    UNIQUE(household_id, template_key)
  );
  CREATE TABLE IF NOT EXISTS budget_settings (
    household_id TEXT PRIMARY KEY REFERENCES households(id), active_template_id TEXT REFERENCES budget_templates(id)
  );
  CREATE TABLE IF NOT EXISTS budget_versions (
    household_id TEXT NOT NULL REFERENCES households(id), effective_month TEXT NOT NULL, entries TEXT NOT NULL,
    PRIMARY KEY(household_id, effective_month)
  );
`;
TABLES.push('recurring_rules', 'recurring_versions', 'recurring_occurrences', 'budget_templates', 'budget_settings', 'budget_versions');
export const WASTE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS waste_schedules (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
    name TEXT NOT NULL, days TEXT NOT NULL, time_window TEXT NOT NULL, notes TEXT NOT NULL, color TEXT NOT NULL
  );
`;
TABLES.push('waste_schedules');
// The family calendar: shared events, all-day or timed, one-off or repeating.
export const CALENDAR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), title TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    location TEXT NOT NULL, notes TEXT NOT NULL, color TEXT NOT NULL,
    recurrence TEXT NOT NULL CHECK(recurrence IN ('none','weekly','monthly','yearly')), recurrence_until TEXT,
    author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(end_date >= start_date)
  );
  CREATE INDEX IF NOT EXISTS calendar_events_household ON calendar_events(household_id, start_date);
  CREATE TABLE IF NOT EXISTS calendar_owners (
    event_id TEXT PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS calendar_skips (
    event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE, start_date TEXT NOT NULL, PRIMARY KEY(event_id, start_date)
  );
  CREATE TABLE IF NOT EXISTS member_colors (
    user_id TEXT PRIMARY KEY REFERENCES users(id), color TEXT NOT NULL
  );
`;
// Personal events belong to one member (otherwise they are the family's); skipped
// dates remove single occurrences of a repeating event.
TABLES.push('calendar_events', 'calendar_owners', 'calendar_skips', 'member_colors');

export const DEADLINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), name TEXT NOT NULL,
    start_date TEXT NOT NULL, due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31), frequency TEXT NOT NULL CHECK(frequency IN ('once','monthly','quarterly','semiannual','yearly')),
    requires_payment INTEGER NOT NULL CHECK(requires_payment IN (0,1)),
    amount INTEGER, category_id TEXT REFERENCES categories(id),
    reminder_days INTEGER NOT NULL CHECK(reminder_days BETWEEN 0 AND 30), active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    CHECK((requires_payment = 0 AND amount IS NULL AND category_id IS NULL) OR
          (requires_payment = 1 AND amount IS NOT NULL AND amount > 0 AND category_id IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS deadline_receipts (
    id TEXT PRIMARY KEY, deadline_id TEXT NOT NULL REFERENCES deadlines(id), month TEXT NOT NULL,
    due_date TEXT NOT NULL, handled_date TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id),
    transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    UNIQUE(deadline_id, month)
  );
  CREATE TABLE IF NOT EXISTS deadline_migrations (
    household_id TEXT PRIMARY KEY REFERENCES households(id)
  );
`;
TABLES.push('deadlines', 'deadline_receipts', 'deadline_migrations');

// Read-only bank data (AIS). Provider sessions are stored encrypted; balances
// and amounts are integer cents. Records imported from "balance" accounts count
// in the budget but other members only receive monthly totals per category.
export const BANK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bank_auth_requests (
    state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id), aspsp_name TEXT NOT NULL, aspsp_country TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('shared','balance')), expires BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bank_connections (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), user_id TEXT NOT NULL REFERENCES users(id),
    aspsp_name TEXT NOT NULL, aspsp_country TEXT NOT NULL, session_secret TEXT, valid_until TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','expired','error')), last_sync_at TEXT, last_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
    connection_id TEXT NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE, provider_uid TEXT NOT NULL,
    name TEXT NOT NULL, iban_hash TEXT, iban_last4 TEXT, currency TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('shared','balance')), import_from TEXT,
    balance BIGINT, balance_kind TEXT, balance_at TEXT, created_at TEXT NOT NULL, savings INTEGER NOT NULL DEFAULT 0,
    UNIQUE(connection_id, provider_uid)
  );
  CREATE TABLE IF NOT EXISTS bank_movements (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
    account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE, external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('income','expense')), amount BIGINT NOT NULL CHECK(amount > 0),
    date TEXT NOT NULL, description TEXT NOT NULL, match_key TEXT NOT NULL, counterparty_hash TEXT, salary_hint INTEGER NOT NULL DEFAULT 0, savings_hint INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('stored','imported','matched','transfer')),
    transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE SET NULL, created_at TEXT NOT NULL,
    UNIQUE(account_id, external_id)
  );
  CREATE INDEX IF NOT EXISTS bank_movements_date ON bank_movements(household_id, date);
  CREATE TABLE IF NOT EXISTS savings_destinations (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), destination_key TEXT NOT NULL, name TEXT NOT NULL,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    UNIQUE(household_id, destination_key)
  );
  CREATE TABLE IF NOT EXISTS savings_contributions (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    contribution_id TEXT NOT NULL UNIQUE REFERENCES contributions(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bank_account_exclusions (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), user_id TEXT NOT NULL REFERENCES users(id),
    account_key TEXT NOT NULL, connection_id TEXT REFERENCES bank_connections(id) ON DELETE SET NULL, provider_uid TEXT,
    name TEXT NOT NULL, iban_hash TEXT, iban_last4 TEXT, currency TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(user_id, account_key)
  );
  CREATE TABLE IF NOT EXISTS bank_exclusion_cleanups (
    exclusion_id TEXT PRIMARY KEY REFERENCES bank_account_exclusions(id) ON DELETE CASCADE, household_id TEXT NOT NULL REFERENCES households(id), done_at TEXT NOT NULL
  );
  -- Banks that once answered "too many requests" keep the unattended pace.
  CREATE TABLE IF NOT EXISTS bank_rate_limits (
    connection_id TEXT PRIMARY KEY REFERENCES bank_connections(id) ON DELETE CASCADE, household_id TEXT NOT NULL REFERENCES households(id), limited_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id), show_bank_balance INTEGER NOT NULL DEFAULT 0 CHECK(show_bank_balance IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS dashboard_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id), quick_actions INTEGER NOT NULL DEFAULT 0 CHECK(quick_actions IN (0,1)), cards TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS goal_plans (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
    monthly INTEGER NOT NULL DEFAULT 0 CHECK(monthly >= 0), is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS savings_settings (
    household_id TEXT PRIMARY KEY REFERENCES households(id), strategy TEXT NOT NULL CHECK(strategy IN ('primary','proportional'))
  );
  CREATE TABLE IF NOT EXISTS savings_allocations (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    contribution_id TEXT NOT NULL UNIQUE REFERENCES contributions(id) ON DELETE CASCADE,
    PRIMARY KEY(transaction_id, contribution_id)
  );
  -- Automatic shares of the savings accounts' balance, by Rome month.
  CREATE TABLE IF NOT EXISTS savings_balance_allocations (
    contribution_id TEXT PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id), month TEXT NOT NULL
  );
  -- One deposit can now feed several goals: earlier single links move here once.
  INSERT INTO savings_allocations SELECT transaction_id, contribution_id FROM savings_contributions WHERE true ON CONFLICT DO NOTHING;
  DELETE FROM savings_contributions;
  CREATE TABLE IF NOT EXISTS salary_payers (
    rule_id TEXT PRIMARY KEY REFERENCES recurring_rules(id) ON DELETE CASCADE, payer_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS private_transactions (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES users(id)
  );
`;
TABLES.push('user_preferences', 'dashboard_preferences', 'bank_connections', 'bank_accounts', 'bank_account_exclusions', 'bank_exclusion_cleanups', 'bank_movements', 'savings_destinations', 'savings_contributions', 'goal_plans', 'savings_settings', 'savings_allocations', 'salary_payers', 'private_transactions', 'savings_balance_allocations', 'bank_rate_limits');
// Push notifications: per-device subscriptions, per-account choices, a log that
// sends each notice once, and the VAPID keys when they are not set in the environment.
export const NOTIFICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_keys (
    id INTEGER PRIMARY KEY CHECK(id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id), types TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_log (
    user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id, key)
  );
`;
TABLES.push('push_subscriptions', 'notification_preferences');
// Budget advice: reports written with Claude from figures the server computes,
// category hints for imported expenses, and splits that hold for one month only.
export const ADVISOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS budget_month_overrides (
    household_id TEXT NOT NULL REFERENCES households(id), month TEXT NOT NULL, entries TEXT NOT NULL,
    report_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(household_id, month)
  );
  CREATE TABLE IF NOT EXISTS advisor_settings (
    household_id TEXT PRIMARY KEY REFERENCES households(id), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    requested_at TEXT, running_since TEXT, attempted_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisor_reports (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), kind TEXT NOT NULL CHECK(kind IN ('weekly','monthly')),
    period TEXT NOT NULL, month TEXT NOT NULL, facts TEXT NOT NULL, advice TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(household_id, kind, period)
  );
  CREATE TABLE IF NOT EXISTS advisor_category_hints (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisor_assignment (
    household_id TEXT PRIMARY KEY REFERENCES households(id), automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)), updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS advisor_kind_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('weekly','monthly')),
    read_at TEXT NOT NULL, PRIMARY KEY(user_id, kind)
  );
  CREATE TABLE IF NOT EXISTS advisor_reads (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, read_at TEXT NOT NULL
  );
`;
TABLES.push('budget_month_overrides', 'advisor_settings', 'advisor_reports', 'advisor_category_hints', 'advisor_reads', 'advisor_assignment', 'advisor_kind_reads');
// Daily usage of the pantry analysis, only to bound the calls to Claude: not
// family data, so it stays out of backups like the sign-in attempts.
export const PANTRY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pantry_usage (
    household_id TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL
  );
`;
// Daily questions to the assistant, only to bound the calls to the model: not
// family data, so it stays out of backups like the pantry analyses.
export const ASSISTANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS assistant_usage (
    household_id TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL
  );
`;
