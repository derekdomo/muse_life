# Changes

## 2026-10-13（OPS-001：协作框架）

- `OPS-001`：新增根目录 `AGENTS.md`、`scripts/validate-handoff.mjs` 与 GitHub Handoff Gate；PM 负责 plans，Muse 负责实现和交付证据，限制同时进行一项需求。三小时任务改为漏检验收；即时语义评审尚未集成，CI 不宣告产品通过。本次无 app、schema/migration 或数据变更；验证为 Node 语法、现有提交范围检查和 workflow 结构检查。回滚可 revert 本次框架提交，不影响 artifact 数据。

## 2026-10-13

- 仓库建立（derekdomo/muse_life，private）。
- 从 muse_incubator 迁入 4 个 interactive app 的代码（只含代码，不含 app.db 等数据；这批代码当天早些时候曾短暂推入 muse_incubator，按用户指示改归本仓）：
  - `house-hunting/`（南湾看房周报，源 artifact space-2）
  - `weekly-finance/`（每周财务总览，源 artifact space-3）
  - `health-dashboard/`（健康看板，源 artifact space-4）
  - `workout-log/`（训练记录，源 artifact space-6）
- 同步方式：本仓已配 deploy key，Muse 侧可用 git 直接读写。
- PM / Design 第一轮审计：重写根目录 `plans.md`，为四个 app 建立组合级产品标准、需求编号、P0/P1 优先级、逐项验收条件和 Muse 交付验证流程；本轮未修改业务代码或数据库。
- 静态审计记录 12 项待处理风险，优先级最高的是 owner/匿名访问边界、源码中的真实健康数据与固定设备 ID、异步刷新状态不可验证，以及训练输入可能未保存。由于本地仓不具备 Muse artifact builder/真实 `app.db`，这些结论已明确区分为代码确认风险与运行时待验项。
- 新增每 6 小时迭代协议：自动审查以 `plans.md` 中的源 commit 游标识别 Muse 新实现；通过时勾选需求，未通过时只在 `plans.md` 写返工要求，不由审查任务直接修改业务代码，也不产生无变化空提交。

## 2026-10-13（repo-plans-sync 首轮：P0 前三项）

- `F0.1` + `AUDIT-01`（weekly-finance）：`server/src/actions.ts` 删除 `isSignedInGuest`（`viewer != null && !isOwner`），改为统一 `isOwner(ctx) = ctx.viewer?.isOwner === true`；`getDashboard`、`refreshFinanceData`、`ingestFinanceData` 三个 action 对所有非 owner（含匿名 `viewer === null`）提前拒绝——读返回 `guest_denied` 且 `data: null`，refresh 返回 `forbidden`，ingest 在任何写入前返回 `{ ok: false, savedMonths: 0 }`。用户可见变化：非 owner 打开只显示「财务数据仅所有者可查看」，无数据、无刷新按钮。验证证据：artifact 构建审计以非 owner 身份实测渲染为无权限态、源码逐项复核三处判断；owner 路径除条件反转外未改动（审计环境无 owner 会话，owner 侧渲染未在本轮复验）。修改文件：`weekly-finance/server/src/actions.ts`（artifact 改动后回灌）。已知限制：每周刷新链路仍显示 2026-09-20 旧快照，属本项范围外既有问题。
- `L0.1` + `AUDIT-02`（health-dashboard）：`server/src/actions.ts` 全部 6 个 action（`getDashboard`、`initializeSnapshot`、`refreshHealthData`、`saveHealthSnapshot`、`saveMorningCheckin`、`saveStrengthTrainingSnapshot`）加服务端 `isOwner` 校验，非 owner 返回 `forbidden: true` 的 typed state、mutation 返回 `ok: false`，且在任何数据库读写之前拦截；客户端新增 `guest_denied` 无权限页。验证证据：构建审计以 guest 身份实测零健康数据、零 mutation 入口；owner 身份实测真实数据完好（具体数值不入 Git，2026-10-13 脱敏修正；晨检保存/回读正常）；`bunx tsc --noEmit` 通过。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`（另含 L0.4 的空态样式 `client/src/theme.css` 与 `DATA-PLAN.md` 同步）。（2026-10-13 晚勘误：本条原稿把 `saveMorningCheckin` 误写为不存在的 `saveHealthCheckin`，已按源码路由清单改正。）
- `L0.1` + `AUDIT-02`（workout-log）：`server/src/actions.ts` 全部 6 个 action（`getDashboard`、`startWorkout`、`updateSet`、`addSet`、`completeWorkout`、`discardWorkout`）加服务端 `isOwner` 校验，非 owner 读返回 `forbidden: true` 且 payload 为空、写返回 `forbidden` 且零写入；客户端新增无权限页。验证证据：构建审计以未登录与 guest 两种非 owner 身份实测零数据零入口；owner 实测进行中训练、历史、周复盘完好，自动预填行为不变；`bunx tsc --noEmit` 通过。修改文件：`workout-log/server/src/actions.ts`、`workout-log/client/src/App.tsx`（回灌）。（2026-10-13 晚勘误：本条原稿误称 8 个 action 并列出不存在的 `getState/toggleSet/removeSet`，已按源码路由清单改正为实际 6 个。）
- `L0.4` + `AUDIT-03`（health-dashboard，部分完成）：删除 `server/src/actions.ts` 中全部 `INITIAL_*` 种子常量——真实健康日序列、真实 HealthKit workout UUID、真实体重与睡眠记录及真实初始快照（具体条数与日期不入 Git，2026-10-13 脱敏修正）；`initializeSnapshot` 改为空操作（不写入任何快照），数据库无快照即首次启动的诚实空态（「还没有健康数据」+ 同步按钮），缺失字段 fallback 改为空数组。（2026-10-13 深夜勘误：原稿称「首次启动写入空快照」，与源码实际行为不符——`initializeSnapshot` 为无写入空操作，已按源码改正。）验证证据：源码扫描 UUID 命中 0；guest 与 owner 两种身份下空态/真实数据均按预期渲染（库内真实快照未被触碰）；`bunx tsc --noEmit` 通过。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/client/src/theme.css`、`health-dashboard/DATA-PLAN.md`（回灌）。已知限制（本项未勾选的原因）：health-dashboard 与 weekly-finance 的刷新 prompt 中仍保留 health-cli 设备标识——它标识用户自己的 Mac mini、是刷新链路定位数据源所需，删除会中断同步；需改运行时注入/占位符方案后再关闭 L0.4/AUDIT-03，已在 plans.md 对应条目注明。

