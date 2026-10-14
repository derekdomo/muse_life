DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of TEXT NOT NULL,
  mortgage_rate REAL NOT NULL,
  rate_label TEXT NOT NULL,
  rate_source TEXT NOT NULL,
  rate_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  score INTEGER NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  url TEXT NOT NULL,
  price INTEGER NOT NULL,
  bedrooms INTEGER NOT NULL,
  bathrooms REAL NOT NULL,
  sqft INTEGER NOT NULL,
  lot_sqft INTEGER,
  year_built INTEGER,
  days_on_market INTEGER,
  price_per_sqft INTEGER,
  price_change INTEGER,
  hoa_monthly INTEGER,
  status TEXT NOT NULL,
  school_summary TEXT NOT NULL,
  environment_summary TEXT NOT NULL,
  condition_summary TEXT NOT NULL,
  verdict TEXT NOT NULL,
  caution TEXT
);
--> statement-breakpoint
CREATE INDEX listings_report_rank_idx ON listings(report_id, rank);
--> statement-breakpoint
CREATE TABLE refresh_state (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  task_id TEXT,
  message TEXT,
  updated_at INTEGER NOT NULL
);
