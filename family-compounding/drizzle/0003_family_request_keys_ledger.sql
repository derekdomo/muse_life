CREATE TABLE family_request_keys (
  request_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  activity_id INTEGER,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
