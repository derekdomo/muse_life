CREATE TABLE `game_rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_reward_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`reward_id` integer NOT NULL,
	`reward_name` text NOT NULL,
	`reward_price` integer NOT NULL,
	`reward_revision` integer NOT NULL,
	`balance_version` integer NOT NULL,
	`gold_spent` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`local_date` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_reward_redemptions_request_id_unique` ON `game_reward_redemptions` (`request_id`);
