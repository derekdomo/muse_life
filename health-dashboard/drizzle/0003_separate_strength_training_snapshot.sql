CREATE TABLE `strength_training_snapshot` (
  `id` integer PRIMARY KEY NOT NULL,
  `payload` text NOT NULL,
  `source_updated_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `strength_training_snapshot` (`id`, `payload`, `source_updated_at`, `created_at`, `updated_at`)
SELECT 1, json_extract(`payload`, '$.strengthTraining'), `updated_at`, `created_at`, `updated_at`
FROM `health_snapshot`
WHERE `id` = 1
  AND json_valid(`payload`) = 1
  AND json_type(`payload`, '$.strengthTraining') = 'object';
