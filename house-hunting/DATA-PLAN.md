# Data Plan

## Context provenance
- “主要看Santa Clara的，或者说反正就是南湾的吧，南湾的single family house，然后价格在两个million到三个million。要求是周围环境要好，离大陆不要挨着大陆，然后再有一个是学区不要太差，或者说离那种好的私校近一点也是可以的。”（用户此前明确的区域、房型、预算、安静街道与学校偏好；“大陆”按已向用户说明的“大路/高速”理解。）
- “把 Sunnyvale 和 Cupertino 也筛一轮”（用户把范围扩展并锁定为 Santa Clara、Sunnyvale、Cupertino。）
- “给我一个每周的 report，就是 artifact……综合考虑性价比、居住环境、房子新的程度、大小……三 B 以下不能接受……百分之三十 down pay……principal 加 interest”（当前请求；决定周报、3+ 卧室硬条件、综合排序和按 30% 首付计算月供。）
- 2026-09-19 的父对话研究给出了 14 套 Redfin 短名单及逐套地址、挂牌价、卧卫、面积、年份、学区、噪音/道路、挂牌天数、降价与原始 Redfin URL；其中综合前三为 880 Lansdown Ct、7536 Dumas Dr、835 Poplar Ave。该快照将作为首次加载的真实、注明日期的数据，之后由每周研究刷新替换。
- 父对话同日利率计算采用 30 年 jumbo 固定利率约 7.2%、30% 首付；网页搜索再次找到 2026-09-16 Bankrate 数据（30 年 fixed jumbo 7.13%）和 2026-09-18 全国 30 年固定 7.09%。首期快照沿用 7.2% 的保守 jumbo 估算，并清楚标注本金+利息、不含地税/保险/HOA。

## Tested sources
### Redfin listing pages via `ctx.tool.web_search`
**Used by**: weekly `refreshReport` research action, with results saved by `ingestResearch`; initial snapshot retains exact Redfin URLs from the completed parent research.
**Test command**: `bun /opt/hatch/skills/spaces/ts-runtime/dist/probe-ctx.js < /tmp/space2-probe-brief.ts`
**Sample output**: 7 results; included `7536 Dumas Dr, Cupertino, CA 95014 | MLS# ML82061358 | Redfin`, URL `https://www.redfin.com/CA/Cupertino/7536-Dumas-Dr-95014/home/784657`, snippet fields “Single-family”, “1959 Year Built”, “6,050 sq ft Lot Size”, “$1,967 Price/Sq.Ft.” and listing updated Sep 15, 2026. Also returned current Sunnyvale/Cupertino Redfin listing pages.
**Processing**: research agent filters to active single-family listings in the three named cities, $2M–$3M, 3+ bedrooms; it verifies each kept listing’s page, rejects highway/major-road adjacency, captures source URL byte-for-byte, then ranks on value, residential environment, condition/age, size, and schools/private-school proximity. Unknown fields remain null; listings are never invented.

### Mortgage-rate reporting via `ctx.tool.web_search`
**Used by**: weekly `refreshReport` research action and mortgage estimate calculations.
**Test command**: `bun /opt/hatch/skills/spaces/ts-runtime/dist/probe-ctx.js < /tmp/space2-probe-brief.ts`
**Sample output**: WSJ Buy Side result `https://www.wsj.com/buyside/personal-finance/mortgage/mortgage-rates-today-9-16-2026` reported “30-year fixed jumbo 7.13%” from Bankrate; Bankrate result `https://www.bankrate.com/mortgages/analysis/mortgage-rates-september-16-2026/` reported 30-year fixed 6.97%.
**Processing**: prefer a dated 30-year jumbo fixed rate when available because the expected loan size is jumbo; otherwise use a dated 30-year fixed national average and label it accordingly. Monthly P&I is computed deterministically as `P * r(1+r)^360 / ((1+r)^360-1)` with principal = price × (1 − down-payment percent). Taxes, insurance and HOA stay separate.

## Web-search sources
### Current Redfin listings and mortgage rates
**Delivered by**: `refreshReport`, with the multi-step result persisted through `ingestResearch`.
**Checked with**: real `ctx.tool.web_search` probes above returned usable Redfin listing URLs and dated mortgage-rate results; search snippets alone are not trusted for quiet-road and school judgment.

## Agent-task sources
### Weekly South Bay shortlist verification
**Delivered by**: `refreshReport` → `ctx.agent.spawnTask(..., { expectsAction: "ingestResearch" })` → `ingestResearch`.
**Checked with**: the parent conversation’s completed browser research on Sep 19, 2026 verified live Redfin pages, map context/noise, schools, listing status, price changes and exact URLs for the initial Santa Clara, Sunnyvale and Cupertino shortlist. The weekly agent repeats this browser/page-reading work because it cannot be done reliably from search snippets alone.