## 2026-10-13（repo-plans-sync 第二轮：L0.1/L0.4 返工与证据补齐）

- `L0.4` + `AUDIT-03` 返工（文档脱敏）：按 PM 复核意见清理仓库内剩余真实健康明细。`health-dashboard/DATA-PLAN.md`：删除真实快照的采集时间/数据日期、逐日步数序列、睡眠 session 的起止时间与分期秒数、partial 日 HRV/心率实测值和个人基线数值；四组 health-cli 测试样例全部改写为明确标注「SYNTHETIC 示例，非真实数据」的结构说明，测试命令日期改为占位符；历史种子段落删除真实日期区间与条数。`weekly-finance/DATA-PLAN.md`：完整本地路径（含用户名）改为 `~/Library/...` 相对表述，快照文件名样例改为格式说明。`changes.md` 上一轮条目同步脱敏（见各条勘误注）。验证证据：全仓扫描——UUID 正则命中 0；旧稿中的真实数值（逐日步数序列、睡眠分期秒数、partial 日实测值、当日步数/静息心率）关键词命中 0（仅 plans.md 的 PM 审查记录在引用旧错误名时提及，不在本轮可改范围）；`*.md` 中 `/Users/` 命中 0。已知限制：`weekly-finance/server/src/actions.ts` 的刷新 prompt 仍含 Firance 数据目录的完整路径（含 Mac 用户名）——该 prompt 是运行时指令、设备 ID 已改为运行时按设备名解析（无写死 ID），路径改占位符需先验证 agent 文件工具对 `~/` 的展开行为，属 L0.4 剩余项，本轮未动业务代码。（2026-10-13 深夜更新：该剩余项已在下一轮关闭——刷新 prompt 改为运行时解析主目录构造路径，见 2026-10-13 深夜轮次条目。）修改文件：`health-dashboard/DATA-PLAN.md`、`weekly-finance/DATA-PLAN.md`、`changes.md`。
- `L0.1` + `F0.1` 证据补齐（action 验证表 + 非 owner 运行矩阵）：action 清单由脚本从三个 app 的 `server/src/actions.ts` 路由定义逐项提取（非手写）：weekly-finance 3 个（`getDashboard`、`refreshFinanceData`、`ingestFinanceData`）、health-dashboard 6 个（`getDashboard`、`initializeSnapshot`、`saveMorningCheckin`、`saveHealthSnapshot`、`saveStrengthTrainingSnapshot`、`refreshHealthData`）、workout-log 6 个（`getDashboard`、`startWorkout`、`updateSet`、`addSet`、`completeWorkout`、`discardWorkout`）；静态复核：15 个 handler 均在任何数据库访问之前执行 `isOwner(ctx)`（`ctx.viewer?.isOwner === true`）校验，`ingestFinanceData` 的校验位于 handler 首行（其 request schema 较长）。运行证据（2026-10-13 晚，本轮经 `artifact.invoke_action` 以非 owner 上下文逐个直接调用全部 15 个 action）：读 action 全部返回 typed 拒绝且 payload 为空（finance `access: guest_denied, data: null`；health/workout `forbidden: true` 且快照/训练列表为空）；写/初始化/刷新/callback action 全部在写入前拒绝（finance refresh 返回 `status: forbidden`、ingest 返回 `{ok: false, savedMonths: 0}`；health 的 initialize/refresh/checkin/两个 save callback 均返回 `forbidden: true, ok: false`，refresh 另返回 `accepted: false, taskId: null`；workout 五个写 action 均返回 `forbidden: true` 且零写入）。未完成部分（本项不自行勾选、保持运行待验）：本轮 invoke 上下文只能证明「非 owner」一列，无法区分已登录 guest 与匿名两列，也无法以 owner 身份复验正常路径；后台 schedule（`refreshHealthData` 每日刷新、财务周刷新）与 agent callback 的受信 owner 上下文仍需 PM 在 artifact 侧用 owner 会话与 schedule 运行记录验收。修改文件：仅 `changes.md`（本条证据）。
- 本轮未处理（留下轮，按推荐顺序）：`L0.2/L0.3/L0.5`、`L1`、`H0/H1`（含本轮新增 `H1.6–H1.8`）、`W0/W1`、新增 `H3/W3/W4`；其中 `H3/W3` 按推荐顺序在 `L1/H0/W0/W1/H1` 之后。

## 2026-10-13（同类产品调研候选排入队列）

- 用户批准启动同类产品调研（Whoop/Oura/Garmin/Bevel、Strong/Hevy/Fitbod/Boostcamp、Monarch/Copilot/Rocket Money/YNAB、Zillow/Redfin 等）提炼的新功能候选，`plans.md` 新增三节：`H4`（行为—恢复影响分析、训练负荷平衡 ACWR、睡眠债与今晚睡眠需求、状态模式、月度回顾与长期基线漂移）、`W5`（肌群周组数与恢复热力图、配重计算器与热身组生成、围度与体重趋势）、`F3`（净资产周变化归因拆解、订阅与周期支出体检、未来现金流日历预测、目标情景试算、交易待复核队列），共 13 项，均为 P2，排入推荐执行顺序第 7 步。
- 调研候选中的训练 T2（RPE/RIR、e1RM/PR）与 T3（停滞检测、deload 提示）已被现有 `W3.1`、`W3.3`、`W3.5` 覆盖，未重复纳入；看房类候选（周报增量 Diff、Quiet Score 等）经用户决定暂不纳入。
- 本次只改 `plans.md` 与本文件，未改业务代码；实现由后续同步轮次按推荐顺序推进，验收仍走 PM 流程。

