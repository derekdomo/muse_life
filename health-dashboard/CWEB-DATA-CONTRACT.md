# CWEB-SPIKE-001 数据与架构契约稿（2026-10-19，spike 首日稿）

状态：spike 进行中（目标 2026-10-21 18:00 PDT 前交最终可行性结论）。本稿基于仓库源码只读核对，未改任何线上行为。

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

## 4. 待核定（spike 剩余）

- 平台是否允许在同一 artifact 内新增上述两张游戏表迁移（加法迁移，按既有 0006 模式预期可行，需 builder 侧确认）。
- 结算触发点：getDashboard 内顺带结算 vs 独立 game action（倾向独立 action，失败隔离，不拖慢看板主响应）。
- 若同源方案被平台否决，替代为跨 artifact 读 space-6 getDashboard（已有 L0.1 只读通道）+ 健康侧本地摘要，增量估算 +2–3 人日，不新开服务。

## 5. 合成测试矩阵（实现时必须覆盖）

完整 / partial / 缺失 / 迟到来源 / 重复结算 / 跨日 / LA 午夜与 DST / 同日并发 / 旧规则版本迁移 / 保存失败不丢档不重发。
