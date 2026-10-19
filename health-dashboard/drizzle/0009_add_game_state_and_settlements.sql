CREATE TABLE `game_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`total_xp` integer DEFAULT 0 NOT NULL,
	`settled_through_date` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_settlements` (
	`local_date` text NOT NULL,
	`category` text NOT NULL,
	`xp` integer NOT NULL,
	`rule_version` integer NOT NULL,
	`source_date` text NOT NULL,
	`source_updated_at` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `game_settlements_local_date_category_pk` PRIMARY KEY(`local_date`, `category`)
);
