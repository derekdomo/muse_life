-- W-HOMEB-002 (effective 2026-11-16): execute the dated Home B slot
-- swap — replace the bench-step-up slot (2 sets) in home_snowboard
-- with lateral-lunge at equal volume. Content migration, same
-- precedent as 0007/0008: it rewrites live plan rows directly and
-- intentionally does NOT create a plan_versions row or history rows
-- (no updatePlan save happens here); affected rows keep their current
-- plan_version, and past sessions keep rendering from their own
-- workout_sets snapshots, so history is untouched.
--
-- Both statements are guarded by exact-match predicates, so the
-- migration is idempotent: if the owner already swapped the slot by
-- hand (or the migration re-runs), zero rows match and nothing
-- changes. The schedule guard matches the post-0008 note text
-- exactly (brackets via char() codes, as in 0008).
UPDATE plan_exercises SET exercise_key = 'lateral-lunge', exercise_name = '侧向弓步', target_reps = '10 每侧' WHERE routine = 'home_snowboard' AND exercise_key = 'bench-step-up';
--> statement-breakpoint
UPDATE plan_schedule SET note = '在家 B · 单板 25 分钟，与腿日隔 48 小时以上；侧向弓步已替换 Bench 登阶（2026-11-16 起生效，侧向弓步→脉冲弓步渐进，等量 2 组），出行周停练' WHERE day_index = 2 AND routine_code = 'home_snowboard' AND note = '在家 B · 单板 25 分钟，与腿日隔 48 小时以上；' || char(12304) || '2026-11-16 起至出行前' || char(12305) || 'Bench 登阶换侧向弓步（侧向弓步→脉冲弓步渐进，等量 2 组），出行周停练';
