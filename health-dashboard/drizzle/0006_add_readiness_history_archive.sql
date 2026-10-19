CREATE TABLE `readiness_history` (
  `date` text PRIMARY KEY NOT NULL,
  `score` real,
  `components` text NOT NULL,
  `confidence` text NOT NULL,
  `snapshot_version` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
