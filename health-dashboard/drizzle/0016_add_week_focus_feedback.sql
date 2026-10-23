CREATE TABLE `week_focus_feedback` (
	`focus_key` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`focus_text` text NOT NULL,
	`basis_text` text NOT NULL,
	`rule_version` integer NOT NULL,
	`snapshot_version` text NOT NULL,
	`feedback` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
