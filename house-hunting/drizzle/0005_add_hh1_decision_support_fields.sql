ALTER TABLE reports ADD COLUMN rate_as_of TEXT;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN school_source TEXT;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN school_as_of TEXT;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN prev_price INTEGER;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN prev_status TEXT;
--> statement-breakpoint
CREATE TABLE listing_user_states (
  stable_key TEXT PRIMARY KEY,
  decision TEXT,
  updated_at INTEGER NOT NULL
);
