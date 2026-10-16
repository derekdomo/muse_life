# Data Plan

## Context provenance
- `我需要一个daily update的health dashboard` (current user request; establishes a daily-refreshed personal health overview)
- Parent handoff supplied a real Apple HealthKit snapshot, including baselines, 7-day trends, last-night sleep, and workout count. (AUDIT-03 / L0.4, 2026-10-13: these values were originally embedded in `server/src/actions.ts` as `INITIAL_*` seed constants; they have been removed from the source. The snapshot now lives only in the database like any synced snapshot, and a database without a snapshot shows the honest empty state until the first real HealthKit sync.)
- Parent handoff requires Simplified Chinese, daily silent refresh, KPI status chips, 7-day step/resting-HR/HRV charts, sleep staging, missing-data treatment, and a medical-reference footer.
- `Health baseline from about two weeks of iPhone health data, covering daily steps, resting heart rate, HRV, nightly sleep duration, and swimming frequency` (standing user context directly relevant to comparison ranges; specific baseline values are not recorded here).

## Tested sources
### Apple HealthKit via `health-cli`
**Used by**: `refreshHealthData` agent task, `saveHealthSnapshot`, `getDashboard` (`initializeSnapshot` no longer writes anything; it never seeds data)
**Test command**: `health-cli query metrics --provider healthkit --start-date <start> --end-date <end> --fields step_count,resting_hr_average_bpm,heart_rate_variability_ms,hr_average_bpm,active_energy_burned_kcal,distance_walking_running_meters`
**Sample output** (SYNTHETIC 示例，非真实数据 — structure only): coverage.complete=true; daily records each carry a `step_count` value; `resting_hr_average_bpm` may be absent on the first day of the window; `resting_hr_average_bpm` and `heart_rate_variability_ms` may be absent on the latest day; `distance_walking_running_meters` present as a meter value.
**Processing**: use the latest completed calendar day as the daily metric date; retain nullable HR/HRV and render them as `数据缺失`, not anomalies; preserve the source coverage flag.

**Test command**: `health-cli query metrics --provider healthkit --start-date <start> --end-date <end> --fields step_count,resting_hr_average_bpm,heart_rate_variability_ms,hr_average_bpm,active_energy_burned_kcal,distance_walking_running_meters`
**Sample output** (SYNTHETIC 示例，非真实数据 — structure only): coverage.complete=false because the current day had not fully synced; the partial morning record for the current day may carry `heart_rate_variability_ms` and `hr_average_bpm` values.
**Processing**: never treat the current partial day as a complete daily metric; show the available current-day HRV and average HR only as `今晨参考`; when any refresh query reports incomplete coverage, label the refresh `数据同步不完整` while preserving available values.

**Test command**: `health-cli query sessions --provider healthkit --category sleep --start-date <start> --end-date <end>`
**Sample output** (SYNTHETIC 示例，非真实数据 — structure only): one overnight session with start/end timestamps in America/Los_Angeles; stage durations in seconds for core, deep, REM, and awake; plus `quality`, `efficiency`, and `awakenings` fields; coverage.complete=false because the end day was not fully synced.
**Processing**: match the last overnight session ending after the latest complete day; convert stage seconds to hours/minutes; retain timezone and format bedtime/wake time locally.

**Test command**: `health-cli query sessions --provider healthkit --category workout --start-date <start> --end-date <end>`
**Sample output** (SYNTHETIC 示例，非真实数据 — structure only): records=[]; coverage.complete=false because the current day was not fully synced.
**Processing**: count sessions for the trailing 7 completed days only; present zero as `本周 0 次`, distinct from an unavailable query.

## Agent-task sources
### Daily HealthKit refresh
**Delivered by**: `refreshHealthData` spawns one background agent task with an `expectsAction` callback to `saveHealthSnapshot`
**Checked with**: the direct `health-cli` probes above establish command syntax, field names, result shape, missing-data behavior, and the current account’s useful data. The runtime agent callback itself requires a built artifact and will be verified after build by invoking the published refresh action and checking its durable result.

