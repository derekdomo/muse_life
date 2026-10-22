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
- **Workout visibility fix (2026-10-16)**: the stored snapshot already
  carried every HealthKit workout (11 sessions incl. 6 swimming in the
  captured snapshot), but swimming was effectively invisible: the 今日 tab
  showed only a 7-day count line, the dedicated 游泳记录 section sat below
  the full workouts list in 历史, the 全部运动记录 rows rendered the raw
  English `workout_type` codes ("swimming"/"cycling"/"elliptical"), and
  the unified timeline merged no HealthKit workouts at all, so a swim day
  read as "no workout". Fixes: `unifiedTimeline` days now also carry
  `workoutSessions`, `workoutTypes`, and `swimMeters` from
  `historyWorkouts` and both timeline renderings show them; the 今日 tab
  gains a 最近运动记录 section (latest 5 sessions, Chinese type labels,
  plus a 近30天游泳 N 次 count); workout types render through a Chinese
  label map everywhere (unknown types keep their raw value); and
  游泳记录 now sits above 全部运动记录 in 历史. No data, schema-storage,
  or sync changes — the records were already stored correctly.
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

## Load score definition (adopted 2026-10-17, user decision 「按学术来」)
Research: `~/workspace/research_notes/whoop-garmin-strain-definition-20261017-1808/report.md` (read 2026-10-17; all sources via web index, none verified live — figures should be re-checked against the live pages before being treated as final).

