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

### Teaching videos for the 9 movements without a demo image (added 2026-10-19, owner-approved)

The 9 guides that have no demo image (see the "Searched and NOT shipped" section below) now carry an outbound 「教学视频」 link in the guide dialog instead, labelled in the UI as an external teaching video （外部教学视频） with the channel named. The 3 text cues of each guide are unchanged. Every link was verified before shipping — the deep-research pass read each YouTube watch page live (title, channel, captions/description, on-screen form), and 8 of the 9 were re-opened and re-checked by the builder; the push-up-plus page returned HTTP 429 on the builder's re-check, so that one rests on the researcher's live watch-page verification. Research directory: `~/workspace/research_notes/space6-teaching-videos-9-exercises-20261020-0605` (report.md + one note per exercise).

- Supine chin tuck (`supine-chin-tuck`): https://www.youtube.com/watch?v=qFEBNu4vwSg — "Supine Chin Tuck", FitLife Fitness, Aquatics and Physical Therapy (0:39). Verified: supine, head flat on the mat/table, no pillow.
- Prone Y-T-W (`prone-ytw`): https://www.youtube.com/watch?v=QdGTI4Lshg4 — "Prone Y T W", The Active Life (0:31). Verified: prone face-down, working through the Y, T and W positions.
- Thoracic extension (`thoracic-extension`): https://www.youtube.com/watch?v=81kPLsMt6wY — "Foam Roller Thoracic Spine Extensions", The Barbell Physio (0:50). Verified: supine over a support at the upper back, hands behind head, hips on the floor. Caveat, stated in the UI source label: this is the foam-roller version of the same extension pattern, not the bench-edge setup — no qualified-channel bench-edge version (supine, butt on floor, hands behind head) could be verified; a bench-edge Short from an unverified channel with bridged-hip form was rejected, as were the kneeling elbows-on-bench mobilisations sold under the same name.
- Single-leg balance taps (`single-leg-balance`): https://www.youtube.com/watch?v=QOUYmI6Snqs — "Balance Exercise: Single Leg Balance + 3 Way Tap", Body Balance Physical Therapy Lakeway (0:40). Verified: Dr. Chonko PT, DPT demonstrates forward, lateral and backward taps while the stance leg stabilises.
- Home Bulgarian split squat (`home-bulgarian-split-squat`): https://www.youtube.com/watch?v=hiLF_pF3EJM — "Stop F*cking Up Bulgarian Split Squats (PROPER FORM!)", ATHLEAN-X / Jeff Cavaliere MSPT, CSCS. Verified: rear foot on bench, front leg does the work, full setup tutorial. The video loads with dumbbells; the home guide holds one plate at the chest — same movement pattern, noted in the UI source label.
- Tibialis raise (`tibialis-raise`): https://www.youtube.com/watch?v=VzIcGAgBiaM — "Tibialis Wall Raises (Exercise Demo)", The Barefoot Sprinter (0:25). Verified: back/hips against the wall, heels on the ground, forefeet lifted toward the shins — the wall version in the guide.
- Wall sit (`wall-sit`): https://www.youtube.com/watch?v=RG7z0P9qrLk — "Wall Sit", E3 Rehab Exercise Library (0:10). Verified: back flat against the wall, knees ~90°, held isometrically.
- Reverse pec deck (`reverse-pec-deck`): https://www.youtube.com/watch?v=5YK4bgzXDp0 — "Machine Reverse Flye", Renaissance Periodization (0:13). Verified: seated facing the pad, chest against it, arms opening backward to the sides for the rear delts — the REVERSE direction, distinct from the same channel's separate forward pec-deck video.
- Push-up plus (`push-up-plus`): https://www.youtube.com/watch?v=huGj4aBk9C4 — "Scapular Push Up", Marcus Filly (Functional Bodybuilding) (0:15). Verified by the research pass on the watch page: high plank, arms completely straight, protraction/retraction only — not a regular bent-elbow push-up. (Corroborating narrated tutorial also checked in research: Precision Movement, https://www.youtube.com/watch?v=fLAf2YG4flw — not linked in the UI; one link per exercise.)

## Exercise demo animations (W6.2, home routines)

Each home-routine exercise guide (Home A posture + Home B snowboard, plus the shared `tibialis-raise`) carries a looping demonstration in its guide dialog, next to the existing 3 text cues:

