DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE finance_state (
  id INTEGER PRIMARY KEY NOT NULL,
  payload TEXT,
  previous_live_net_worth REAL,
  status TEXT NOT NULL DEFAULT 'idle',
  task_id TEXT,
  message TEXT,
  updated_at INTEGER NOT NULL
);
