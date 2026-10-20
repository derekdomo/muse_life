ALTER TABLE `game_state` ADD COLUMN `gold` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `game_state` ADD COLUMN `gold_initialized` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `game_state` ADD COLUMN `attrs_json` text;
--> statement-breakpoint
ALTER TABLE `game_state` ADD COLUMN `attr_points_earned` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `game_state` ADD COLUMN `equipment_json` text;
--> statement-breakpoint
CREATE TABLE `game_settlements_new` (
	`local_date` text NOT NULL,
	`category` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`xp` integer NOT NULL,
	`gold` integer DEFAULT 0 NOT NULL,
	`rule_version` integer NOT NULL,
	`source_date` text NOT NULL,
	`source_updated_at` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `game_settlements_local_date_category_detail_pk` PRIMARY KEY(`local_date`, `category`, `detail`)
);
--> statement-breakpoint
INSERT INTO `game_settlements_new` (`local_date`, `category`, `detail`, `xp`, `gold`, `rule_version`, `source_date`, `source_updated_at`, `created_at`)
SELECT `local_date`, `category`, '', `xp`, 0, `rule_version`, `source_date`, `source_updated_at`, `created_at` FROM `game_settlements`;
--> statement-breakpoint
DROP TABLE `game_settlements`;
--> statement-breakpoint
ALTER TABLE `game_settlements_new` RENAME TO `game_settlements`;
