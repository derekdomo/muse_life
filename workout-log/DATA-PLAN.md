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

## Weekly recommendation logic

- The review uses the viewer's current calendar week (Monday through now) and the stored completed workouts.
- It reports only recorded session and completed-set counts.
- The next-week adjustment is deliberately conservative: retain the existing compound movements and add one unilateral leg exercise (Bulgarian split squat, 3 × 8–10) because the previous leg template contained bilateral squat, hip hinge, and hamstring isolation but no unilateral knee-dominant work.
