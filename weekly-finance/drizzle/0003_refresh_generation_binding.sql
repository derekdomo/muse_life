ALTER TABLE finance_state ADD COLUMN generation TEXT;
--> statement-breakpoint
ALTER TABLE finance_state ADD COLUMN claimed_generation TEXT;
--> statement-breakpoint
ALTER TABLE finance_state ADD COLUMN started_at INTEGER;
