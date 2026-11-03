-- W4.2: single-row cache for the readiness tip synced from 健康看板 (space-4).
-- Additive: pure CREATE TABLE, no ALTER/DROP. One row (id = 1) holds the
-- latest tip; payload is the JSON tip, source_read_started_at is the
-- version (the instant the space-4 read began, L1-RACE-001 contract).
CREATE TABLE readiness_tip_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  source_read_started_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
