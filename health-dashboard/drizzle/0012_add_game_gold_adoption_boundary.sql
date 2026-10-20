ALTER TABLE `game_state` ADD COLUMN `gold_adoption_boundary` integer;
--> statement-breakpoint
UPDATE `game_state` SET `gold_adoption_boundary` = `updated_at` WHERE `gold_initialized` = 1 AND `gold_ledger_sum` IS NULL AND `gold_adoption_boundary` IS NULL;
