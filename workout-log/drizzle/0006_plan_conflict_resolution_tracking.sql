-- W-PLAN-SAFE-001 follow-up (conflict visibility + owner resolution):
-- purely additive tracking columns on the plan_exercise_conflicts
-- archive table created by 0005. 0005 itself is NOT re-run or edited:
-- databases that already applied it (journal contains 0005) receive
-- only this file, and databases still on 0001-0004 run 0005 first and
-- then this file in the same upgrade — both classes converge to the
-- same schema and the same behaviour.
--   archived_at            — when the row entered the archive.
--                            0005 recorded no timestamp, so rows it
--                            archived are backfilled below with this
--                            migration's own run time (the moment the
--                            conflict becomes visible/trackable); the
--                            value is never presented as the original
--                            0005 archival instant.
--   resolved_at            — NULL while the conflict is unconfirmed;
--                            set when the owner resolves the group.
--   resolution               — 'selected' on the archive row the owner
--                            picked, 'superseded' on every other row
--                            closed by the same decision.
--   resolution_selected_id — the id of the candidate the owner chose
--                            (the live plan_exercises row id when the
--                            currently displayed copy was confirmed,
--                            otherwise the chosen archive row id).
-- A conflict group (routine, exercise_key) is unconfirmed exactly
-- while at least one of its archive rows has resolved_at IS NULL.
-- The CREATE TABLE IF NOT EXISTS below is normally a no-op (0005
-- created the archive); it only fires on a database whose journal
-- records 0005 as applied while the archive table itself is absent,
-- recreating it empty (an empty archive = no conflicts to surface)
-- so the ALTERs below cannot fail on the missing table.
CREATE TABLE IF NOT EXISTS plan_exercise_conflicts (
  id INTEGER PRIMARY KEY,
  routine TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  sets INTEGER NOT NULL,
  target_reps TEXT NOT NULL,
  archived_note TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE plan_exercise_conflicts ADD COLUMN archived_at INTEGER;
--> statement-breakpoint
ALTER TABLE plan_exercise_conflicts ADD COLUMN resolved_at INTEGER;
--> statement-breakpoint
ALTER TABLE plan_exercise_conflicts ADD COLUMN resolution TEXT;
--> statement-breakpoint
ALTER TABLE plan_exercise_conflicts ADD COLUMN resolution_selected_id INTEGER;
--> statement-breakpoint
UPDATE plan_exercise_conflicts
SET archived_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE archived_at IS NULL;
