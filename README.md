# Muse Life

Derek 的生活类 Interactive Apps 源码库（与 `muse_incubator` 分工：那边是游戏等静态 artifact，这边是带服务端和数据的生活应用）。

## 内容

每个文件夹是一个 Muse interactive app 的**代码部分**（前端 client + 服务端 server + 数据库迁移 drizzle）：

- `house-hunting/` — 南湾看房周报（Santa Clara / Sunnyvale / Cupertino）
- `weekly-finance/` — 每周财务总览（按 Firance 口径聚合）
- `health-dashboard/` — 健康看板（Apple Health 数据、训练容量与趋势）
- `workout-log/` — 训练记录（训练录入面板，含自动预填）

## 重要说明

- **数据不在仓内**：各 app 的数据库（app.db，含健康/财务/训练等真实个人数据）从未推送，也不要推。
- **依赖 Muse 运行时**：这些 app 在 Muse 的 artifact 运行时里运行（数据接口、定时刷新由运行时提供），clone 到本地不能直接跑起来；本仓的用途是代码归档与多方协作（Muse / 本地其他模型都能读改，再回灌到 artifact）。
- 排除项：node_modules、构建产物（dist）、图标等二进制文件。

## 协作约定（重要）

根目录长期维护两个文件，多方靠它们保持同步：

- `changes.md` — 变更日志：每次改动后追加一条。
- `plans.md` — 计划与决策：当前状态、接下来做什么、已拍板的方向。

改代码前先看这两个文件，改完必须同步更新。
