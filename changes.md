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
- `L0.1` + `AUDIT-02`（health-dashboard）：`server/src/actions.ts` 全部 6 个 action（`getDashboard`、`initializeSnapshot`、`refreshHealthData`、`saveHealthSnapshot`、`saveHealthCheckin`、`saveStrengthTrainingSnapshot`）加服务端 `isOwner` 校验，非 owner 返回 `forbidden: true` 的 typed state、mutation 返回 `ok: false`，且在任何数据库读写之前拦截；客户端新增 `guest_denied` 无权限页。验证证据：构建审计以 guest 身份实测零健康数据、零 mutation 入口；owner 身份实测真实数据完好（当日步数 4,485、静息心率 65，晨检保存/回读正常）；`bunx tsc --noEmit` 通过。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`（另含 L0.4 的空态样式 `client/src/theme.css` 与 `DATA-PLAN.md` 同步）。
- `L0.1` + `AUDIT-02`（workout-log）：`server/src/actions.ts` 全部 8 个 action（`getState`、`startWorkout`、`toggleSet`、`updateSet`、`addSet`、`removeSet`、`completeWorkout`、`discardWorkout`）加服务端 `isOwner` 校验（含可信 agent callback），非 owner 读返回 `guest_denied`、写返回 `forbidden` 且零写入；客户端新增无权限页。验证证据：构建审计以未登录与 guest 两种非 owner 身份实测零数据零入口；owner 实测进行中训练、历史、周复盘完好，自动预填行为不变；`bunx tsc --noEmit` 通过。修改文件：`workout-log/server/src/actions.ts`、`workout-log/client/src/App.tsx`（回灌）。
- `L0.4` + `AUDIT-03`（health-dashboard，部分完成）：删除 `server/src/actions.ts` 中全部 `INITIAL_*` 种子常量——27 天真实健康日序列（2026-09-05–10-01）、13 个真实 HealthKit workout UUID、3 条真实体重、7 晚真实睡眠及真实初始快照；`initializeSnapshot` 改为空操作，首次启动写入空快照并显示诚实空态（「还没有健康数据」+ 同步按钮），缺失字段 fallback 改为空数组。验证证据：源码扫描 UUID 命中 0；guest 与 owner 两种身份下空态/真实数据均按预期渲染（库内真实快照未被触碰，仍显示 13 天数据）；`bunx tsc --noEmit` 通过。修改文件：`health-dashboard/server/src/actions.ts`、`health-dashboard/client/src/App.tsx`、`health-dashboard/client/src/theme.css`、`health-dashboard/DATA-PLAN.md`（回灌）。已知限制（本项未勾选的原因）：health-dashboard 与 weekly-finance 的刷新 prompt 中仍保留 health-cli 设备标识——它标识用户自己的 Mac mini、是刷新链路定位数据源所需，删除会中断同步；需改运行时注入/占位符方案后再关闭 L0.4/AUDIT-03，已在 plans.md 对应条目注明。
