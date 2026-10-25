CREATE TABLE arch_daily_income (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  payload TEXT NOT NULL,
  pulled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE arch_daily_income_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  batch_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  pulled_at INTEGER NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE arch_daily_invest (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  payload TEXT NOT NULL,
  pulled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