## 2026-10-13（repo-plans-sync 第三轮：L0.4 源码脱敏 + 交付说明纠错）

- `L0.4` + `AUDIT-03` 返工（源码个人基线/路径脱敏）：按 PM 2026-10-13 23:08 复核意见处理最后两处源码残留。健康看板（space-4）：`refreshHealthData` 的 agent prompt 删除写死的个人步数基线与常见范围一句，改为与静息心率/HRV 相同口径——步数基线与范围从近 14 个完整日的步数数据本身派生（均值、均值 ± 标准差），不足 14 天或无数据时留 null / 标数据缺失，不代入任何固定值；artifact 编辑审计确认仅该一处 hunk，无 schema/UI/readiness 变化。每周财务（space-3）：`refreshFinanceData` 的 agent prompt 删除含用户名的完整本地路径，改为先在运行时解析当前登录用户主目录、再构造 `<home>/Library/Application Support/Firance/FinanceData/`（即 `~/...`），禁止写死用户名或绝对用户路径，无法解析主目录时以 `success:false` 回调 `ingestFinanceData` 诚实失败、不猜路径；prompt 其余行为不变。两处均先在 artifact 上修改并验收、再回灌仓库。验证证据：全仓扫描——UUID 正则命中 0、`INITIAL_*` 命中 0、写死步数基线字符串命中 0、源码中 `/Users/` 命中 0（`changes.md` 历史条目中仅剩描述扫描口径的字面提及，非真实路径）；本轮无 schema/migration 变化、无业务逻辑变更，仅刷新 prompt 文案与文档。未勾选原因：PM 要求的 owner 刷新成功与配置缺失失败的运行证据、首次空库不写 fixture 的运行证据仍待 owner 会话验收（本轮 invoke 上下文仍为非 owner，见下条），`L0.4/AUDIT-03` 保持未勾选。修改文件：`health-dashboard/server/src/actions.ts`、`weekly-finance/server/src/actions.ts`（artifact 回灌）。
- 交付说明纠错（PM 返工项）：`changes.md` 首轮 L0.4 条目「首次启动写入空快照」已改为与源码一致的表述（`initializeSnapshot` 为无写入空操作、无快照即诚实空态）并加勘误注；`weekly-finance/DATA-PLAN.md` 两处 callback 名由不存在的 `saveFinanceSnapshot` 改为真实路由 `ingestFinanceData`。另发现 artifact 侧 `weekly-finance/DATA-PLAN.md` 仍保留更早的未脱敏原文（完整本地路径、示例文件名、文件计数），已在 artifact 侧同步脱敏并以文件系统 grep 验证无 `/Users/` 与用户名；仓库版与 artifact 版现同为脱敏文本，个别措辞略有差异、语义一致。修改文件：`changes.md`、`weekly-finance/DATA-PLAN.md`。
- `L0.1` + `F0.1` 运行证据复探：本轮以 `artifact.invoke_action` 调用 space-3 / space-4 / space-6 的 `getDashboard`，仍返回非 owner 拒绝态（finance `guest_denied`、`data: null`；health、workout `forbidden: true` 且 payload 为空），与上一轮非 owner 矩阵一致；invoke 上下文无法区分已登录 guest 与匿名、无法提供 owner 列与后台 schedule / agent callback 的受信证据，两项继续保持「运行待验」，未自行勾选。
- 本轮新增待办盘点：基线后 `plans.md` 新增 `H4.1–H4.5`、`W5.1–W5.3`、`F3.1–F3.5` 共 13 项 P2（推荐执行顺序第 7 步），本轮按顺序未处理，留待 P0/P1 推进后按序实施；`F0.1` 被 PM 撤回勾选（与 `L0.1` 一致保持运行待验）。

## 2026-10-14（muse-life-plans-sync：L0.4 步数缺失值契约返工）

