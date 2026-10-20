DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  next_milestone TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE project_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE progress_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
