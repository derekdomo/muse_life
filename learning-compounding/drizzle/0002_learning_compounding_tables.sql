CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE learning_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  source_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  skill_id INTEGER REFERENCES skills(id),
  minutes INTEGER NOT NULL DEFAULT 0,
  converted_at INTEGER,
  output_type TEXT,
  output_note TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX learning_inputs_date_idx ON learning_inputs (date);
--> statement-breakpoint
CREATE INDEX learning_inputs_skill_idx ON learning_inputs (skill_id);
