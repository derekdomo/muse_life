# Data Plan

## Context provenance
- `我需要一个daily update的health dashboard` (current user request; establishes a daily-refreshed personal health overview)
- Parent handoff supplied a real Apple HealthKit snapshot pulled 2026-10-02 12:12 PDT for data date 2026-10-01, including baselines, 7-day trends, last-night sleep, and workout count. (AUDIT-03 / L0.4, 2026-10-13: these values were originally embedded in `server/src/actions.ts` as `INITIAL_*` seed constants; they have been removed from the source. The snapshot now lives only in the database like any synced snapshot, and a database without a snapshot shows the honest empty state until the first real HealthKit sync.)
- Parent handoff requires Simplified Chinese, daily silent refresh, KPI status chips, 7-day step/resting-HR/HRV charts, sleep staging, missing-data treatment, and a medical-reference footer.
- `Health baseline from about two weeks of iPhone health data ... ~4,000 steps/day, resting heart rate ~65, HRV ~40ms, sleep 6.5-7h per night, twice-weekly swimming` (standing user context directly relevant to comparison ranges).

## Tested sources
### Apple HealthKit via `health-cli`
**Used by**: `refreshHealthData` agent task, `saveHealthSnapshot`, `getDashboard` (`initializeSnapshot` no longer writes anything; it never seeds data)
**Test command**: `health-cli query metrics --provider healthkit --start-date 2026-09-25 --end-date 2026-10-01 --fields step_count,resting_hr_average_bpm,heart_rate_variability_ms,hr_average_bpm,active_energy_burned_kcal,distance_walking_running_meters`
**Sample output**: coverage.complete=true; daily records included steps 3203, 4661, 6320, 7353, 5576, 7889, 1579 for 9/25–10/01; 9/25 resting HR absent; 10/01 resting HR and HRV absent; 10/01 distance 1056.48m.
**Processing**: use the latest completed calendar day as the daily metric date; retain nullable HR/HRV and render them as `数据缺失`, not anomalies; preserve the source coverage flag.

**Test command**: `health-cli query metrics --provider healthkit --start-date 2026-09-26 --end-date 2026-10-02 --fields step_count,resting_hr_average_bpm,heart_rate_variability_ms,hr_average_bpm,active_energy_burned_kcal,distance_walking_running_meters`
**Sample output**: coverage.complete=false because current day 2026-10-02 had not fully synced; 10/02 partial morning record had HRV 61.44ms and average HR 61.84bpm.
**Processing**: never treat the current partial day as a complete daily metric; show the available 10/02 HRV and average HR only as `今晨参考`; when any refresh query reports incomplete coverage, label the refresh `数据同步不完整` while preserving available values.

**Test command**: `health-cli query sessions --provider healthkit --category sleep --start-date 2026-10-01 --end-date 2026-10-02`
**Sample output**: one session, 2026-10-02 01:02:18→07:40:20 America/Los_Angeles; core 12555.43s, deep 3356.14s, REM 7940.84s, awake 29.97s, quality 67, efficiency 99.9, awakenings 1; coverage.complete=false because 10/02 was not fully synced.
**Processing**: match the last overnight session ending after the latest complete day; convert stage seconds to hours/minutes; retain timezone and format bedtime/wake time locally.

**Test command**: `health-cli query sessions --provider healthkit --category workout --start-date 2026-09-26 --end-date 2026-10-02`
**Sample output**: records=[]; coverage.complete=false because the current day was not fully synced.
**Processing**: count sessions for the trailing 7 completed days only; present zero as `本周 0 次`, distinct from an unavailable query.

## Agent-task sources
### Daily HealthKit refresh
**Delivered by**: `refreshHealthData` spawns one background agent task with an `expectsAction` callback to `saveHealthSnapshot`
**Checked with**: the direct `health-cli` probes above establish command syntax, field names, result shape, missing-data behavior, and the current account’s useful data. The runtime agent callback itself requires a built artifact and will be verified after build by invoking the published refresh action and checking its durable result.

## Image slots
Imagery not needed: the requested subject is the user’s quantitative health record, best served by deterministic charts, stage bars, and status marks rather than decorative or representational imagery.

## Access control (AUDIT-02 / L0.1, 2026-10-13)
- Every action — reads (`getDashboard`), writes (`saveMorningCheckin`), initialization (`initializeSnapshot`), refresh (`refreshHealthData`), and the agent callbacks (`saveHealthSnapshot`, `saveStrengthTrainingSnapshot`) — verifies `ctx.viewer?.isOwner === true` on the server before touching the database. A missing viewer counts as unauthorized.
- Unauthorized calls return a stable typed state (`forbidden: true` with null/empty payload, or `ok: false` for mutations) and never return health data or perform writes.

