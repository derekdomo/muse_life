CREATE TABLE learning_inputs_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  source_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  skill_id INTEGER REFERENCES skills(id),
  minutes INTEGER,
  converted_at INTEGER,
  output_type TEXT,
  output_note TEXT,
  attempt_started_at INTEGER,
  conversion_request_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO learning_inputs_v2 (id, date, source_type, topic, skill_id, minutes, converted_at, output_type, output_note, created_at)
SELECT id, date, source_type, topic, skill_id, minutes, converted_at, output_type, output_note, created_at FROM learning_inputs;
--> statement-breakpoint
DROP TABLE learning_inputs;
--> statement-breakpoint
ALTER TABLE learning_inputs_v2 RENAME TO learning_inputs;
--> statement-breakpoint
CREATE INDEX learning_inputs_date_idx ON learning_inputs (date);
--> statement-breakpoint
CREATE INDEX learning_inputs_skill_idx ON learning_inputs (skill_id);
