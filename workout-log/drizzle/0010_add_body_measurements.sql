CREATE TABLE body_measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measured_at TEXT NOT NULL,
  body_weight REAL NOT NULL,
  weight_unit TEXT NOT NULL DEFAULT 'lb' CHECK (weight_unit IN ('lb', 'kg')),
  waist REAL,
  chest REAL,
  hips REAL,
  arm REAL,
  thigh REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX body_measurements_measured_at_idx ON body_measurements(measured_at);
