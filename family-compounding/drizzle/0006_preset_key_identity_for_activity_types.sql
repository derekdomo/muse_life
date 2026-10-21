DROP INDEX IF EXISTS activity_types_name_idx;
--> statement-breakpoint
ALTER TABLE activity_types ADD COLUMN preset_key TEXT;
--> statement-breakpoint
UPDATE activity_types
SET preset_key = name
WHERE is_preset = 1
  AND preset_key IS NULL
  AND id = (
    SELECT MIN(id) FROM activity_types AS earliest
    WHERE earliest.name = activity_types.name AND earliest.is_preset = 1
  );
--> statement-breakpoint
CREATE UNIQUE INDEX activity_types_preset_key_idx ON activity_types (preset_key);
