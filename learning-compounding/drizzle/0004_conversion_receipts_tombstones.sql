CREATE TABLE conversion_receipts (
  request_id TEXT PRIMARY KEY,
  input_id INTEGER NOT NULL REFERENCES learning_inputs(id),
  payload_hash TEXT NOT NULL,
  converted_at INTEGER NOT NULL,
  output_type TEXT NOT NULL,
  output_note TEXT,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX conversion_receipts_input_idx ON conversion_receipts (input_id);