- `L0.4` + `AUDIT-03` 返工（步数基线/范围缺失值契约）：按 PM 2026-10-14 02:14 复核意见，只修这一原子边界，不动 readiness、不改其他指标、不回填个人常量。健康看板（space-4）先在 artifact 上修改验收、再回灌仓库：(1) `server/src/actions.ts` 的 `snapshotSchema.steps` 三个展示字段改为 `z.number().nonnegative().nullable()`——`baseline`（原 `positive()`）、`usualMin`（原 `nonnegative()`）、`usualMax`（原 `positive()`）现均可为 null（历史不足/无数据时缺失）且可为 0（14 个完整日全零时的有效基线）；(2) `refreshHealthData` prompt 的步数派生规则写明确：只计有步数数据的完整日，满 14 日时 baseline = 均值（全零为 0、是有效值）、usualMin = max(0, 均值 − 标准差)、usualMax = 均值 + 标准差（全零为 0），不足 14 日或无数据时三项均为 null；(3) `client/src/App.tsx` 的 `MetricBars` 基线参数改为 `number | null`，null 时标题行显示「基线 数据不足」、柱高 max 不再把 null 当 0 基线参与，今日页步数 KPI 在 baseline 为 null 时显示「基线数据不足」，不得显示 0 或假基线；静息心率/HRV 展示保持原样。
- schema/migration 兼容策略：无 migration、无数据库结构变化——快照 payload 是 JSON blob，`getDashboard` 读回走同一 `snapshotSchema.safeParse`（`normalizeStoredSnapshot`），nullable 是对旧数字快照的向后兼容放宽，旧快照（数字基线）与新快照（null 或 0）均可解析；回滚只需 revert 本次提交，旧代码读新快照时若三项为 null 会解析失败并显示空态（不写坏数据），这是回滚的已知限制。
- 验证证据（均为 synthetic 数据，无真实健康数值）：新增可复现脚本 `health-dashboard/validate-steps-contract.mjs`（从 `actions.ts` 实际源码抽取 steps schema 用 zod 重建后断言，需先装依赖），2026-10-14 本地运行 5/5 PASS——(a) 13 个完整日 → 三项 null 被保存 schema 接受；(b) 14 日全零 → 0/0/0 被接受；(c) 高方差样本（半数 0、半数大值）→ usualMin 钳制为 0 被接受；(d) 旧格式数字基线/范围仍可解析；(e) 负数仍被 nonnegative 拒绝。同轮在临时副本执行 `bun x tsc --noEmit -p server/tsconfig.json` 与 `-p client/tsconfig.json` 均退出 0（仓库外临时副本，未在仓库内 build）。artifact 运行证据：回灌前以非 owner 上下文 `invoke_action getDashboard` 返回 typed 拒绝态（`forbidden: true`、snapshot/readiness 为 null），证明新代码已上线且权限路径未破坏；owner 刷新 callback 保存/回读、配置缺失与首次空库证据本轮 invoke 上下文仍无法提供（与此前各轮相同限制），留 PM 以 owner 会话验收，本条不自行勾选 `L0.4`。
- 修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/validate-steps-contract.mjs`（新增）、`changes.md`。不在本次范围：`L0.1/F0.1` 三身份与 schedule/callback 运行证据、`OPS-001` 托管 CI 触发证据、artifact 侧 `DATA-PLAN.md` 与仓库版的历史措辞差异（未在本轮触碰）。

## 2026-10-14（muse-life-plans-sync：L0.4 缺基线首页结论与 synthetic 负下界返工）

- `L0.4` + `AUDIT-03` 返工（步数展示/状态边界统一）：按 PM 2026-10-14 05:18 复核（源 `be86e01`）意见，只统一这一个边界，不改 readiness、不改其他指标、不改服务端 schema 与刷新 prompt。健康看板（space-4）先在 artifact 上修改验收、再回灌仓库：`client/src/App.tsx` 的 `TodayView` 新增 `stepsBaselineMissing`（baseline/usualMin/usualMax 任一为 null）与 `stepStatus` 派生——(1) 首页昨日概览 `stepSummary`：仅当 `steps.value === null` 才说「步数未记录」；有值但基线不足（或服务端 status 为「数据缺失」却有值）时保留数值并显示「基线不足，无法比较」，不再输出「步数在常见范围」/偏低/偏高结论；基线完整时才按原 status 显示。(2) 步数 KPI 状态 chip：有值但基线不足时显示新增 Status 值「基线不足」（映射 status-missing 样式），value 为 null 时保持「数据缺失」，有效零基线时正常显示；KPI detail 与趋势区 MetricBars 的既有 null 行为不变（detail「基线数据不足」/「基线约 0」、趋势「基线 数据不足」）。
- `L0.4` synthetic 边界证据补强：`health-dashboard/validate-steps-contract.mjs` 新增派生输出断言（不再只断言 schema 接受/拒绝）——13 日 → 三项 null、无数据 → 三项 null、14 日全零 → 0/0/0、14 日同值 → sd 0 范围收敛到均值、半零半大值 → 下界恰为 0，以及真正负下界样例（13 个 0 + 1 个 14000：均值 1000、原始 mean−sd ≈ −2605.55 < 0），断言钳制后 usualMin = 0 且未钳制的负 usualMin 会被 schema 拒绝；实测移除 `max(0, …)` 后脚本退出 1（2 项断言失败），证明钳制回归可检出。新增纯 Node 无依赖脚本 `health-dashboard/validate-steps-display.mjs`：从 App.tsx 实际源码抽取三条步数展示表达式求值，7 组 synthetic 文案断言（null 基线 × 状态 正常/数据缺失/偏低、有值未记录互斥、零基线、旧数字基线 × 偏低/正常）全部 PASS。
- schema/migration 兼容策略：无变化——本轮仅客户端展示派生与仓库验证脚本；快照 schema、payload JSON blob、旧数字快照兼容与上轮相同。回滚 revert 本次提交即可，客户端回旧版只会恢复旧文案逻辑，不涉及数据。
- 验证证据（均为 synthetic 数据）：`node health-dashboard/validate-steps-contract.mjs`（临时目录、zod 取自 artifact 已装依赖）14/14 PASS；`node health-dashboard/validate-steps-display.mjs` 7/7 PASS；仓库外临时副本 `bun x tsc --noEmit -p client/tsconfig.json` 与 `-p server/tsconfig.json` 均退出 0。artifact 构建审计 verdict pass（source 对照确认三处改动均在 TodayView 内）；上线后以非 owner 上下文 `invoke_action getDashboard` 仍返回 `forbidden: true`、snapshot/readiness 为 null，权限路径未破坏。仍缺（本条不自行勾选 `L0.4`）：新 null/零/旧数字快照经受信 owner callback 保存再回读的运行证据、三视口（390×844 / 430×932 / 桌面）目视证据、owner 刷新成功/配置缺失/首次空库证据——本轮 invoke 上下文为非 owner、构建审计沙箱同样只能看到 owner 门禁页，留 PM 以 owner 会话验收。
- 修改文件：`health-dashboard/client/src/App.tsx`、`health-dashboard/validate-steps-contract.mjs`、`health-dashboard/validate-steps-display.mjs`（新增）、`changes.md`。不在本次范围：`L0.1/F0.1` 三身份与后台受信链证据、`OPS-001` 托管 Gate 触发证据、服务端 status 生成口径（客户端已按原始值/基线完整性覆盖显示，服务端 status 未动）。

## 2026-10-14（space-4 力量同步及时性修复回灌）

- 用户反馈健康看板力量训练数据不及时更新。根因：力量同步任务挂固定每日 dedupeKey，早上定时同步后白天再触发会被判为重复任务吞掉；前端只等 60 秒就放弃，任务完成时页面已不再刷新。
- artifact 侧修复（经 inspect 修复并审计通过后回灌本仓）：`server/src/actions.ts` 新增 `refreshStrengthTraining`、`getRefreshStatus` 两个 action，手动/全部同步改用 allowParallel 每次真正发起新任务；`getDashboard` 在力量数据超过 5 分钟未同步时自动发起力量同步并回传 taskId。`client/src/App.tsx` 在同一会话内轮询到终态（只认 completed/failed）后重绘，力量面板新增独立「同步训练」按钮与"训练数据更新于"时间，同步失败/超时明确提示。`client/src/theme.css`、`DATA-PLAN.md` 随之同步。
- 验证证据：构建审计两轮 pass、无控制台错误、双视口正常；非 owner 调用新 action 全部 forbidden 且零数据，owner 门禁未削弱。已知限制：审计环境为非 owner，owner 会话下"打开看板→自动同步→新数据即时显示"未实测；后台自动同步失败提示在已有数据视图下不显示（P2 小注记，手动同步提示正常）。
- 本条只回灌代码与文档，未改 `plans.md` 勾选（归 PM 验收）。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/client/src/theme.css`、`health-dashboard/DATA-PLAN.md`。

