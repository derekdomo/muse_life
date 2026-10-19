# Data Plan

## User-owned training data

- Source: entries created through the artifact's workout actions and stored in `app.db`.
- Used for: active workout state, set completion, weight/repetition history, progression prefill, recent history, and the calendar-week review.
- Refresh: queries invalidate immediately after each mutation.
- Empty state: the artifact asks the user to complete a first workout and does not invent history.

## Cross-artifact sync read

- Consumer: 健康看板 (space-4) refreshes its strength summary by spawning a task that reads this artifact's published `getDashboard` action (`recent_limit` 20) and saves the derived summary into its own snapshot.
- Access rule: that sync invocation travels the daemon's internal action channel and carries no browser viewer, so `getDashboard` accepts the owner or a no-viewer internal invocation. Any invocation carrying a non-owner viewer still returns `forbidden` with zero data, and all write actions remain strictly owner-only.

## Completion receipt read-back (W4.3-D1)

- `getDashboard` accepts an additive optional argument `receipt_workout_id`. When present, the response additionally carries `receipt` (that exact completed workout, read back by id — never a "most recent" substitute; null when the id is unknown or not completed) and `receipt_previous` (per exercise of that workout, the most recent earlier completed workout of the same routine containing the same exercise key, with its completed/total set counts and completion time).
- Compatibility: both fields are optional and omitted entirely when the argument is absent, so existing consumers (including the 健康看板 sync above, which passes only `recent_limit`) receive byte-identical responses and may ignore the new fields. The read runs under the same owner / sync-channel gate as the rest of `getDashboard`; no write action changes.

## Curated technique videos

The exercise-guide dialogs contain original short form cues plus outbound links to public human-demonstration videos. The artifact does not fetch or embed these videos, and no external data is loaded when the page opens.

- Barbell bench press: https://www.youtube.com/watch?v=CjHIKDQ4RQo
- Standing overhead press: https://www.youtube.com/watch?v=EK511FpyDEg
- Incline dumbbell press: https://www.youtube.com/watch?v=oZVCBM9f8Eo
- Chest dips: https://www.youtube.com/watch?v=2HYAeF6o7Bc
- Dumbbell lateral raise: https://www.youtube.com/watch?v=z-kOn7flIZg
- Wide-grip lat pulldown: https://www.youtube.com/shorts/UAlGHwshYBM
- Underhand lat pulldown: https://www.youtube.com/watch?v=UkgDc61gRcM
- Close seated cable row: https://www.youtube.com/watch?v=O9nVMz5osqY
- Wide versus close seated cable row: https://www.youtube.com/shorts/mJLT0tChvFM
- Seated cable face pull: https://www.youtube.com/watch?v=4UhV4cCkugM
- Cable rope curl: https://www.youtube.com/watch?v=dLRVpRC4L3Y
- Squat technique: https://www.youtube.com/watch?v=nEQQle9-0NA
- Romanian deadlift: https://www.youtube.com/watch?v=aa57T45iFSE
- Bulgarian split squat: https://www.youtube.com/watch?v=DeCnHqrN22U
- Lying leg curl: https://www.youtube.com/shorts/tLyA9uXn5Wo

## Editable training plan (2026-10-18 frequency sync)

- Source: persisted plan rows in `app.db` — `plan_exercises` (per-routine ordered templates), `plan_schedule` (Monday–Sunday assignment), `plan_daily_items` (daily posture micro-routine), `daily_completions` (per-day checklist state, keyed by America/Los_Angeles date).
- Seeding: `ensurePlanSeeded` in `server/src/actions.ts` fills any empty plan table from `DEFAULT_PLAN_TEMPLATES` / `DEFAULT_PLAN_SCHEDULE` / `DEFAULT_DAILY_ITEMS` (the user-approved 2026-10-18 frequency design: gym Push/Pull/Legs heavy 3x, Home A posture 2x/week, Home B snowboard 1x/week ≥48h from leg day, swim 1–2x, daily 5-minute posture micro-routine; taper in the early-December snowboard-trip week is guidance text, not automation).
- `startWorkout` builds sets from the stored template for all five routines (`push`, `pull`, `legs`, `home_posture`, `home_snowboard`); prefill/progression and comparable-history behavior is unchanged.
- `getPlan` / `updatePlan` / `toggleDailyItem` are additive actions; `getDashboard` keeps its prior response shape (existing fields unchanged) so the 健康看板 sync consumer is unaffected. Daily checklist state never gates workout start/finish.
- Upgrade-conflict visibility (W-PLAN-SAFE-001 follow-up): migration 0005 archived duplicate `(routine, exercise_key)` plan rows into `plan_exercise_conflicts` instead of dropping them. Migration 0006 (purely additive; 0005 is never re-run) adds tracking columns (`archived_at`, `resolved_at`, `resolution`, `resolution_selected_id`). While any archive group is unconfirmed, `getPlan` additively exposes `conflicts` / `conflict_count` (routine, exercise key, total candidate count, archive stamp, and every candidate's plan fields — the live copy plus each archived copy); with no unconfirmed conflict both fields are omitted and the response is unchanged. The owner-only `resolvePlanConflict` action closes a group atomically: confirming the live copy, or restoring an archived copy under its original row id (the displaced live copy is archived already-resolved, so no candidate is lost), stamping every row of the group with the chosen row id and the resolution time.
- Concurrency tails (W-PLAN-SAFE-001 P0, 2026-10-19): (1) `getPlan`'s version-bracketed read is bounded at 5 attempts (`PLAN_READ_MAX_ATTEMPTS`); exhaustion returns a typed retryable `read_error` with NO plan body — never a successful response mixing two saves' tables. The client keeps its last good plan/draft on `read_error` and offers a retry. (2) Conflict candidates carry their row `id` and the conflict's `plan_version`; `resolvePlanConflict` requires them back as `expected_candidate_ids` / `expected_plan_version` — both fields must arrive with the request (the version may be null when no token row existed at display time, but must otherwise be a non-negative integer decimal string, and the ids a non-empty integer array). A request missing or malforming either field — an older unbound client above all — gets the typed `outcome: "stale"` rejection before any database write: it fails safe and can never claim a version it never saw. A mismatched binding is the same typed stale failure with zero writes. Inside the decision batch, the FIRST statement is an atomic claim that stamps the still-unresolved group with a decision marker only while the plan version token still equals the bound version; the SECOND statement is the version advance, itself guarded on that claim marker, and every decision statement is guarded on it too — so a claim that stamps zero rows (a save or rival decision landed first) makes the whole batch write zero rows: no version change, no decision writes, and no compensating write afterwards. The winner's rows are never reset by a loser. A repeated identical decision answers `outcome: "already_resolved"` (ok), a different decision against a closed group stays an error. The L0.1 exception is untouched: `getDashboard`'s viewer-less read-only sync channel behaves exactly as before.

## Weekly recommendation logic

- The review uses the viewer's current calendar week (Monday through now) and the stored completed workouts.
- It reports only recorded session and completed-set counts.
- The next-week adjustment is deliberately conservative: retain the existing compound movements and add one unilateral leg exercise (Bulgarian split squat, 3 × 8–10) because the previous leg template contained bilateral squat, hip hinge, and hamstring isolation but no unilateral knee-dominant work.