## Image slots
Imagery not needed: the requested subject is the user’s quantitative health record, best served by deterministic charts, stage bars, and status marks rather than decorative or representational imagery.

## Access control (AUDIT-02 / L0.1, 2026-10-13; sync-channel correction 2026-10-14)
- Browser-facing actions — reads (`getDashboard`, `getRefreshStatus`), writes (`saveMorningCheckin`), initialization (`initializeSnapshot`), and the manual `refreshStrengthTraining` button — verify `ctx.viewer?.isOwner === true` on the server before touching the database. A missing viewer counts as unauthorized, and no health data is ever returned to a non-owner identity.
- The pipeline entry points that the artifact's own background machinery calls without a browser — the daily schedule's `refreshHealthData` invocation and the agent-task return callbacks (`saveHealthSnapshot`, `saveStrengthTrainingSnapshot`) — accept the owner OR an invocation carrying no viewer at all (only daemon-internal channels produce that shape), while still rejecting any present non-owner viewer. The blanket missing-viewer rejection previously applied to these three actions silently blocked every scheduled refresh and task callback after L0.1 shipped (both snapshots froze at the last pre-gate sync while the schedule reported success); none of the three returns health data to its caller.
- Unauthorized calls return a stable typed state (`forbidden: true` with null/empty payload, or `ok: false` for mutations) and never return health data or perform writes.
- Both persist paths are monotonic: a sync task that finishes late cannot overwrite a snapshot carrying a newer `updatedAt`.

## Long-term data behavior
- **Refresh policy**: a silent artifact-owned daily schedule calls `refreshHealthData`; the action asks an agent to query the latest complete day, last night’s sleep, morning reference, 7-day trends, and workouts using `health-cli --provider healthkit`, then calls `saveHealthSnapshot` with validated structured data.
- **Growth**: each refresh upserts the current snapshot and replaces the bounded 7-day trend rows; no synthetic history is generated.
- **Ordering**: trend rows ascending by date; dashboard highlights the latest complete day and the latest overnight sleep session.
- **Time semantics**: daily metrics use America/Los_Angeles calendar dates; sleep retains its source timezone; update timestamps are stored as instants and rendered in the viewer’s locale.
- **Coverage**: any `coverage.complete=false` from the queried windows sets a visible `数据同步不完整` flag while still showing available records.

## Unified 30-day history (merged 2026-10-05)
- The existing `health-cli --provider healthkit` refresh now widens its completed-day window to 30 days and adds `body_mass_average`, `apple_exercise_time_sum`, and `distance_swimming_sum` to the daily query.
- The same refresh retrieves workout sessions for the same 30-day window and the latest 14 sleep sessions; it does not introduce another source or a second refresh path.
- (Removed 2026-10-13, AUDIT-03 / L0.4) The former initial-history fallback embedded source-backed rows (daily rows spanning the initial window, HealthKit swimming workouts, real weigh-ins, and sleep sessions) as `INITIAL_*` constants in server source. They are deleted; stored records missing history fields now fall back to empty arrays, and a database without a snapshot renders the empty state with a HealthKit sync action.
- **Chart encoding**: steps and active energy are rendered in separate charts. Activity energy and exercise minutes use distinct labeled left/right axes; resting heart rate and HRV also use distinct labeled axes. Missing values remain gaps.
- **History views**: swimming rows show date, distance, duration, average heart rate, and energy; weight rows show only real weigh-ins; sleep rows show date, start/end, duration, and source quality.