- Real photo pairs (start/end frames crossfading in a loop), copied into `client/src/assets/` as owned bytes from free-exercise-db (Open Public Domain Exercise Dataset, Unlicense; license text verified in the repo's `LICENSE.md` on 2026-10-19, and each pair visually checked against the movement before use): `side-external-rotation` ← External Rotation 0/1, `bench-step-up` ← Dumbbell Step Ups 0/1, `dead-bug` ← Dead Bug 0/1, `side-plank` ← Side Bridge 0/1.
- Hand-drawn stick-figure SVG (SMIL) looping animations in `client/src/ExerciseDemo.tsx` for the 8 movements the open dataset has no accurate match for: chin tuck, prone Y-T-W, thoracic extension, single-leg balance, Bulgarian split squat, calf raise, tibialis raise, wall sit. The dataset's standing calf-raise photos are a distant machine shot whose ankle motion is unreadable, so the calf raise deliberately uses a figure instead of a near-miss photo.

## Exercise demo animations (gym Push/Pull/Legs completion, 2026-10-19)

Every gym guide now carries a looping demonstration in the same guide dialog, next to its existing 3 text cues and (where present) its verified video link. Home-routine coverage was re-verified complete in source before this slice (all 4 Home A + all 8 Home B keys already had demos), so the plan's 30 distinct exercise keys are now covered 30/30.

- Real photo pairs from the same free-exercise-db source (Unlicense; license text re-verified in the repo's `LICENSE.md` on 2026-10-19), each pair visually checked frame by frame against the plan's version of the movement before copying into `client/src/assets/`: `barbell-bench` ← Barbell Bench Press - Medium Grip 0/1, `incline-dumbbell-press` ← Incline Dumbbell Press 0/1, `dips` ← Parallel Bar Dip 0/1 (both frames fully suspended; the dataset's Chest Version pair starts standing on the machine's steps, so it was not used), `wide-lat-pulldown` ← Wide-Grip Lat Pulldown 0/1, `close-lat-pulldown` ← Underhand Cable Pulldowns 0/1, `close-seated-row` ← Seated Cable Rows 0/1, `face-pull` ← Face Pull 0/1, `rope-curl` ← Cable Hammer Curls - Rope Attachment 0/1, `back-squat` ← Barbell Squat 0/1, `romanian-deadlift` ← Romanian Deadlift 0/1, `lying-leg-curl` ← Lying Leg Curls 0/1, `bulgarian-split-squat` ← Split Squat with Dumbbells 0/1 (that entry is in fact the Bulgarian split squat — rear foot on a bench, dumbbells at the sides; the pair is portrait and renders at a 3/4 aspect ratio instead of the usual 3/2).
- Hand-drawn stick-figure SVG (SMIL) looping animations for the 5 gym movements with no accurate open-dataset match, plus one reuse: standing overhead press (the dataset's barbell shoulder press is seated with back support — a different movement), lateral raise (the dataset pair tops out above shoulder height with a visible shrug, contradicting the guide's shoulder-height cap), wide-grip seated row (no wide-grip seated entry exists; the elevated and rope rear-delt rows are different variants), reverse pec deck (the dataset's Butterfly is the forward pec fly, the exact opposite direction), serratus push-up plus (a regular push-up pair bends the elbows — the plus is a straight-arm scapular movement), and `calf-raise` reusing the home slice's verified calf-raise figure (same step-edge movement).

## AI photorealistic demo pairs — REMOVED (2026-10-19)

The 12 AI-generated photorealistic pairs shipped earlier on 2026-10-19 (`demo-ai-*`, for chin tuck, prone Y-T-W, thoracic extension, single-leg balance, home Bulgarian split squat, tibialis raise, wall sit, standing overhead press, lateral raise, wide-grip seated row, reverse pec deck, push-up plus) were rejected at owner acceptance — several had the movement direction wrong — and have been removed entirely: all 24 `demo-ai-*.jpg` files are deleted from `client/src/assets/` and no code references them. They are replaced by real-video stills where an accurate, cleanly licensed video exists (next section) and by text-only guides where none does. The 16 free-exercise-db real photo pairs are unchanged.

## Real-video still pairs replace the AI pairs (2026-10-19)

Each pair below is two stills extracted with ffmpeg from ONE real demonstration video (same person, same camera), rendered in the guide dialog with the same start ↔ end crossfade loop as the photo pairs, with a caption naming the source. Every candidate video was frame-checked against the guide's setup/cues before use; the extraction timestamps are the verified start/end positions of one repetition.

- Standing overhead press (`overhead-press`) → `demo-video-overhead-press-0/1.jpg`. Source video: "Shoulder press - exercise demonstration video" by FitnessScape, Wikimedia Commons — page: https://commons.wikimedia.org/wiki/File:Shoulder_press_-_exercise_demonstration_video.webm — file as returned by the Commons API: https://upload.wikimedia.org/wikipedia/commons/6/69/Shoulder_press_-_exercise_demonstration_video.webm — License: CC BY 3.0 (per the file's Commons extmetadata, verified 2026-10-19). Standing barbell press, back view. Frames at t=5.5s (bar on the upper chest) and t=6.5s (locked out overhead). Both frames are cropped to the top 1280×496 band of the 1280×720 source to exclude the video's burned-in caption box, which overlaps every true bottom position; the person and the movement are untouched (white-run scan of the shipped frames: no caption remnant).
- Dumbbell lateral raise (`lateral-raise`) → `demo-video-lateral-raise-0/1.jpg`. Source video: Pexels video 5319102, "A Man Working Out Using Dumbbell" — https://www.pexels.com/video/a-man-working-out-using-dumbbell-5319102/ — License: Pexels License (free to use; https://www.pexels.com/license/). Standing front view; frames at t=2s (dumbbells at the sides) and t=3s (arms raised to exactly shoulder height, slight elbow bend, no shrug — matching the guide's shoulder-height cap).
- Wide-grip seated row (`wide-seated-row`) → `demo-video-wide-row-0/1.jpg`. Source video: Pexels video 4367642, "A Man Doing a Seated Cable Row" — https://www.pexels.com/video/a-man-doing-a-seated-cable-row-4367642/ — License: Pexels License (free to use). Seated cable row with a wide curved bar; frames at t=14s (arms extended) and t=24s (bar pulled to the lower ribs, elbows travelling back and slightly out — matching the guide's wide-grip cues, distinct from the narrow V-handle close row).
- Calf raise (`calf-raise` gym + `home-calf-raise` home, one shared pair) → `demo-video-calf-raise-0/1.jpg`. Source video: Pexels video 32115656, "Intense Calf Workout in Gym Setting" — https://www.pexels.com/video/intense-calf-workout-in-gym-setting-32115656/ — License: Pexels License (free to use). Close-up of the lower legs on a step platform, forefoot on the edge; frames at t=11s (heels dropped below the step into the stretch) and t=15s (raised onto the toes), knees straight throughout, both frames cropped identically (1080×1440 from the 1440×2560 source).

### Searched and NOT shipped — text-only guides (owner's accuracy rule)

For the remaining 9 movements no accurate, cleanly licensed real video was found on Pexels, Pixabay or Wikimedia Commons (searched 2026-10-19), so their guides keep text cues only — no AI image, no near-miss:

- Supine chin tuck (`supine-chin-tuck`): stock neck videos are standing/seated side stretches — a different movement.
- Prone Y-T-W (`prone-ytw`): no stock video of the bench prone Y-T-W exists in the searched libraries.
- Thoracic extension (`thoracic-extension`): the guide's version is over a bench edge; the only foam-roller footage found (Pexels 4812851) is a different setup filmed top-down, which cannot show the extension.
- Single-leg balance taps (`single-leg-balance`): stock balance videos are yoga poses, not the three-point tap drill.
- Home Bulgarian split squat (`home-bulgarian-split-squat`): Pexels/Pixabay results for split squat were regular squats, walking lunges and plyometric jumps — no rear-foot-elevated demonstration.
- Tibialis raise (`tibialis-raise`): the guide's version leans against a wall; the one dorsiflexion video found (Pexels 38132743) is a standing band-resisted drill — a different setup.
- Wall sit (`wall-sit`): no wall-sit video exists in the searched libraries.
- Reverse pec deck (`reverse-pec-deck`): the one pec-deck video downloaded and checked second-by-second (Pexels 4921622) is the FORWARD fly — arms closing in front of the chest, the exact opposite direction. Rejected.
- Push-up plus (`push-up-plus`): available push-up videos (e.g. Pexels 4367576) are regular push-ups with bent elbows; the plus is a straight-arm scapular movement, so they would teach the guide's own listed mistake. Rejected.
- Lateral lunge (`lateral-lunge`, added 2026-10-24, W-HOMEB-001): text-only guide prepared ahead of the dated Home B swap — from 2026-11-16 until the first snowboard trip it takes the `bench-step-up` slot at equal volume (2 sets), progressing bodyweight lateral lunge → pulse lunge over three weeks. No demo image, no generated imagery, no video link: no verified real demonstration was sourced for this movement, so it ships text cues only under the same accuracy rule as the 9 above. The stored plan itself is unchanged until the window opens — the swap exists only as the dated annotation appended to the day-2 (`home_snowboard`) schedule note by migration 0007, mirrored in `DEFAULT_PLAN_SCHEDULE`.

Also rejected while sourcing the four shipped pairs: seated dumbbell/machine presses (Pexels 4367541, 29569376, 7187395; CDC Commons machine press) for the standing barbell press; a standing dumbbell press (Pexels 5837705, cropped close-up, wrong implement for a barbell guide); biceps-curl videos surfaced under "lateral raise" (Pexels 6326722, 16368952); an outdoor resistance-band row (Pexels 6022753) for the cable row; and a distant calf-machine video with a water-drinking break (Pexels 10315443) in favour of the close-up step video above.

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

## Muscle diagram (W6.2, added 2026-10-20)

The guide dialog's front/back muscle diagram is hand-drawn SVG line
art authored in `client/src/MuscleDiagram.tsx` — no external or
generated imagery, no fetched data. Painting derives ONLY from the
exercise's existing `MUSCLE_MAP` entry (MUSCLE-MAP.md v1 primary /
secondary muscle names) via the anatomical placement table
`MUSCLE_NAME_REGIONS` in the same file: a name with no region entry
is never painted or guessed, and an unmapped exercise key renders
the text state 暂无肌群图 while keeping its demo and cues. Primary =
solid Okabe-Ito vermillion fill, secondary = Okabe-Ito blue diagonal
hatch + outline, always with a text legend （主要/次要 + names), so
meaning never rides on colour alone. Verified by
`validate-muscle-diagram.mjs` (23 checks: name/region coverage for
all 30 exercises, shared-region primary-wins overlap, unknown
key/name handling, front-only and back-only exercises).