## Long-term data behavior
- **Refresh policy**: a silent artifact-owned daily schedule calls `refreshHealthData`; the action asks an agent to query the latest complete day, last night’s sleep, morning reference, 7-day trends, and workouts using `health-cli --provider healthkit`, then calls `saveHealthSnapshot` with validated structured data.
- **Growth**: each refresh upserts the current snapshot and replaces the bounded 7-day trend rows; no synthetic history is generated.
- **Ordering**: trend rows ascending by date; dashboard highlights the latest complete day and the latest overnight sleep session.
- **Time semantics**: daily metrics use America/Los_Angeles calendar dates; sleep retains its source timezone; update timestamps are stored as instants and rendered in the viewer’s locale.
- **Coverage**: any `coverage.complete=false` from the queried windows sets a visible `数据同步不完整` flag while still showing available records.

## Unified 30-day history (merged 2026-10-05)
- The existing `health-cli --provider healthkit` refresh now widens its completed-day window to 30 days and adds `body_mass_average`, `apple_exercise_time_sum`, and `distance_swimming_sum` to the daily query.
- The same refresh retrieves workout sessions for the same 30-day window and the latest 14 sleep sessions; it does not introduce another source or a second refresh path.
- (Removed 2026-10-13, AUDIT-03 / L0.4) The former initial-history fallback embedded those source-backed rows (27 daily rows from 2026-09-05 through 2026-10-01, four HealthKit swimming workouts, three real weigh-ins, and seven sleep sessions) as `INITIAL_*` constants in server source. They are deleted; stored records missing history fields now fall back to empty arrays, and a database without a snapshot renders the empty state with a HealthKit sync action.
- **Chart encoding**: steps and active energy are rendered in separate charts. Activity energy and exercise minutes use distinct labeled left/right axes; resting heart rate and HRV also use distinct labeled axes. Missing values remain gaps.
- **History views**: swimming rows show date, distance, duration, average heart rate, and energy; weight rows show only real weigh-ins; sleep rows show date, start/end, duration, and source quality.

## Strength-training aggregation (added 2026-10-08)
- **Source**: the user's separate `训练记录` web artifact (`space-6`) through its published `getDashboard` action; this dashboard reads its active workout and latest 20 completed workouts but does not duplicate its training-entry interface.
- The existing daily/manual refresh action also starts one bounded synchronization task for `训练记录`. That task calls `saveStrengthTrainingSnapshot`, which merges only the strength-training branch into the current HealthKit snapshot so the two sources cannot overwrite each other.
- Every workout preserves its routine, unit, timestamps, completion state, completed sets, weights, repetitions, and exercise names. Total volume is calculated only from completed sets with both weight and repetitions as `weight × reps`; missing values stay missing rather than becoming zero-volume work.
- HealthKit and strength-training snapshots are persisted independently and merged only when read. This prevents the two asynchronous refresh callbacks from racing and overwriting a newly synchronized strength session with an older HealthKit payload. Existing embedded strength data is migrated into the dedicated snapshot table.
- **Timeliness fix (2026-10-14)**: strength data is local to the sibling artifact, so it no longer waits for the daily HealthKit cadence. (a) A dedicated `refreshStrengthTraining` action spawns only the strength sync, and the strength panel has its own 同步训练 button plus its own 更新于 timestamp (`strengthTraining.updatedAt`). (b) Explicit syncs (both actions) spawn with `allowParallel: true` and no dedupeKey — the previous fixed `daily-…` dedupeKeys made the daemon return the morning task's handle for later manual syncs (single-flight covers "recently terminal" tasks), silently swallowing them. (c) `getDashboard` opportunistically spawns a strength re-sync when the stored snapshot is >5 minutes old (in-memory 2-minute spawn throttle, rotating 2-minute dedupe bucket) and returns the task id as `strengthSyncTaskId`; the client polls it so the fresh numbers repaint in the same session. (d) The client polls the new `getRefreshStatus` action (`ctx.agent.status`) every 4s until each sync task completes or fails (max 5 minutes) instead of the old blind 60-second poll — `unknown`/`not_found` keep the poll going rather than masquerading as success — and surfaces "同步未完成" when a task ends without satisfying its save contract.
- Weekly workload is grouped into Monday-based weeks in America/Los_Angeles. When source workouts mix pounds and kilograms, totals are converted to the most recent workout's display unit using 1 lb = 0.45359237 kg before comparison.
- If the source has no workouts or cannot yet be read, the dashboard shows an honest empty state and retains HealthKit data. It does not seed or infer strength sessions.

## Rejected approaches
- **Tried**: treating the current 10/02 partial row as today’s daily result.
  **Why rejected**: only 18 half-hour records were present and HealthKit explicitly reported incomplete coverage, so it is shown only as `今晨参考`.
- **Tried**: interpreting missing 10/01 HR/HRV as an abnormal physiological reading.
  **Why rejected**: the fields were absent rather than out of range, so the UI uses a neutral gray missing-data state.
- **Tried**: remote health imagery or decorative illustration.
  **Why rejected**: it would distract from the compact numeric review and add no factual value.