## Strength-training aggregation (added 2026-10-08)
- **Source**: the user's separate `训练记录` web artifact (`space-6`) through its published `getDashboard` action; this dashboard reads its active workout and latest 20 completed workouts but does not duplicate its training-entry interface.
- The existing daily/manual refresh action also starts one bounded synchronization task for `训练记录`. That task calls `saveStrengthTrainingSnapshot`, which merges only the strength-training branch into the current HealthKit snapshot so the two sources cannot overwrite each other.
- Every workout preserves its routine, unit, timestamps, completion state, completed sets, weights, repetitions, and exercise names. Total volume is calculated only from completed sets with both weight and repetitions as `weight × reps`; missing values stay missing rather than becoming zero-volume work.
- HealthKit and strength-training snapshots are persisted independently and merged only when read. This prevents the two asynchronous refresh callbacks from racing and overwriting a newly synchronized strength session with an older HealthKit payload. Existing embedded strength data is migrated into the dedicated snapshot table.
- **Sync-channel fix (2026-10-14, second timeliness repair)**: the first timeliness fix addressed dedupe keys and client polling, but production snapshots still never updated — the L0.1 owner gate also rejected the pipeline's own machine invocations (the schedule's viewer-less `refreshHealthData` call and the tasks' viewer-less save callbacks), so every refresh after the gates shipped silently no-opped. The three pipeline entry points now accept owner-or-viewer-less invocations (see Access control), all data-returning actions keep the strict owner gate, and both persist paths reject out-of-order older writes. The remaining external link is the sync task's read of `训练记录`'s owner-gated `getDashboard`, which belongs to that artifact.
- **Timeliness fix (2026-10-14)**: strength data is local to the sibling artifact, so it no longer waits for the daily HealthKit cadence. (a) A dedicated `refreshStrengthTraining` action spawns only the strength sync, and the strength panel has its own 同步训练 button plus its own 更新于 timestamp (`strengthTraining.updatedAt`). (b) Explicit syncs (both actions) spawn with `allowParallel: true` and no dedupeKey — the previous fixed `daily-…` dedupeKeys made the daemon return the morning task's handle for later manual syncs (single-flight covers "recently terminal" tasks), silently swallowing them. (c) `getDashboard` spawns (or reuses) a strength re-sync on every owner open — the earlier >5-minute staleness threshold was removed on 2026-10-15 at the user's direction ("打开即最新"): the stored snapshot renders first, the sync repaints it when it lands. The only remaining guard is anti-spam: a spawn less than 2 minutes old is reused and its task id returned again (rotating 2-minute dedupe bucket), so refetches within one open never fan out into duplicate tasks. The task id returns as `strengthSyncTaskId` and the client polls it so the fresh numbers repaint in the same session. (d) The client polls the new `getRefreshStatus` action (`ctx.agent.status`) every 4s until each sync task completes or fails (max 5 minutes) instead of the old blind 60-second poll — `unknown`/`not_found` keep the poll going rather than masquerading as success — and surfaces "同步未完成" when a task ends without satisfying its save contract. (e) Failure surfacing fix (2026-10-15): the open-triggered background sync is polled by the App shell, whose failure note is now passed into the Dashboard view as well — previously it rendered only in the no-data empty state, so a failed background sync was invisible whenever the dashboard already had data.
- Weekly workload is grouped into Monday-based weeks in America/Los_Angeles. When source workouts mix pounds and kilograms, totals are converted to the most recent workout's display unit using 1 lb = 0.45359237 kg before comparison.
- If the source has no workouts or cannot yet be read, the dashboard shows an honest empty state and retains HealthKit data. It does not seed or infer strength sessions.

## Unified experience layer — the alternative to a shared database (2026-10-15)
The user asked for the four Muse Life apps to behave as one system with one
source of truth, and declined filing a platform feature request for a truly
shared store ("那算了，你就想别的办法来吧"). The platform still gives each
artifact its own `app.db`, so this dashboard implements the unification at
the experience layer instead of pretending the stores merged:

- **Sync ledger (`sync_log` table, migration 0005)**: every successful
  health/strength save writes a `saved` entry (source, item count, source
  timestamp); a sync task that ends `failed` or completes without satisfying
  its save contract writes a `failed` entry from `getRefreshStatus`; the
  diagnostics action writes a `diagnosed` entry. Failures are therefore
  durable and visible, never silent — the exact failure mode that froze the
  strength panel in Oct 2026.
- **Data status (`dataStatus` on `getDashboard`)**: per-source freshness
  (fresh / today / stale / missing), age, data date, and an overall label,
  computed server-side from the stored snapshots plus the last 8 ledger
  entries. The client renders it as a 数据状态 panel on the 今日 view.
