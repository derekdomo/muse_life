# Data Plan

## Context provenance
- `按我这个app的逻辑，搞一个artifact，每周更新` (current user request; establishes that the artifact must reproduce the user's existing app logic and refresh weekly)
- `"按我这个app的逻辑"指用户自研 Electron 应用 Firance（源码在用户 Mac 上，完整本地路径不入 Git，L0.4 脱敏 2026-10-13），仪表盘必须 1:1 复刻其 Home 与 Dashboard 视图的计算口径。` (parent-agent clarification derived from the user's app investigation; defines the authoritative calculation and display model)
- `月度快照：Mac 目录 ~/Library/Application Support/Firance/FinanceData/，文件名即 key（YYYY-MM-DD 格式，无扩展名）。每条记录 3 行：finance_source / type / number。` (parent-agent supplied source finding; defines the historical snapshot source and parser requirements)
- Parent-agent supplied exact Firance formulas for monthly aggregation, contribution fallback, flexible spend, investment return, and FIRE metrics; these formulas will be implemented directly rather than reinterpreted.

## Tested sources
### Plaid linked financial data
**Used by**: `refreshFinanceData` background retrieval, live net-worth fusion, weekly comparison, holdings Top 10, account-detail refresh
**Test command**: `which plaid; plaid status | jq ...; plaid accounts | jq ...; plaid liabilities | jq ...; plaid investments-holdings | jq ...`
**Sample output**: Plaid is connected. The account read returned linked loan, depository, credit, brokerage, IRA, 401(k), HSA, and crypto accounts with masked suffixes and current balances. The liabilities read returned a mortgage at 2.375%. The holdings read returned 5 institutions and 72 holdings; a schema check confirmed holdings carry `institution_value` and securities carry `name` and `ticker_symbol` for a server-side join.
**Processing**: A spawned retrieval agent runs the three read-only Plaid commands. Snapshot finance sources ending in `_XXXX` are matched to account masks, preferring the same institution when available. Matched accounts receive current balances; credit and mortgage liabilities are normalized as negative net-worth values. `titan`, `titan_ira`, `wealthfront_saving`, `citi`, `usbank_cc`, `bonds`, and `fidelity_*` always retain snapshot values per the supplied contract. Holdings are joined to securities by the opaque IDs inside the action, then only ticker/name/value/share are persisted or returned; internal IDs and raw JSON are never exposed.

### Firance monthly snapshot files on the user's Mac
**Used by**: `refreshFinanceData` background retrieval -> `ingestFinanceData`; all monthly charts, monthly KPIs, FIRE calculations, and grouped account details
**Test command**: Source behavior was already established in the parent conversation from reads of the FinanceData directory (date-named files, one per snapshot); this builder seat has no direct device-file connector, so it will use the requested `ctx.agent.spawnTask` retrieval path at runtime.
**Sample output**: Parent conversation reports the historical files were re-read and verified after mortgage backfill; current files use three-line records containing `finance_source`, `type`, and `number`, while field order differs across years.
**Processing**: The retrieval agent lists files first, then reads all date-named files without writing to the Mac. The parser groups each three-line record and reads keys by name rather than position. Date filenames are parsed and sorted chronologically. Monthly rows are recomputed from source records using the exact Firance aggregation rules. If the Mac is unavailable or no valid files are returned, the action retains the last server-cached monthly dataset.

## Agent-task sources
### Weekly finance refresh
**Delivered by**: `refreshFinanceData` -> detached agent task -> `ingestFinanceData`
**Checked with**: The action contract will require the retrieval agent to list/read Firance files and run only `plaid accounts`, `plaid liabilities`, and `plaid investments-holdings`, then submit a strictly validated JSON payload to the save action. No browser work is required.

## Long-term data behavior
- **Refresh policy**: One silent weekly artifact-action schedule dispatches `refreshFinanceData`. First build also invokes it once for real initial population. The page reads the latest cached snapshot immediately; no client-side Plaid or Mac access occurs.
- **Growth**: Persist one bounded current snapshot containing full monthly aggregates/source rows, latest live fusion, holdings, and account details, plus the previous successful weekly live net worth needed for week-over-week delta. Replace the current snapshot atomically rather than appending unbounded raw Plaid history.
- **Ordering**: Monthly series sort by the date key ascending for chart math; headline values use the newest two monthly rows. Accounts group by type and then sort by absolute value descending. Holdings sort by market value descending and display the first 10.
- **Time semantics**: `asOf` is the successful refresh instant; source month keys remain calendar dates from Firance. Failed refreshes preserve all prior values and set a visible stale/failure status without altering the prior successful `asOf`.

## Design research applied in this revision
- The user supplied the Subdeck reference post and confirmed that its UI hierarchy—not its promotional claims—should guide the redesign: https://www.xiaohongshu.com/explore/6ac8c4990000000018019293
- The primary community research report is preserved outside the artifact; no external values are imported into the user's financial records. The redesign applies its recurring patterns: a single dominant net-worth figure, savings rate and emergency-fund coverage as action-oriented KPIs, a FIRE ratio trajectory, restrained single-color charts, and lower-density institution-grouped account rows.
- Supporting public sources consulted by that report: https://phantop.github.io/reads/quicken.html ; https://www.madfientist.com/financial-independence-spreadsheet/ ; https://www.bogleheads.org/forum/viewtopic.php?start=100&t=374190 ; https://freedomtrack.io/blog/introduction-to-freedomtrack/ ; https://github.com/hozza/Personal-Finance-Net-Worth-Tracker
- The displayed “月支出每降 $1k，FI 目标减少约 $300k” is a direct arithmetic consequence of the artifact's existing 4% rule: $1,000 × 12 ÷ 0.04 = $300,000. It is not imported account data.

## Image plan
Imagery not needed: this is a private numeric finance dashboard whose visual subjects are deterministic charts, progress bars, and account rows; decorative or generated imagery would compete with the core financial reading task.

## Rejected approaches
- **Tried**: Treating Plaid as the sole source of truth.
  **Why rejected**: The supplied contract names several non-Plaid accounts and all monthly income/spend/contribution history as Firance-only; dropping them would understate net worth and break the requested 1:1 logic.
- **Tried**: Reading Firance keys by fixed line order.
  **Why rejected**: Historical files use different key ordering, so parsing by position would silently corrupt rows.
- **Tried**: Fetching live data directly from the browser.
  **Why rejected**: The data is account-gated and scheduled; it belongs in validated server actions with cached fallback.
- **Tried**: Fabricating an initial dashboard when sources are unavailable.
  **Why rejected**: The artifact must show only real user finance data; until the first successful refresh it will show an honest empty/retry state.
