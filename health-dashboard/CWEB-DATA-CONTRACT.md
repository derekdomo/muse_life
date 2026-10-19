# CWEB-SPIKE-001 数据与架构契约稿（2026-10-19，spike 首日稿；最终结论见 §6，2026-10-19 15 时 PDT 交付）

状态：spike 已交付（最终可行性结论见 §6，提前于 2026-10-21 18:00 PDT 目标）。首日稿基于仓库源码只读核对；§6 结论基于 S1 首片已上线实证（迁移 0009、getGameState、回灌源码逐项核对）。

## 1. 同源读取能力核对（源码事实）

- 健康事实源：space-4 自有 `health_snapshot` / `strength_training_snapshot` 两张单行快照表 + `readiness_history` 存档表 + `morning_checkin`；getDashboard 已在 owner 校验下一次返回 snapshot、readiness、readinessHistory、strength、dataStatus（含每来源 freshness/coverage/detail）。
- 结论：C-Web 角色/营地视图若落在同一 artifact（space-4）内，可直接复用 getDashboard 已返回的摘要与 sourceUpdatedAt/coverage，**不需要跨 artifact 调用、不需要新身份通道、不扩大 L0.1 例外**。这是首选部署，与 plans 的 C-Web 规格一致。
- 浏览器不直读 HealthKit、无连续后台运行：经验结算只能发生在页面打开/刷新读取时，契约按「打开时结算到当前完整窗口」设计，不承诺实时。

## 2. 字段 coverage（v1 可依赖 / 不可依赖）

| 字段 | 来源 | 状态语义 | v1 用途 |
| --- | --- | --- | --- |
| 步数（每日） | historyDaily[].steps + 当日 partial | available / missing(null) / partial(coverageIncomplete) | 活动经验（按日结算） |
| 主睡眠（归属醒来日） | historySleeps（date=醒来日）+ readiness 睡眠分项 | available / missing | 恢复经验（目标按比例） |
| 训练（力量） | strength 快照 workouts（completed 组） | available / missing / corrupt(占位) | 活动经验（与步数同日不重复计同一类别） |
| 站立时段 / mindful | 未接入 | unavailable | v1 不依赖；心灵任务只记自报完成标记 |
| HRV / 静息心率 | readiness 分项 | 背景解释 only | 不决定经验/战力、不扣状态 |

## 3. 持久化契约（游戏侧独立，不改真实健康记录）

- 新表（拟 `game_state` 单行 + `game_settlements` 按日账本）：只存游戏状态、每日奖励类别/本地日期/结算修订号/规则版本/必要来源引用（来源日期+sourceUpdatedAt），**不存健康原值**。
- 幂等：奖励身份 = owner + 本地日 + 类别 唯一；规则版本只审计不重发；partial 只预览、完整窗口后结算；迟到来源只发差量；来源修订显示可解释调整、不回收已解锁内容。
- 并发：沿用本仓已验证的单语句条件 upsert / 原子 batch 模式，禁止先查后写。
- 时区：全部按 America/Los_Angeles 本地日；睡眠归属醒来日。

## 4. 待核定（spike 剩余）→ 已全部核定（2026-10-19，见 §6）

- 平台是否允许在同一 artifact 内新增上述两张游戏表迁移（加法迁移，按既有 0006 模式预期可行，需 builder 侧确认）。→ **已实证可行**：迁移 0009 已上线。
- 结算触发点：getDashboard 内顺带结算 vs 独立 game action（倾向独立 action，失败隔离，不拖慢看板主响应）。→ **已定独立 action**：`getGameState` 打开时结算，失败与看板隔离。
- 若同源方案被平台否决，替代为跨 artifact 读 space-6 getDashboard（已有 L0.1 只读通道）+ 健康侧本地摘要，增量估算 +2–3 人日，不新开服务。→ **同源方案成立，替代方案不需要**，不产生该增量。

## 5. 合成测试矩阵（实现时必须覆盖）

完整 / partial / 缺失 / 迟到来源 / 重复结算 / 跨日 / LA 午夜与 DST / 同日并发 / 旧规则版本迁移 / 保存失败不丢档不重发。

## 6. 最终可行性结论（CWEB-SPIKE-001 交付，2026-10-19 15 时 PDT）

**结论：同源方案可行，无需跨 artifact 替代、无需新服务、不扩大 L0.1 例外。** spike 三项交付（同源读取/字段 coverage、权限与持久化契约、可行性结果）齐备，证据如下（均以本仓回灌源码为准，文件/行号见 changes.md 2026-10-19 15 时条目）：

1. **同源加表迁移可行（已上线实证）**：加法迁移 `drizzle/0009_add_game_state_and_settlements.sql` 已随 S1 首片在 space-4 上线；`game_state` 单行（total_xp / settled_through_date）、`game_settlements` 以 (local_date, category) 为主键，category ∈ steps/sleep/strength/quest_steps，只存 xp、rule_version、source_date、source_updated_at——**不存任何健康原值**，与 §3 持久化契约逐项一致。幂等由主键保证；已结算 (日期, 类别) 的 preview 在 handler 内被过滤，不重复展示/发放。
2. **结算触发点已定：独立 action**：`getGameState`（server/src/actions.ts）为严格所有者动作——非所有者返回 forbidden 且零游戏数据（L0.1 例外未扩）；handler 打开时基于已落库的 health/strength 快照调 `settleGame` 结算，异常时返回 ok:false 的空游戏态，客户端「角色」视图独立报错、健康看板其他视图不受影响（失败隔离成立，不拖慢/不阻断 getDashboard 主响应）。
3. **字段 coverage 按 §2 表成立，新增一条实证限定**：主任务/步数结算只读 `historyDaily`（仅完整日），当日 partial 步数不入账——多数日子页面如实显示「今日步数尚未同步」。这不是 spike 阻塞项：PM 2026-10-19 12:21 已沿 CWEB-MVP-001·S1 给出后续设计（今日活动预览层与已保存成长分列、partial 只预览不入账），归 S1 剩余可玩闭环（首玩目标 2026-10-26 18:00），不在 spike 内另开范围。站立/mindful 仍 unavailable、v1 不依赖，与 §2 一致。
4. **成本核定**：spike 实际在首日（2026-10-19）内完成——契约首稿、S1 首片加表实证与本结论同日交付，未动用跨 artifact 替代估算（+2–3 人日不需要）。CWEB-MVP-001 整体 12–20 人日估算不变，各交付片日期/成本由 MVP 推进时逐片记录，不因 spike 提前完成而压缩或冒称。
5. **如实保留（不冒称）**：§5 合成测试矩阵的完整覆盖（跨日/DST/同日并发/旧规则迁移等服务端决定性逻辑断言）属 S1 实现证据，S1 首片交付登记已注明「服务端决定性逻辑的证据捕获不完整」，沿 EVID-LIFE-001 在 S1 剩余闭环交付时补齐；本结论只就架构可行性、契约与权限/持久化落地作答，不把矩阵未全验说成已验。所有者本人首次打开「角色」视图的实测仍以所有者为准，28 日 dogfooding 不自上线申报起算。