- **Unified timeline (`unifiedTimeline` on `getDashboard`)**: health daily
  rows, sleep sessions, and strength workouts merged by local calendar date
  (latest 14 days), so a day's steps, sleep, resting HR/HRV, and strength
  sessions/volume read as one record. Rendered on both 今日 (last 7 days)
  and 历史 (full 14 days).
- **One-tap diagnostics (`getSyncDiagnostics`, owner-only)**: a
  deterministic, agent-free check of snapshot presence, per-source
  freshness, the latest strength workout, unified overlap, and recent
  ledger failures, returning a plain-language verdict plus per-check
  details. It writes its own ledger entry, so even the check is auditable.
- Access control is unchanged: all new reads/actions keep the strict owner
  gate; a non-owner gets `forbidden: true` with no status, timeline, or
  ledger data.

## Per-source independence (H-SOURCE-001, 2026-10-15)
The two snapshots are now loaded, validated, and reported independently —
one source missing or corrupt can no longer swallow the other:

- **Independent loads**: `loadHealthSnapshot` / `loadStrengthSnapshot` each
  return `ok` / `missing` (no row) / `corrupt` (JSON parse or schema
  failure). A parse failure marks only its own source corrupt; `getDashboard`
  no longer has a catch-all that nulls the whole response.
- **Per-source status**: `buildDataStatus` computes health freshness from
  the health load alone and strength freshness from the strength load alone
  (standalone row first; the health snapshot's embedded `strengthTraining`
  is only a legacy fallback when the standalone row is missing). A corrupt
  source counts as missing for freshness but its detail reads
  「快照损坏，等待重新同步」. Overall is `empty` only when both sides are
  missing, `partial` when exactly one side is usable.
- **Additive response fields**: `getDashboard` also returns `healthState`,
  `strengthState` (`ok`/`missing`/`corrupt`), and `strength` (the standalone
  strength snapshot; the embedded copy when the standalone row is missing
  and the health snapshot carries one; null otherwise). When health is ok,
  the merged snapshot still lets a valid standalone strength override the
  embedded copy, but a corrupt standalone row is replaced with an honest
  empty placeholder （训练快照已损坏，重新同步后恢复） instead of the stale
  embedded data. When health is missing/corrupt, `snapshot` and `readiness`
  stay null — no fabricated health snapshot — while `strength`,
  `dataStatus`, and `unifiedTimeline` reflect the strength source as-is.
  The morning check-in is read only when health is ok.
- **Auto-sync on every path**: `maybeAutoSyncStrength` now runs on every
  owner open, including health missing/corrupt paths, and its task id is
  returned as `strengthSyncTaskId` (2-minute anti-spam reuse unchanged).
- **Diagnostics**: `getSyncDiagnostics` loads both sources independently —
  health checks reflect only health, strength checks only strength, and the
  recent-failures and timeline-overlap checks run on whatever data is
  available; the verdict can express partial states (only one side has
  data, or one side is corrupt).
- **Client**: when the health snapshot is null but `strength` is present,
  the app renders a strength-only view (explanation keyed to `healthState`,
  the strength panel, the per-source data-status panel, and both sync
  entry points) instead of the "no health data" empty state; when both are
  missing the empty state remains and now also shows the data-status panel
  so the user can see which side is missing.
- Permissions are unchanged: `getDashboard` and `getSyncDiagnostics` keep
  the strict owner gate; non-owners still get `forbidden: true` with zero
  data. No schema or migration changes.

## Rejected approaches
- **Tried**: treating the current day’s partial row as today’s daily result.
  **Why rejected**: only partial half-hour records were present and HealthKit explicitly reported incomplete coverage, so it is shown only as `今晨参考`.
- **Tried**: interpreting missing HR/HRV on the latest complete day as an abnormal physiological reading.
  **Why rejected**: the fields were absent rather than out of range, so the UI uses a neutral gray missing-data state.
- **Tried**: remote health imagery or decorative illustration.
  **Why rejected**: it would distract from the compact numeric review and add no factual value.
