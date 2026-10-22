ALTER TABLE books ADD COLUMN import_frozen_manifest TEXT;
--> statement-breakpoint
ALTER TABLE books ADD COLUMN live_gen TEXT;
--> statement-breakpoint
ALTER TABLE snippets ADD COLUMN live_gen TEXT;
