ALTER TABLE refresh_state ADD COLUMN generation TEXT;
--> statement-breakpoint
ALTER TABLE refresh_state ADD COLUMN claimed_generation TEXT;
--> statement-breakpoint
ALTER TABLE refresh_state ADD COLUMN published_report_id INTEGER;
--> statement-breakpoint
ALTER TABLE reports ADD COLUMN published INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE reports SET published = 1 WHERE id = (SELECT MAX(id) FROM reports);
--> statement-breakpoint
UPDATE refresh_state SET published_report_id = (SELECT MAX(id) FROM reports) WHERE published_report_id IS NULL;
