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

## Exercise demo animations (W6.2, home routines)

Each home-routine exercise guide (Home A posture + Home B snowboard, plus the shared `tibialis-raise`) carries a looping demonstration in its guide dialog, next to the existing 3 text cues:

- Real photo pairs (start/end frames crossfading in a loop), copied into `client/src/assets/` as owned bytes from free-exercise-db (Open Public Domain Exercise Dataset, Unlicense; license text verified in the repo's `LICENSE.md` on 2026-10-19, and each pair visually checked against the movement before use): `side-external-rotation` ← External Rotation 0/1, `bench-step-up` ← Dumbbell Step Ups 0/1, `dead-bug` ← Dead Bug 0/1, `side-plank` ← Side Bridge 0/1.
- Hand-drawn stick-figure SVG (SMIL) looping animations in `client/src/ExerciseDemo.tsx` for the 8 movements the open dataset has no accurate match for: chin tuck, prone Y-T-W, thoracic extension, single-leg balance, Bulgarian split squat, calf raise, tibialis raise, wall sit. The dataset's standing calf-raise photos are a distant machine shot whose ankle motion is unreadable, so the calf raise deliberately uses a figure instead of a near-miss photo.

## Exercise demo animations (gym Push/Pull/Legs completion, 2026-10-19)

Every gym guide now carries a looping demonstration in the same guide dialog, next to its existing 3 text cues and (where present) its verified video link. Home-routine coverage was re-verified complete in source before this slice (all 4 Home A + all 8 Home B keys already had demos), so the plan's 30 distinct exercise keys are now covered 30/30.

- Real photo pairs from the same free-exercise-db source (Unlicense; license text re-verified in the repo's `LICENSE.md` on 2026-10-19), each pair visually checked frame by frame against the plan's version of the movement before copying into `client/src/assets/`: `barbell-bench` ← Barbell Bench Press - Medium Grip 0/1, `incline-dumbbell-press` ← Incline Dumbbell Press 0/1, `dips` ← Parallel Bar Dip 0/1 (both frames fully suspended; the dataset's Chest Version pair starts standing on the machine's steps, so it was not used), `wide-lat-pulldown` ← Wide-Grip Lat Pulldown 0/1, `close-lat-pulldown` ← Underhand Cable Pulldowns 0/1, `close-seated-row` ← Seated Cable Rows 0/1, `face-pull` ← Face Pull 0/1, `rope-curl` ← Cable Hammer Curls - Rope Attachment 0/1, `back-squat` ← Barbell Squat 0/1, `romanian-deadlift` ← Romanian Deadlift 0/1, `lying-leg-curl` ← Lying Leg Curls 0/1, `bulgarian-split-squat` ← Split Squat with Dumbbells 0/1 (that entry is in fact the Bulgarian split squat — rear foot on a bench, dumbbells at the sides; the pair is portrait and renders at a 3/4 aspect ratio instead of the usual 3/2).
- Hand-drawn stick-figure SVG (SMIL) looping animations for the 5 gym movements with no accurate open-dataset match, plus one reuse: standing overhead press (the dataset's barbell shoulder press is seated with back support — a different movement), lateral raise (the dataset pair tops out above shoulder height with a visible shrug, contradicting the guide's shoulder-height cap), wide-grip seated row (no wide-grip seated entry exists; the elevated and rope rear-delt rows are different variants), reverse pec deck (the dataset's Butterfly is the forward pec fly, the exact opposite direction), serratus push-up plus (a regular push-up pair bends the elbows — the plus is a straight-arm scapular movement), and `calf-raise` reusing the home slice's verified calf-raise figure (same step-edge movement).

## AI photorealistic demo pairs replace the stick figures (2026-10-19)

At the owner's direction, every movement that previously used a hand-drawn stick-figure SVG animation in `client/src/ExerciseDemo.tsx` was re-done as an AI-generated photorealistic start/end pair (same generated person — an athletic East Asian man in his mid-30s, dark charcoal t-shirt and black shorts — same clothing, camera and setting within each pair), rendered in the guide dialog with the same crossfade loop and an explicit "AI 生成真人风示范图 · 已逐帧按动作要点核对" caption. Each pair was generated as a single diptych, reviewed frame by frame against the guide's cues (joint angles, body alignment, bench/equipment use), and only then split into `demo-ai-<movement>-0/1.jpg` owned bytes in `client/src/assets/`.

- Shipped (12 movements, Home A/Home B first): chin tuck (`supine-chin-tuck`), prone Y-T-W (`prone-ytw`; the pair shows Y ↔ W, with T noted in the caption as the midpoint), thoracic extension, single-leg balance, home Bulgarian split squat (`home-bulgarian-split-squat`), tibialis raise, wall sit, standing overhead press, lateral raise, wide-grip seated row (`wide-seated-row`), reverse pec deck, serratus push-up plus (`push-up-plus`).
- Rejected in review and regenerated: prone Y-T-W v1 (body orientation inverted), home Bulgarian split squat v1 (rear foot left the bench and the rear knee touched the floor in the bottom frame), overhead press v1–v2 (bar behind the neck like a squat instead of at the upper chest; the shipped pair is the side-view v3).
- NOT shipped — calf raise (`calf-raise` gym + `home-calf-raise` home share the movement): 4 consecutive generations each failed frame review (v1 left frame's feet off the step entirely, v2 no heel-drop stretch plus an extra shoe artifact under the step, v3 visibly bent knees in the top frame, v4 feet floating above the step in the top frame). Per the owner's accuracy rule, both calf-raise guides now show text cues only — no image — rather than a wrong demonstration. All rejected generation files were deleted; only the split frames of shipped pairs remain in `client/src/assets/`.
- The 16 free-exercise-db real photo pairs are unchanged.

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