## 2026-10-14（muse-life-plans-sync：L0.4 DATA-PLAN 回灌隐私恢复 + 步数展示验证脚本修复）

- `L0.4` + `AUDIT-03` 返工（PM 2026-10-14 11:19 复核至 `7d848b7`）：力量同步回灌提交把已脱敏的 `health-dashboard/DATA-PLAN.md` 回退为含真实个人健康内容（真实快照采集/数据日期、个人基线、日序列、晨间与睡眠明细，位置为原文第 5–25、50、64–66 行一带）。本轮恢复为 PM 此前已接受的脱敏版本（`8b87c09` 版）：测试命令日期全部改为 `<start>`/`<end>` 占位符，四组样例均为明确标注「SYNTHETIC 示例，非真实数据」的无数值结构说明，个人基线只述「不复现于本仓」；同时保留回灌提交新增的 Timeliness fix (2026-10-14) 机制段落（无个人数值）。禁止给真实值加 synthetic 标签冒充脱敏——本轮是整段恢复脱敏文本，非标注洗白。artifact（space-4）侧同一 DATA-PLAN 同步经 artifact edit 脱敏：构建审计 verdict pass、fix_before_attesting 为空，构建方对全文枚举真实值 grep 零命中、Timeliness 段落保留、运行字节对比证实未改业务代码/UI；仓库版与 artifact 版语义一致（个别措辞略有差异，与此前轮次口径相同）。
- `L0.4` 步数展示验证脚本修复：`7d848b7` 把 `client/src/App.tsx` 的 `stepsBaselineMissing` 改名为 `stepsBaselineIncomplete` 并扩大语义（有值但服务端 status 为「数据缺失」也算不完整），`health-dashboard/validate-steps-display.mjs` 未同步、运行退出 1（expression not found）。本轮脚本同步改名与求值绑定，并新增 1 组覆盖扩大语义的 synthetic 断言（基线完整 + status 数据缺失 + 有值 → 「基线不足，无法比较」/ chip「基线不足」）；未改 App.tsx 展示逻辑本身。
- schema/migration 兼容策略：无变化——本轮仅文档脱敏恢复与仓库验证脚本，无 schema、migration、API、业务代码或 UI 改动；快照 JSON blob 与旧/新快照兼容口径与此前各轮相同。回滚只需 revert 本次提交（注意：回滚会同时恢复 DATA-PLAN 的未脱敏文本与脚本的失效状态，无数据影响）。
- 验证证据（只报位置/计数，不复述任何真实值）：`node health-dashboard/validate-steps-display.mjs` 退出 0，8/8 PASS（原 7 组 + 新增扩大语义 1 组）；`node --check health-dashboard/validate-steps-display.mjs` 与 `git diff --check` 均退出 0。全仓隐私扫描（94 个 tracked 文件）：UUID 正则命中 0 个文件、固定 device flag 赋值命中 0、源码（*.ts/*.tsx）中 `INITIAL_*` 命中 0、`/Users/` 命中 0；恢复后的 DATA-PLAN 专项扫描——测试命令真实日期 0、带单位的两位小数健康数值 0、七个以上逗号分隔的步数序列 0、HH:MM:SS 时刻 0（`INITIAL_` 与 `/Users/` 在 changes.md/plans.md/DATA-PLAN.md 中的剩余命中均为描述脱敏口径的字面提及，非真实值）。artifact 运行证据：脱敏 edit 上线后以非 owner 上下文 `invoke_action getDashboard` 仍返回 `forbidden: true` 且 snapshot/readiness 为 null，权限路径未破坏。未完成（本条不自行勾选 `L0.4`/`AUDIT-03`，保持 PM 待验）：`validate-steps-contract.mjs` 本地因仓库缺 zod 依赖报 ERR_MODULE_NOT_FOUND 未复跑（与 PM 记录的同一限制；本轮可复现断言为 display 脚本 8/8 与 PM 独立抽取的 18 个 synthetic 表达式断言）；合法完整 synthetic null/零/旧数字快照经受信 owner callback 保存/回读、三视口（390×844 / 430×932 / 桌面）、owner 刷新成功/配置缺失/首次空库证据仍待 owner 会话验收。
- 修改文件：`health-dashboard/DATA-PLAN.md`、`health-dashboard/validate-steps-display.mjs`、`changes.md`。不在本次范围（按 PM「一次只推进 L0.4」）：`L0.1/F0.1` 三身份与后台受信链证据、力量同步的 `H0.4/L1.1–L1.5` 候选范围、readiness 与其他功能扩展。

## 2026-10-15（力量同步链修复回灌：space-4 回调通道 + space-6 读取放行）

- 背景：用户反馈健康看板力量数据冻在 2026-10-11 一次腿部训练。根因链：`L0.1` 严格 owner 门禁把无浏览器身份的定时任务/回调回写（space-4）和健康看板同步任务对 `训练记录` 的内部读取（space-6 `getDashboard`）一并误杀；定时任务天天报 succeeded，但两份快照自 2026-10-13 早上起零落盘。
- space-4（已在 artifact 修复并回灌）：`refreshHealthData` 定时入口与 `saveHealthSnapshot`、`saveStrengthTrainingSnapshot` 两个回写回调接受"owner 或无 viewer 的内部调用"，带身份的非 owner 仍拒绝；两个 persist 路径加单调守卫，迟到旧任务不得覆盖更新的快照；读入口（`getDashboard`、`getRefreshStatus`）保持严格 owner。验证：修复后实际触发生产刷新，新快照落盘并合并进主库，为 2026-10-13 以来首次成功保存。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/DATA-PLAN.md`（文档同步说明通道修正与单调守卫；回灌前已逐行核对 diff，无具体健康数值）。
- space-6（已在 artifact 修复并回灌）：`getDashboard` 新增 `isOwnerOrSyncChannel`——接受 owner 或无 viewer 的内部同步调用；带身份的非 owner 返回 forbidden 零数据；全部写 action 保持严格 owner（同通道探针 `updateSet`、`startWorkout` 均 forbidden 且零写入）。验证：同一内部通道改前 forbidden 零数据，改后可读全部 6 次训练（含 10/13 推、10/14 拉）。修改文件：`workout-log/server/src/actions.ts`、`workout-log/DATA-PLAN.md`（新增 Cross-artifact sync read 一节）。
- 残余风险（如实记录，PM 验收 L0.1 时需纳入）：平台没有可验证的服务凭据机制，"无 viewer"不等于身份证明；能以无身份方式调用 action 通道的调用方能读到训练历史。放行范围已最小化（space-6 仅 `getDashboard` 只读、space-4 仅不返回数据的入口与回调）；平台提供服务身份后应改为凭据校验。安全审查原评 high。
- 本条只回灌代码与文档，未改 `plans.md` 勾选（归 PM 验收）。

## 2026-10-15（数据一体原则入 plans）

- 用户定调：Muse Life 四个 app 是一体的，内部数据存储也应一体；界面独立不等于数据分家。`plans.md` 仓库边界新增"数据一体原则"：同一份数据只有一个事实源，跨 app 走可靠内部通道；平台做不到物理共享时，同步链路的触发、失败与权限例外必须显式设计并记录，不得静默失败。本次只改文档，未改业务代码。

## 2026-10-15（space-4 一体层与打开即现拉回灌）

- 按用户"数据一体、想别的办法"的方向，健康看板在 artifact 侧新增体验层一体（平台无共享数据库的替代实现），本次回灌本仓：
  - 同步台账 `sync_log`（migration `0005`）：每次健康/力量快照保存成功写 `saved` 条目；同步任务失败、或完成但未满足保存契约时由 `getRefreshStatus` 写 `failed` 条目；`getSyncDiagnostics` 写 `diagnosed` 条目。失败从此有据可查，不再静默。
  - 数据状态（`getDashboard.dataStatus`）：服务端按快照 + 最近 8 条台账计算每来源新鲜度（fresh/today/stale/missing）、年龄、数据日期与总体状态，客户端在今日页渲染「数据状态」面板。
  - 统一时间线（`getDashboard.unifiedTimeline`）：健康日数据、睡眠、力量训练按本地日期合并（最近 14 天），今日页看 7 天、历史看 14 天。
  - 一键体检 `getSyncDiagnostics`（owner-only）：无 agent 的确定性检查——快照存在性、每来源新鲜度、最近一次力量训练、统一时间线重叠、近期台账失败，返回白话结论与逐项明细，并自写台账。
  - 打开即现拉：`getDashboard` 取消力量快照 >5 分钟的过期阈值，每次 owner 打开都发起（或复用 2 分钟内已发起的）力量同步任务，先渲染现有快照、落地后同页重绘；App 壳轮询到的后台同步失败提示现透传进 Dashboard，已有数据时也可见。
- 验证（artifact 侧）：构建审计 pass、无控制台错误、双视口正常；非 owner 调用 `getDashboard`/`getSyncDiagnostics`/`logSyncEvent` 全部 forbidden 零数据，新读口未放宽门禁。未实测（如实记录）：审计为非 owner 身份，owner 打开看板后的面板渲染与"打开→同步→新训练出现"端到端链路未在审计环境验证；沙箱 `sync_log` 为 0 行，台账首行需 owner 侧真实同步后产生。
- 本条只回灌代码、migration 与文档，未改 `plans.md` 勾选（归 PM 验收）。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/server/src/schema.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/client/src/theme.css`、`health-dashboard/DATA-PLAN.md`、`health-dashboard/drizzle/0005_add_sync_log_and_unified_view_support.sql`、`health-dashboard/drizzle/meta/_journal.json`。

## 2026-10-15（致 PM：平台服务身份限制登记）

> 本条由实现方按用户 2026-10-15 明确指示登记：用户认为 PM 不了解平台限制，要求把 limitation 正式告知 PM。本条只登记事实与证据，不预设用户在 L0.1/AUDIT-02 上的最终决定。

- **用户需求（原话语境）**：健康看板的力量数据来自同为用户自己的「训练记录」，应自动及时同步。用户评价：这是"这么简单的要求"，现行验收标准使它实现不了。
- **PM 验收标准（`plans.md` L0.1 / AUDIT-02，2026-10-15 复核）**：受信后台须有可验证身份（当前 app/来源/任务归属与权限范围），不能仅凭缺 viewer、请求参数或注释；无此能力时保留门禁并明示同步不可用。
- **平台事实（实现方核查结论，含源码与实测）**：当前 Muse artifact 运行时不存在服务身份机制——
  1. action 的 `ctx` 只暴露浏览器侧 `viewer`（owner / 已登录非 owner / null）或完全无 viewer；后台 schedule 触发（`refreshHealthData` 定时入口）、agent task 保存回调（`saveHealthSnapshot`、`saveStrengthTrainingSnapshot`）、跨 artifact 已发布 action 调用（space-4 同步任务读 space-6 `getDashboard`）到达 handler 时，均不携带可验证的调用方身份：无 token、无签名、无 app/task 归属字段。
  2. artifact 作者没有任何 API 为自己的后台任务签发或校验凭据。两个 save callback 的唯一期望调用方就是本 artifact 自己 spawn 的任务，但平台在回调通道上不注入身份，作者无从校验。
  3. 实测佐证：PM 本轮以独立脚本抽取两 app 的 guard 谓词，确认四种上下文形状为 owner / guest / null / 缺 viewer——这正是运行时仅有的身份信息；space-6 修复时的独立安全审查亦明确记录"平台目前没有向 artifact 作者提供可替代的服务身份凭据机制"。
- **结论**：L0.1 对受信后台的验收条件在当前平台**不可实现**，原因是运行时能力缺失，不是实现方未做或不愿做。严格执行的实际后果：健康/力量全部后台同步（定时刷新、保存回调、每 2 小时看门狗）被拒绝，两份快照停止更新（2026-10-13 至 10-14 已实际发生过一次，任务天天报 succeeded 而零落盘），产品只剩手动打开时的旧数据。
- **请 PM 处理**：在平台提供服务身份能力之前，请就 L0.1 的后台通道部分给出可执行的验收口径（例如按用户批准的例外备案验收：范围、调用方、残余风险、有效期/复审触发、回退条件），或明确将"后台同步不可用"记为平台限制下的已知产品状态。用户侧最终决定仍待用户拍板，本条不代替决定。

## 2026-10-15（muse-life-plans-sync：L1-RACE-001 快照落库竞态改原子条件写入）

- `L1-RACE-001`（health-dashboard）：`server/src/actions.ts` 两条落库路径改造。`persistSnapshot` / `persistStrengthSnapshot` 删除「先 SELECT payload、JS 里比 updatedAt、再无条件 upsert」的两步写法，改为单条 SQLite 语句：Drizzle `insert … onConflictDoUpdate` 带 `setWhere: excluded.source_updated_at >= <表>.source_updated_at`，并 `.returning({ id })` 判定是否真正落库（无返回行 = 被更新的已存版本拒绝）。首次创建竞争与冲突更新由同一语句处理；相等时间戳按幂等重写计 applied。两函数改为返回 `Promise<boolean>`；仅 applied 时写 sync_log 的 saved 条目并 `invalidateQueries`，ignored 时不写 saved 日志。`saveHealthSnapshot` 保留旧 strengthTraining 的预读合并逻辑不变。
- applied/ignored 区分：两个 save action 改用新响应 schema `saveSnapshotResponse`，在既有 `ok`/`forbidden` 字段之外新增 `outcome: "applied" | "ignored" | "forbidden"`（ignored 时 `ok` 保持 true——回调本身成功，只是写入被更新版本取代）。
- null 版本契约（力量路径）：`updatedAt` 为 null 的力量快照把 `source_updated_at` 列写为 epoch（最旧版本），不再跳过守卫、也不再以落库时刻冒充版本；效果是 null 仅能在库中尚无力量快照行时首次创建落库，已存任何有效快照时必被 ignored。payload 的 `updatedAt` 保持 null，展示层新鲜度仍按缺失处理。健康路径 `updatedAt` 必填不变。无 schema/migration 变更（`payload` 与 `source_updated_at` 列已存在），旧格式快照照常可读。
- 来源版本契约：`STRENGTH_SYNC_PROMPT` 改为要求同步任务在调用训练记录 `getDashboard` 之前先记 `readStartedAt`，并把回调 payload 的 `updatedAt` 设为该读取开始时刻，明确禁止设为任务完成/回调时刻，并写明理由（落库按读取开始时刻排序，早开始的读取即使晚完成也会被原子条件写入拒绝）。健康刷新 prompt 的 updatedAt 口径未动。权限门禁 `isOwner` / `isOwnerOrSyncChannel` 语义未动。
- 验证证据：新增 `health-dashboard/validate-persist-race.mjs`（纯 Node 24 `node:sqlite`，无依赖）——(a) 对 actions.ts 真实源码断言两条 persist 路径均为带 `>=` 守卫的单语句条件 upsert + RETURNING，且无先查后写的无条件 upsert 残留，另断言 outcome 字段与 readStartedAt prompt 契约；(b) 以与生产相同的语句形状在内存 SQLite 上跑确定性交错矩阵：首次创建竞争（两种落库顺序）最终只剩一行且为较新版本、02:00 先落库后 01:00 被 ignored 且最终仍 02:00、相同时间戳幂等 applied、较旧版本被拒、null（epoch）不能覆盖有效快照、null 首次创建可落库且随后被有效版本取代。运行结果：**41 passed, 0 failed**，退出码 0。`server` 与 `client` 两侧 `tsc --noEmit` 均退出码 0。artifact 侧仅以非 owner 身份 invoke `getDashboard` 复核门禁：返回 `forbidden: true` 且 snapshot/readiness/dataStatus 均为 null、时间线为空（零数据）；未用真实或 synthetic 数据调用两个 save action 写生产库。artifact 构建与审计通过（audit 2026-10-15T18-19-43Z，verdict pass，无 fix_before_attesting）。
- 已知限制：并发矩阵以语句形状 + 确定性落库顺序模拟竞态（SQLite 本就串行化语句，竞态的本质是落库顺序而非语句内并行）；save 回调的 applied/ignored 端到端行为未在生产库实测（按任务约束不写生产库），其正确性由语句语义与源码断言支撑。回滚：revert 本条涉及的 `health-dashboard/server/src/actions.ts` 与新增脚本即可，无数据迁移需回退。

## 2026-10-15（muse-life-plans-sync：L1-RACE-001 收尾——HealthKit 读取开始版本 + 同版本回调幂等）

- `L1-RACE-001`（health-dashboard，按 PM 2026-10-15 11:28 复核的两条返工收尾；本项仍不自行勾选，待 PM 复核）：先在 artifact（space-4）修改并审计通过、再回灌本仓，仅改 `server/src/actions.ts`，无 UI/schema/migration 变化，权限门禁语义未动。
  - **HealthKit 来源版本契约**：`refreshHealthData` 的 agent prompt 删除「Set updatedAt to the real current instant」，改为与力量路径相同的可执行契约——执行任何 health-cli 查询之前先记录 `readStartedAt`，payload 的 `updatedAt` 设为该读取开始时刻，明确禁止完成/回调时刻并写明理由。PM 的倒序完成反例（早读取任务晚完成、按完成时刻冒充新版本）从契约层关闭：落库版本只由读取开始时刻决定。
  - **同版本回调幂等与冲突策略**：两条 persist 路径的守卫由 `>=` 改为严格 `>`，只有严格更新才算 `applied` 并写 saved 台账 + invalidate；写入未落库时仅再读已存行做结果分类（分类读发生在写入尝试之后、不参与是否写入的决定，比较与写入仍是单条原子条件语句）。persist 返回类型由 `Promise<boolean>` 改为 `Promise<PersistOutcome>`：同版本同 payload → `duplicate`（不写 saved、不 invalidate、快照不变）；同版本不同 payload → `conflict`（先到者胜出，不覆盖、不写 saved）；已存版本更新 → `ignored`（行为不变）。力量 null→epoch 契约保持（null 首次创建 applied、同 null 同内容 duplicate、有效快照后 late null ignored）。
  - **typed outcome 扩展**：`saveSnapshotResponse.outcome` 枚举扩展为 `applied | duplicate | conflict | ignored | forbidden`；两个 save action 直接返回 persist 结果；duplicate/conflict/ignored 时 `ok` 保持 true，forbidden 仍 `ok: false`。旧字段 `ok`/`forbidden` 含义不变，为附加式扩展，旧快照 payload 读取兼容不变。
- 验证证据（均为 synthetic/探针数据，无真实健康数值入仓）：(1) `health-dashboard/validate-persist-race.mjs` 已按 PM 要求重写——不再是手写等价 SQL + regex：以 `node:module.stripTypeScriptTypes` 抽取**真实** persist 函数与**真实**两个 save handler，经受控 Drizzle 形 adapter（守卫运算符直接取自生产 sql 文本）跑内存 SQLite。42/42 PASS，退出 0：双路首次创建竞争（两种落库顺序）、固定旧版本 ignored、同版本同 payload duplicate（saved 与 invalidate 计数保持 1）、同版本不同 payload conflict（首写胜出）、严格更新 applied、力量 null 三态、HealthKit 倒序完成反例（version=readStartedAt 的早读晚完成被 ignored、新读保留）、handler 层非 owner forbidden 零写入 + 同步通道 applied→duplicate→conflict/ignored 全序列；变异敏感性——把守卫改回 `>=` 后 duplicate 断言实测失败（被误判 applied 且 saved 增至 2）、把 health prompt 的 readStartedAt 抹除后契约检查失败。(2) 类型检查（更正）：本轮曾声称仓库外临时副本 `bun x tsc --noEmit` server/client 均退出 0，该声称有误——实际运行中 `@hatch/space-sdk` 在 artifact 构建环境之外无法解析（TS2307，级联 implicit-any，server/client 均退出 2），独立 tsc 在本环境不可得，与 PM 此前记录的缺依赖阻塞一致；类型正确性以构建方在带 SDK 环境的 build 成功 + audit pass 为据，不另计独立 tsc 证据。(3) artifact 构建审计 verdict pass、fix_before_attesting 为空；构建方在沙箱 DB 用 `artifact.invoke_action` 以 2099 版本探针实测双路 applied → duplicate → conflict → ignored（null 在已有有效快照时 ignored），全部非 forbidden 结果 ok=true；本轮另以非 owner 上下文 invoke `getDashboard` 返回 `forbidden: true` 且零数据，门禁未破坏。生产库未做任何写入（探针只在沙箱 DB）。
- 已知限制：真函数/handler 抽取运行仍使用受控 adapter 与内存库，不证明生产 Drizzle SQL 生成与请求 schema 校验；artifact 沙箱探针不是用户生产库的保存/回读，生产环境两 save 的 applied/ignored/duplicate/conflict 实测与页面保持新版本的证据仍待 PM/owner 侧验收。回滚：revert 本次提交即可（actions.ts 与验证脚本），无数据迁移需回退；回滚后同版本重试将恢复重复 saved 的旧行为。
