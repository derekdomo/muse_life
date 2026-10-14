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

## Rejected approaches
- **Tried**: using `ctx.tool.web_search` alone to populate every field.
  **Why rejected**: search returned useful Redfin URLs and some structured listing snippets, but not consistently enough for road adjacency, school quality, status, and complete comparison; weekly refresh therefore uses a browsing research agent and typed callback.
- **Tried**: treating 1,500 sq ft as an implied hard minimum.
  **Why rejected**: the user said “不能太小” but gave no number; the artifact keeps size visible and provides an editable minimum-area control instead of inventing a cutoff.
- **Tried**: displaying remote listing photos.
  **Why rejected**: dynamic listing image URLs were not supplied as durable preflighted assets; the artifact avoids unowned or misleading imagery.