## Long-term data behavior
- **Refresh policy**: one silent weekly artifact-action schedule calls `refreshReport`; the page also exposes a manual refresh control. Cached report remains visible while a refresh is running.
- **Growth**: each accepted refresh replaces the current recommendation set and stores a bounded recent snapshot history; no fabricated user history or saved favorites are created.
- **Ordering**: active listings sort by composite recommendation score; city and minimum-size controls filter the visible set without changing source data. The 3+ bedroom rule is hard; no fixed minimum square footage is guessed, so the UI lets the user choose an editable threshold.
- **Time semantics**: each report and rate displays its source `as_of` time; listing dates are treated in Pacific time when the source provides a local date. Creation/update instants render viewer-local.

## Imagery
Imagery not needed: this is a fast, data-dense weekly comparison and mortgage decision surface. Accurate listing photos are property-specific and change with inventory; no durable, preflighted per-listing image set was provided, so the design is deliberately typographic rather than risking hotlinked, stale, or misleading photos.

## HH0.4 挂牌状态核验时间与状态分级（2026-11-03 新增）
- **新字段**：`listings.status_verified_at`（可空整数，Unix 毫秒）记录研究 agent 最后一次打开该房源页面确认挂牌状态的时刻；`0004` 加法 migration 新增，老行 null 兼容。研究 agent 回传每条房源时必须给出该时刻（无法确认时给 null，不得编造）；ingest 原样落库。
- **展示**：每条房源的状态旁必须同时出现核验时间文字，由服务端纯函数 `formatStatusVerifiedAt`（`server/src/rubric.ts`）按 America/Los_Angeles 渲染为「状态核验于 MM-DD HH:mm」；缺失/无效时诚实显示「核验时间未知」。状态文字带符号（● 在售 / ◐ 降级 / ■ 排除），不只靠颜色区分（色弱规则）。
- **状态枚举扩展**：`active / contingent / pending / unknown` 之外新增 `sold / off_market`（schema 层枚举放宽，SQLite text 不强制，老数据兼容）。
- **过滤层选择：getReport 层过滤**（而非 ingest 层）。理由：① ingest 的接受/仲裁语义是 HH0.2/HH0.3 已关闭判据，在 ingest 层丢弃会改变其接受计数与错误语义；② sold/off_market 行保留在库中（含所属报告期次），状态被经纪纠正后下一轮研究可直接复活，无需重查；③ 读取层过滤保证任何历史报告被重新打开时同样不展示已售房源。`getReport` 只返回 actionable（active）与 degraded 两组，sold/off_market 永不出现在推荐面。
- **降级分区**：contingent / pending / unknown 为 degraded 层，与 active 分区展示：独立分区标题、◐ 符号＋「降级展示 · 非可直接行动」徽章与文字说明，不进入推荐排名、不与 active 混排；`rankListings` 在服务端排序时也保证 degraded 恒排在全部 actionable 之后。

## HH0.5 排名 rubric 与分项分（2026-11-03 新增）
- **新字段**（`listings`，均为可空整数 0–100，`0004` 加法 migration，老行 null 兼容）：`score_hard_criteria`（硬条件）、`score_environment`（环境）、`score_school`（学校/私校）、`score_age_condition`（房龄/状态）、`score_space`（空间）、`score_price_comps`（价格/可比成交）。研究 agent 回传每条房源必须给出 `subScores`；无法评估的单项给 null，不得编造、不得用 0 冒充。
- **公开权重与公式**（实现于服务端零 import 纯函数模块 `server/src/rubric.ts`，client 只渲染、不自算）：权重为硬条件 20%、环境 20%、学校/私校 20%、房龄/状态 15%、空间 10%、价格/可比成交 15%（合计 100%）。总分 = 已提供分项的加权平均，按已提供项的权重之和重新归一（`round(Σ 分项×权重 / Σ 已提供权重)`），四舍五入取整。缺项只降低完整度（响应带 `scoreComplete` / `scorePresentCount`，UI 明示「已评 X/6」），不拉低总分；六项全缺时总分为 null，落库回退到 agent 的综合参考分（老行同此路径）。
- **排名**：ingest 落库时由 `rankListings` 按总分降序重算 `rank`（同分先比价格低者优先，再按回传顺序），分项分与总分一并存入 `listings`；degraded 层整体排在 actionable 之后，sold/off_market 以尾随 rank 入库保留、不进可见列表。
- **展示**：每条房源在「查看判断依据」展开区内渲染分项分明细（六项逐项分数或「未评分」＋完整度说明）。

## Rejected approaches
- **Tried**: using `ctx.tool.web_search` alone to populate every field.
  **Why rejected**: search returned useful Redfin URLs and some structured listing snippets, but not consistently enough for road adjacency, school quality, status, and complete comparison; weekly refresh therefore uses a browsing research agent and typed callback.
- **Tried**: treating 1,500 sq ft as an implied hard minimum.
  **Why rejected**: the user said “不能太小” but gave no number; the artifact keeps size visible and provides an editable minimum-area control instead of inventing a cutoff.
- **Tried**: displaying remote listing photos.
  **Why rejected**: dynamic listing image URLs were not supplied as durable preflighted assets; the artifact avoids unowned or misleading imagery.
