CREATE TABLE tx_category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  normalized_merchant TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE tx_review_rows (
  txn_id TEXT PRIMARY KEY NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  merchant_name TEXT,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
