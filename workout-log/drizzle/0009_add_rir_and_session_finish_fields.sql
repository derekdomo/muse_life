ALTER TABLE `workout_sets` ADD COLUMN `rir` integer;
--> statement-breakpoint
ALTER TABLE `workouts` ADD COLUMN `session_rpe` integer;
--> statement-breakpoint
ALTER TABLE `workouts` ADD COLUMN `pain_flags` text;
--> statement-breakpoint
ALTER TABLE `workouts` ADD COLUMN `session_notes` text;
