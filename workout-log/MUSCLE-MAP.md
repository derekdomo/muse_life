# W6.2 / H4.6 共用动作→肌群映射（规则稿 v1，2026-10-19）

状态：规则稿（实现方交付，PM 评审记录为准）。space-6 维护唯一映射，space-4 经既有训练摘要通道消费同一版本，不另建手工表、不新增身份例外。

## 契约

- 键：现有稳定 `exercise_key`（计划模板与训练记录共用）；名称改动不改 key。
- 每条映射字段：`exercise_key`、`primary`（主要肌群，1–2 个）、`secondary`（次要肌群，可空数组）、`map_version`（本稿为 1）、`media`（示意素材引用与状态：`none` 表示暂无合规素材，页面留空不配错图）。
- 肌群词表（固定枚举）：胸、肩前束、肩中束、肩后束、背阔肌、斜方肌、菱形肌、肱二头肌、肱三头肌、前锯肌、核心、腹斜肌、股四头肌、腘绳肌、臀大肌、小腿、胫骨前肌、颈深屈肌、胸椎伸展肌群。
- 未知/自定义 key：显式「尚无映射」，coverage 以「已映射 x/y」呈现；不得按名称相似猜测映射或素材。
- H4.6 计数口径：只计 completed 组；容量先统一单位再汇总；同一动作关联多肌群时重复归属，肌群容量不可相加当全身总容量；重量缺失的自重/计时动作仍计训练事实、容量记未知不当 0。
- H4.6 修复进度：与 readiness 分开，标「参考间隔计时」= clamp(距末次已完成训练小时 / T, 0, 1)；T 的规则来源须在实现时写明版本，未定前不显示百分比，只显示末次训练时间与「规则未定，无法判断」。

## 映射表（覆盖全部 31 个现有稳定 key）

| exercise_key | 名称 | 主要 | 次要 | media |
| --- | --- | --- | --- | --- |
| barbell-bench | 杠铃卧推 | 胸 | 肱三头肌、肩前束 | none |
| overhead-press | 站姿推举 | 肩前束、肩中束 | 肱三头肌、核心 | none |
| incline-dumbbell-press | 上斜哑铃卧推 | 胸 | 肩前束、肱三头肌 | none |
| dips | 双杠臂屈伸 | 胸、肱三头肌 | 肩前束 | none |
| lateral-raise | 哑铃侧平举 | 肩中束 | 斜方肌 | none |
| push-up-plus | 前锯肌 Push-up Plus | 前锯肌 | 胸、核心 | none |
| wide-lat-pulldown | 高位下拉 · 宽握 | 背阔肌 | 肱二头肌、肩后束 | none |
| close-lat-pulldown | 高位下拉 · 窄握/反握 | 背阔肌 | 肱二头肌 | none |
| close-seated-row | 坐姿划船 · 窄距 | 背阔肌、菱形肌 | 肱二头肌、斜方肌 | none |
| wide-seated-row | 坐姿划船 · 宽距 | 菱形肌、肩后束 | 背阔肌、斜方肌 | none |
| face-pull | 面拉 | 肩后束 | 斜方肌、菱形肌 | none |
| reverse-pec-deck | 反向蝴蝶机 · 后三角 | 肩后束 | 斜方肌 | none |
| rope-curl | 绳索弯举 | 肱二头肌 | — | none |
| back-squat | 深蹲 | 股四头肌、臀大肌 | 核心、腘绳肌 | none |
| romanian-deadlift | 罗马尼亚硬拉 | 腘绳肌、臀大肌 | 斜方肌、核心 | none |
| bulgarian-split-squat | 保加利亚分腿蹲 · 负重 | 股四头肌、臀大肌 | 小腿、核心 | none |
| lying-leg-curl | 俯卧腿弯举 | 腘绳肌 | 小腿 | none |
| calf-raise | 提踵 | 小腿 | — | none |
| tibialis-raise | 靠墙胫骨前肌抬脚尖 | 胫骨前肌 | — | none |
| supine-chin-tuck | 仰卧收下巴 | 颈深屈肌 | — | none |
| prone-ytw | 俯趴 Bench Y-T-W | 斜方肌、肩后束 | 菱形肌、胸椎伸展肌群 | none |
| side-external-rotation | 侧卧外旋 · 小片 | 肩后束 | — | none |
| thoracic-extension | 胸椎伸展 · Bench 边缘 | 胸椎伸展肌群 | — | none |
| single-leg-balance | 单腿平衡触点 | 小腿、臀大肌 | 核心 | none |
| home-bulgarian-split-squat | 保加利亚分腿蹲 · Bench 抱片 | 股四头肌、臀大肌 | 小腿、核心 | none |
| bench-step-up | Bench 登阶 | 股四头肌、臀大肌 | 小腿 | none |
| home-calf-raise | 提踵 · 抱片 | 小腿 | — | none |
| wall-sit | 靠墙静蹲 | 股四头肌 | 臀大肌 | none |
| dead-bug | 死虫 | 核心 | — | none |
| side-plank | 侧平板 | 腹斜肌、核心 | 臀大肌 | none |

注：`tibialis-raise` 同时出现在 legs 与 home_snowboard 模板，是同一 key、同一映射，不重复计数条目。素材（media）本稿全部为 none：合规图源逐项核实后另行补入，缺图不阻塞动作帮助文字版上线。
