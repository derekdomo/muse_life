CREATE TABLE activity_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE family_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type_name TEXT NOT NULL,
  minutes INTEGER,
  note TEXT,
  request_key TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX family_activities_request_key_idx ON family_activities (request_key);
--> statement-breakpoint
CREATE TABLE ledger_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
DROP TABLE entries;
