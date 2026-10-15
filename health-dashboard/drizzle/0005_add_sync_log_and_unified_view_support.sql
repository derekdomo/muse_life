CREATE TABLE `sync_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source` text NOT NULL,
  `status` text NOT NULL,
  `item_count` integer NOT NULL,
  `note` text NOT NULL,
  `source_updated_at` integer,
  `created_at` integer NOT NULL
);