- **WHOOP Strain and Garmin/Firstbeat Training Load cannot be copied**: WHOOP states "the complete proprietary formula and weighting of each input are not published" (https://www.whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/); Garmin's load is a Firstbeat EPOC prediction whose neural-network weights are likewise unpublished (https://www.garmin.com/en-GB/garmin-technology/running-science/physiological-measurements/training-load). Only their published bands/concepts are reusable.
- **Adopted formula — Banister TRIMP (1991), fully published**: per workout session, ΔHR = (average HR − resting HR) / (HRmax − resting HR); TRIMP = duration (min) × ΔHR × 0.64·e^(1.92·ΔHR) (men's constants; constants as printed in https://pmc.ncbi.nlm.nih.gov/articles/PMC6162408/ and https://www.veohtu.com/trimp.html). The prefactor form is used, not the simplified prefactor-less variant; secondary sources disagree on the women's prefactor (0.64 vs 0.86) — unresolved in the report and irrelevant here (men's constants), but the adopted convention is recorded in code.
- **Display**: daily TRIMP (sum over the data date's sessions) is shown raw in the ring detail; the 0–21 number is a saturating presentation map, 21 × (1 − e^(−TRIMP/150)), banded by WHOOP's published ranges (Light 0–9 / Moderate 10–13 / High 14–17 / All Out 18–21). k = 150 is a starting calibration for a recreationally trained adult, not a constant of nature (report §5); the score is labelled TRIMP and never presented as WHOOP's or Garmin's official score. Sanity anchors from the report: a 1 h run at ΔHR ≈ 0.69 → TRIMP ≈ 100 → ≈10.2 (WHOOP's published 1 h running reference ≈ 12 — same band); a marathon-scale day (TRIMP ≈ 300) → ≈18.2, All Out.
- **Inputs**: per-session duration + average HR (already in `historyWorkouts`), the data date's resting HR (already in `historyDaily`), and HRmax = the maximum daily `hr_max_bpm` observed in the stored window. The refresh task's daily query therefore now includes `hr_max_bpm`, mapped to the new optional `historyDaily.hrMax` (null when absent — never an average or estimate). Verified 2026-10-17 via `health-cli query metrics --provider healthkit --list-fields` (field exists) and a live 30-day query (values present on most days; observed max 155 bpm on 2026-10-03; 2026-10-16/17 flagged not-yet-synced by the source itself).
- **Honesty rules**: a session missing duration or average HR is excluded from the sum and counted in the ring detail ("另 N 次缺心率/时长未计入"), never treated as zero; with no scorable input (resting HR missing, HRmax not yet synced, or every session unscorable) no score is shown — the slot falls back to the day's recorded activity facts with the reason stated. Only workout sessions count; non-workout daily activity is outside this definition and the detail says so on workout-free days. The score is computed client-side as a pure derivation over the stored snapshot (like `sevenDayFacts`); no server formula, readiness component, or stored data changes.

## Five-value routine contract (L1-ROUTINE-001, 2026-10-18)
- 训练记录 (space-6) added two home routines to its plan, so the strength pipeline now carries five routine values: `push`, `pull`, `legs`, `home_posture`, `home_snowboard`. The server's `strengthWorkoutSchema` enum matches all five; values are stored and read back verbatim — a home routine is never remapped onto a gym routine and never dropped, and every consumer (routine labels, weeklyTrend counts/volume, H-LOAD weekLoad session counts and same-day HK-strength ambiguity, the unified timeline, readiness's 本周力量 volume) counts the new routines exactly like the original three.
- Display labels match 训练记录's own wording: `home_posture` → 「在家 A · 体态」, `home_snowboard` → 「在家 B · 单板」.
- `STRENGTH_SYNC_PROMPT` states the five-value contract explicitly: preserve each workout's routine verbatim, never rewrite a home routine as push/pull/legs, never filter a workout out because of its routine.
- Boundary: snapshots carrying only the original three values still parse unchanged. An unknown future routine value fails schema validation, so the incoming snapshot is rejected whole and the previously stored snapshot is kept (the existing version/CAS persist path) — a partial write can never pose as a complete sync.

## Readiness score archive (H-LOAD-001, owner-approved 2026-10-18)
- New additive table `readiness_history` (migration 0006), one row per readiness date. `calculateReadiness` itself is unchanged and still computes only the current readiness date; `getDashboard` — the only place readiness is computed, so this covers manual opens and refresh-driven reads alike — archives each computed result by date upsert: `{date, score, components (JSON), confidence, snapshotVersion}` where `snapshotVersion` is the health snapshot's payload `updatedAt` (the read-start version the score was computed from). Recomputing the same date overwrites that date's row; no duplicate rows.
- The 首屏 readiness near-7-day trend reads ONLY this archive: an archived date shows the score that was computed on that date; a date with no archive row (or an archived 数据不足 null score) stays a gap rendered "—" with the existing explanation （历史未提供、不复制今日值）. The archive accumulates forward from launch day only — old dates are never backfilled and never recomputed after the fact, because a later recomputation would not equal the score actually shown then.
- An archive write failure never blocks the `getDashboard` response (read/display first); it is recorded in the sync ledger as a `failed` entry whose note carries no health values. A trend read failure likewise degrades to seven gaps.

## LIFE-C1 人生游戏 settlement layer (CWEB-MVP-001·S1, added 2026-10-19)
Contract: `muse_life` repo `health-dashboard/CWEB-DATA-CONTRACT.md` (spike draft, read 2026-10-19). Same-artifact deployment: the game lives inside this artifact and reuses the health summary — no cross-artifact calls, no new identity channel, no L0.1 expansion.

- **Tables (migration 0009, additive)**: `game_state` (single row: total XP + settled-through date) and `game_settlements` (per-day ledger, PK `(local_date, category)`). They store ONLY game state and settlement metadata — category, LA local date, XP, rule version, source date, and the source snapshot's `updatedAt` as a reference. Health raw values (step counts, sleep hours) are never written to the game tables.
- **Action**: `getGameState` (strict owner gate, like every data-returning action). On open it settles XP from the same loaded snapshots `getDashboard` uses, then returns character state, the daily quest, the ledger (latest 60), and previews/gaps. It is failure-isolated: any game-layer error returns `ok: false` and never affects `getDashboard`.
- **Sources (v1, three categories + quest)**: daily steps from `historyDaily`; main sleep from `historySleeps` (attributed to the wake-up date); completed strength sessions from the effective strength snapshot (standalone first, embedded fallback). Standing/mindful are not connected and not used; HRV/resting HR stay background-only and never decide XP.
- **Complete-window rule**: a date settles only when it is on/before the health snapshot's `dataDate`; the wake-day (readiness-date) sleep additionally requires `coverageIncomplete=false`. Newer visible data is returned as a preview (shown, not booked); a completed day with missing steps or no main-sleep row returns an explicit gap entry and earns nothing.
- **Idempotency**: the ledger PK plus `ON CONFLICT DO NOTHING` — owner + local date + category settles at most once; re-opens never re-award. Total XP is always the ledger sum; `game_state` is a synced summary. Rule version is audit metadata only — settled rows are never recomputed or revoked.
- **XP rules v1 (`rule_version=1`, shown on the page)**: steps 1 XP per full 1000 steps, capped at 20/day; main sleep ≥7h → 10 XP, shorter nights proportional floor; strength 10 XP per completed session; daily quest (8000 steps) +10 XP once that day completes. Level = floor(total/100)+1, 100 XP per level.
- **Quest card**: "今日步行 8000 步" progress reads the LA-today row of `historyDaily` when the pipeline has synced it; the stored pipeline carries completed days only, so on most days the card honestly shows 今日步数尚未同步 (missing) and the reward books when that date completes — it never fabricates a partial-day step count.

## LIFE-C1 character system (CWEB-MVP-001·S2, added 2026-10-19; rule version 2)
Owner scope as briefed, with one owner correction applied the same day: the Life version is **pure character growth — no dungeon/expedition component** (an earlier dungeon draft and a daily-task→dungeon speedup linkage were both struck before shipping; no dungeon tables, actions, or UI exist).

- **Migration 0010 (additive + one rebuild)**: `game_state` gains `gold`, `gold_initialized`, `attrs_json`, `attr_points_earned`, `equipment_json`. `game_settlements` is rebuilt with PK `(local_date, category, detail)` plus a `gold` column: `detail` is "" for base categories and the task id for `daily_task` rows (three tasks share one date/category); S1 rows copy across with gold 0 because their gold is folded into the one-time initial balance — never minted twice. Category enum gains only `daily_task`.
- **Attributes**: 力量 (strength→strength XP), 耐力 (endurance→steps XP), 精神 (spirit→sleep XP), 体力 (stamina→quest_steps XP — the comprehensive-activity domain). 3 points per level, backfilled once from the current level (level is derived from ledger total XP, so the backfill is exact); unspent = earned − allocated. Each point = +2% to its domain's settlement XP, attribute portion capped at +50%/domain; equipment percentages stack on top. Boosts are computed from the profile at booking time and frozen into the booked row — allocations/equips after the fact never recompute a booked row, and v1 rows keep rule_version 1 untouched. Allocation is owner-only (`allocateAttribute`), permanent in v1 (no respec).
- **Gold**: stored balance in `game_state`. First S2 read initializes it once to the then-cumulative ledger XP (flag persisted before any new minting in that call). Every XP settlement booked afterwards mints gold 1:1 with the XP actually awarded (after boosts), multiplied by the equipped gold% (floor). Daily tasks credit their flat gold directly. Purchases are the only sink. There is no other gold source — no ads, no payment, no random drops.
- **Equipment**: fixed 8-item catalog in server code (3 slots: weapon/armor/accessory; one equipped per slot): 铁剑 (strength XP +10%, 300), 疾风短刃 (steps XP +15%, 600), 橡木法杖 (sleep XP +10%, 300), 皮甲 (gold +10%, 250), 精钢板甲 (strength XP +15%, 650), 夜行斗篷 (sleep XP +15%, 650), 疾行护符 (steps XP +10%, 280), 晨光护符 (quest XP +20%, task-granted only — first completion of the sleep daily task). Owned/equipped state lives in `game_state.equipment_json`; buy/equip/unequip are owner-only actions validated server-side (ownership, balance, slot consistency on parse). No gacha, no random affixes, no real payment.
- **Daily tasks**: three fixed tasks per day — 步行 10,000 步 / 完成 1 次力量训练 / 主睡眠 ≥ 7.5 小时 — each rewarding a flat 15 XP + 40 gold (no domain boost). Progress is computed from the same health summary as everything else (today's `historyDaily` row, today's completed strength sessions, the main sleep attributed to this morning); a met target books immediately (a met target cannot un-happen, unlike the base categories' complete-window rule) under `(today, daily_task, task_id)`, so at most once per task per day. Unsynced progress shows as 数据未同步 and earns nothing.
- **Permissions/isolation unchanged**: every game action (reads and the four mutations) keeps the strict owner gate; non-owners get `forbidden` with zero game data. The game layer still reads only the loaded snapshots and writes only the game tables.

## CWEB-SETTLE-001 remaining items (2026-10-20 follow-up)
Three settlement defects found by PM review of the watermark build, fixed in `server/src/actions.ts` with one additive migration:

- **Insert race (P0)**: `settleLedgerRow`'s first-insert branch no longer assumes `ON CONFLICT DO NOTHING` landed. The insert returns via `RETURNING`; when it landed nothing (a concurrent settlement booked the same key between this pass's read and insert), the winner row is re-read and `planLedgerAction` re-decides against it, so a newer-source candidate still refreshes/revises the winner through the write-time monotonic guard instead of being dropped until a later open.
- **Immutable adoption boundary (P0, migration 0012)**: `game_state` gains `gold_adoption_boundary` (additive, nullable). The 0012 backfill stamps every legacy row still carrying `gold_ledger_sum IS NULL` (and `gold_initialized = 1`) with its then-current `updated_at`. The one-time watermark baseline adoption in `settleGame` now reads this boundary instead of the live `updated_at`: profile writes (purchase / allocation / equip / unequip) never write the column, so a purchase landing between a failed settlement save and its retry can no longer absorb the stranded ledger row into the adopted baseline — the retry credits it exactly once, the purchase and its spent gold are preserved, and already-consumed history is still adopted, never re-minted from the ledger SUM. Once the watermark is non-null the boundary is never consulted. Rollback: drop the column; all other data is untouched and pre-0012 rows remain readable throughout.
- **Same-instant idempotency (P1)**: `compareSourceVersions` returns 0 when two version strings parse to the same instant (`2026-10-02T01:00:00.000Z` ≡ `2026-10-02T01:00:00Z`), so a same-version candidate never re-prices a booked row. The write-time guard in `settleLedgerRow` compares through `sourceVersionSqlBefore`, the SQL twin of the same normalized ordering (`unixepoch(..., 'subsec')` on both sides, lexicographic fallback when either side is unparseable) — no parse-on-one-side / string-compare-on-the-other split remains.

## Rejected approaches
- **Tried**: treating the current day’s partial row as today’s daily result.
  **Why rejected**: only partial half-hour records were present and HealthKit explicitly reported incomplete coverage, so it is shown only as `今晨参考`.
- **Tried**: interpreting missing HR/HRV on the latest complete day as an abnormal physiological reading.
  **Why rejected**: the fields were absent rather than out of range, so the UI uses a neutral gray missing-data state.
- **Tried**: remote health imagery or decorative illustration.
  **Why rejected**: it would distract from the compact numeric review and add no factual value.

## H4.6 refinement — muscle groups as three factual groups + in-place sources (2026-10-20)
Presentation-only change over the existing strength snapshot; no data source, formula, stored row, or sync path changed.
- **Grouping**: the history muscle section partitions the existing per-muscle facts (same `muscleStatus` aggregation, same 7-day window [today-6, today], same completed-sets-only rule) into 「近7天有记录」 / 「更早的快照内记录」 / 「本快照未见记录」. The two trained groups sort by last trained date descending with the fixed MUSCLE_GROUPS order as tie-break; the unseen group keeps the fixed order and starts collapsed. "Not seen" is snapshot-scoped wording only — never 从未练过 / 已恢复 — and no recovery percentage or training suggestion is derived from the ordering.
- **Sources**: each muscle row expands in place to the snapshot records behind it — stored workout id (plain text, never a link), real date, exercise key, primary/secondary role for that muscle, completed set count. Out-of-window records are badged 「本窗口外」 and contribute nothing to the 7-day counts. External load is per-source, in the workout's own unit, summed only over completed sets carrying both weight and reps; completed sets missing either are counted as unmeasured on that source. Loads are never totalled across muscles (one exercise legitimately serves several). Unknown keys stay unmapped and produce no sources; non-completed workouts produce none.
- **Validation**: `validate-muscle-status.mjs` covers the grouping partition/order, source id consistency across primary/secondary overlap, the out-of-window flag, and the missing-set load rule over synthetic fixtures (50 checks).

## CWEB-REDEEM-SAFE-001 follow-up (2026-10-21)
Four redemption-safety defects plus the S3 read-only split and the 0014 journal evidence, all in the S3 rewards layer; no settlement formula, LEVEL, attribute/equipment, or daily-task rule changed.

- **Completion proof (migration 0015, additive)**: `game_reward_redemptions.completion_proof` stores the gold-ledger watermark the atomic redemption batch produced for that request, written only by the receipt insert inside the batch. Receipts without it (anything pre-dating the proof, including a half-completed legacy write) read `verification: "unverified"` in lookup, list, replay (typed `unverified` redeem result, zero writes), and the client (▲ 未核实 text label; ✓ 已完成 for proven receipts) — never inferred from balances or per-day ledger aggregates, never backfilled, charged, or deleted.
- **Whole-scope pin verification**: redeem re-reads the profile after its pre-commit ledger SUM read (pinCheck) and seeds the commit loop's movement check from the commit base (the pin, advanced only by the handler's own settlement). An external write moving balance version/balance/watermark before the first commit attempt rejects the old confirmation as `stale` with zero redemption writes; the handler's own settle advancement is the entitled base and never stales its own loop or a same-requestId busy retry.
- **Reconciliation gate**: a settle failure inside redeem, or a post-settle watermark that still differs from the ledger gold SUM, aborts with a typed `busy` and zero redemption writes — no spending from an unreconciled balance, no flooring anywhere in the redemption path.
- **Recovery slot (client)**: while a redemption is unconfirmed, `openPreview` routes back into the pending intent's unconfirmed flow on its original requestId (no new key, no slot overwrite); the submit hook likewise refuses to store a different draft over a pending one. List edits and goal selection stay open.
- **Truly read-only snapshot**: new owner-only `getRewardsSnapshot` reads stored profile/ledger-SUM/rewards/receipts/goal only — no settle, no save, no spawn. Its `ok` is the stored reconciliation fact (initialized + watermark == ledger SUM), keeping failure / unknown / true-zero distinct and the stored goal intact. The goal card's and panel's 只读重查 use it; `getRewards`/`getGameState` keep settle-on-read and are never called read-only.
- **0014 rebuildability (EVID-LIFE-001)**: `drizzle/meta/_journal.json` registers every migration through the builder mechanism (0014 goal, 0015 proof). `validate-rewards.mjs` proves: from-scratch rebuild in journal order yields the full schema and working getRewards/setRewardGoal; a 0013-built store upgraded with 0014+0015 keeps every legacy row (receipt reads unverified, balances untouched). The validator also covers the four counterexamples at the real handler dispatch points (98 checks; settlement 150 and muscle-status 50 unchanged and green).
