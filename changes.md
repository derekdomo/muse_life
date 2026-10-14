# Changes

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
- `L0.4` + `AUDIT-03`（health-dashboard，部分完成）：删除 `server/src/actions.ts` 中全部 `INITIAL_*` 种子常量——真实健康日序列、真实 HealthKit workout UUID、真实体重与睡眠记录及真实初始快照（具体条数与日期不入 Git，2026-10-13 脱敏修正）；`initializeSnapshot` 改为空操作，首次启动写入空快照并显示诚实空态（「还没有健康数据」+ 同步按钮），缺失字段 fallback 改为空数组。验证证据：源码扫描 UUID 命中 0；guest 与 owner 两种身份下空态/真实数据均按预期渲染（库内真实快照未被触碰）；`bunx tsc --noEmit` 通过。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/client/src/theme.css`、`health-dashboard/DATA-PLAN.md`（回灌）。已知限制（本项未勾选的原因）：health-dashboard 与 weekly-finance 的刷新 prompt 中仍保留 health-cli 设备标识——它标识用户自己的 Mac mini、是刷新链路定位数据源所需，删除会中断同步；需改运行时注入/占位符方案后再关闭 L0.4/AUDIT-03，已在 plans.md 对应条目注明。

## 2026-10-13（repo-plans-sync 第二轮：L0.1/L0.4 返工与证据补齐）

- `L0.4` + `AUDIT-03` 返工（文档脱敏）：按 PM 复核意见清理仓库内剩余真实健康明细。`health-dashboard/DATA-PLAN.md`：删除真实快照的采集时间/数据日期、逐日步数序列、睡眠 session 的起止时间与分期秒数、partial 日 HRV/心率实测值和个人基线数值；四组 health-cli 测试样例全部改写为明确标注「SYNTHETIC 示例，非真实数据」的结构说明，测试命令日期改为占位符；历史种子段落删除真实日期区间与条数。`weekly-finance/DATA-PLAN.md`：完整本地路径（含用户名）改为 `~/Library/...` 相对表述，快照文件名样例改为格式说明。`changes.md` 上一轮条目同步脱敏（见各条勘误注）。验证证据：全仓扫描——UUID 正则命中 0；旧稿中的真实数值（逐日步数序列、睡眠分期秒数、partial 日实测值、当日步数/静息心率）关键词命中 0（仅 plans.md 的 PM 审查记录在引用旧错误名时提及，不在本轮可改范围）；`*.md` 中 `/Users/` 命中 0。已知限制：`weekly-finance/server/src/actions.ts` 的刷新 prompt 仍含 Firance 数据目录的完整路径（含 Mac 用户名）——该 prompt 是运行时指令、设备 ID 已改为运行时按设备名解析（无写死 ID），路径改占位符需先验证 agent 文件工具对 `~/` 的展开行为，属 L0.4 剩余项，本轮未动业务代码。修改文件：`health-dashboard/DATA-PLAN.md`、`weekly-finance/DATA-PLAN.md`、`changes.md`。
- `L0.1` + `F0.1` 证据补齐（action 验证表 + 非 owner 运行矩阵）：action 清单由脚本从三个 app 的 `server/src/actions.ts` 路由定义逐项提取（非手写）：weekly-finance 3 个（`getDashboard`、`refreshFinanceData`、`ingestFinanceData`）、health-dashboard 6 个（`getDashboard`、`initializeSnapshot`、`saveMorningCheckin`、`saveHealthSnapshot`、`saveStrengthTrainingSnapshot`、`refreshHealthData`）、workout-log 6 个（`getDashboard`、`startWorkout`、`updateSet`、`addSet`、`completeWorkout`、`discardWorkout`）；静态复核：15 个 handler 均在任何数据库访问之前执行 `isOwner(ctx)`（`ctx.viewer?.isOwner === true`）校验，`ingestFinanceData` 的校验位于 handler 首行（其 request schema 较长）。运行证据（2026-10-13 晚，本轮经 `artifact.invoke_action` 以非 owner 上下文逐个直接调用全部 15 个 action）：读 action 全部返回 typed 拒绝且 payload 为空（finance `access: guest_denied, data: null`；health/workout `forbidden: true` 且快照/训练列表为空）；写/初始化/刷新/callback action 全部在写入前拒绝（finance refresh 返回 `status: forbidden`、ingest 返回 `{ok: false, savedMonths: 0}`；health 的 initialize/refresh/checkin/两个 save callback 均返回 `forbidden: true, ok: false`，refresh 另返回 `accepted: false, taskId: null`；workout 五个写 action 均返回 `forbidden: true` 且零写入）。未完成部分（本项不自行勾选、保持运行待验）：本轮 invoke 上下文只能证明「非 owner」一列，无法区分已登录 guest 与匿名两列，也无法以 owner 身份复验正常路径；后台 schedule（`refreshHealthData` 每日刷新、财务周刷新）与 agent callback 的受信 owner 上下文仍需 PM 在 artifact 侧用 owner 会话与 schedule 运行记录验收。修改文件：仅 `changes.md`（本条证据）。
- 本轮未处理（留下轮，按推荐顺序）：`L0.2/L0.3/L0.5`、`L1`、`H0/H1`（含本轮新增 `H1.6–H1.8`）、`W0/W1`、新增 `H3/W3/W4`；其中 `H3/W3` 按推荐顺序在 `L1/H0/W0/W1/H1` 之后。

## 2026-10-13（同类产品调研候选排入队列）

- 用户批准启动同类产品调研（Whoop/Oura/Garmin/Bevel、Strong/Hevy/Fitbod/Boostcamp、Monarch/Copilot/Rocket Money/YNAB、Zillow/Redfin 等）提炼的新功能候选，`plans.md` 新增三节：`H4`（行为—恢复影响分析、训练负荷平衡 ACWR、睡眠债与今晚睡眠需求、状态模式、月度回顾与长期基线漂移）、`W5`（肌群周组数与恢复热力图、配重计算器与热身组生成、围度与体重趋势）、`F3`（净资产周变化归因拆解、订阅与周期支出体检、未来现金流日历预测、目标情景试算、交易待复核队列），共 13 项，均为 P2，排入推荐执行顺序第 7 步。
- 调研候选中的训练 T2（RPE/RIR、e1RM/PR）与 T3（停滞检测、deload 提示）已被现有 `W3.1`、`W3.3`、`W3.5` 覆盖，未重复纳入；看房类候选（周报增量 Diff、Quiet Score 等）经用户决定暂不纳入。
- 本次只改 `plans.md` 与本文件，未改业务代码；实现由后续同步轮次按推荐顺序推进，验收仍走 PM 流程。
