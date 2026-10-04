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
