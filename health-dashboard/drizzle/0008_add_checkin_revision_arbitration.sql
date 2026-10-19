ALTER TABLE `morning_checkin` ADD COLUMN `revision` integer;
--> statement-breakpoint
ALTER TABLE `readiness_history` ADD COLUMN `checkin_revision` integer;
