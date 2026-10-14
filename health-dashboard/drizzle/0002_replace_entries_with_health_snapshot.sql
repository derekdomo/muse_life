CREATE TABLE health_snapshot (
  id INTEGER PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
DROP TABLE entries;
