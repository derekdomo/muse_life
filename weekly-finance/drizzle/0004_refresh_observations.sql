CREATE TABLE refresh_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  generation TEXT,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
