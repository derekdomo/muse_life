# Plans

本仓的目标不是继续堆四个互不相干的页面，而是把它们做成一组可信、可持续刷新的个人生活工具：用户打开后能在一分钟内知道发生了什么、数据是否新鲜、下一步该做什么；任何健康、训练和财务结论都必须能追溯到真实数据，不能用漂亮界面掩盖缺失、过期或推断。

本文同时是 PM 需求文档、设计约束和 Muse 交付验收基线。Muse 实现任何需求前先引用需求编号；实现后在根目录 `changes.md` 写明编号、改动文件和验证证据。没有进入 `changes.md` 的实现一律视为尚未交付。

## PM / Tech Lead 责任（用户 2026-10-15 明确）

PM/TL 对产品结果负责，Muse 按 junior engineer 分工实现业务代码。PM/TL 负责从用户角度决定价值与优先级，设计功能/交互/视觉，审架构和真实源码，组织独立验证，决定验收与发布并跟进返工。交付顺序为：需求/页面设计 → Muse 实现与自评 → TL 阅读改动及调用链 → 独立反例验证 → 最终整合与实际 artifact/UI 验收。不得只运行实现方测试或根据 changes 描述宣布通过。

审查必须记录“输入 → 身份/校验 → 状态/并发 → 持久化 → 返回 → 页面”的链路、问题影响及取舍。源码已确认、mock 复现、类型检查、浏览器通过和已发布各自记录，不相互替代。平台能力限制单列，不反复要求不存在的 API；旧用户决定与权限例外按现有记录保留，不据此自动关闭风险，也不让待外部证据的项目冻结不相关的功能/设计。PM 每次收尾明确下一项实际交付，不再只堆待办。

### 2026-10-15 TL 源码审查（基于 `8f9f242`，未修改业务代码）

- [ ] `L1-RACE-001`（P1，health与strength双路径快照并发/幂等）比较来源版本与写入必须为一个原子操作，覆盖首次创建竞争、固定较旧版本拒绝、相同版本幂等、null更新时间不能覆盖有效新快照；使用可执行的来源版本/读取开始时刻契约，禁止把较早读取的完成时刻当新版本。callback返回区分applied/ignored，saved只记录真正的逻辑保存，保持旧快照与响应兼容。交付真实handler可复跑反例及修复断言，再给artifact保存回读/页面证据，不引入不存在的平台身份API。历史缺陷与独立mock见2026-10-15记录。**PM复核至 `e3c6848`：局部修复通过，继续返工/运行待验，不勾选。** 固定版本的双路原子比较、首次竞争、力量null拒旧与outcome已修；剩余HealthKit按完成时刻定版本、同版本重试重复saved/冲突内容覆盖，见本轮精确位置和复现。下一实现仍只收尾本项，条件SQL/构建pass不代表artifact运行验收。（实现方 2026-10-15 收尾交付，待 PM 复核、不自行勾选：HealthKit prompt 已改 readStartedAt 读取开始时刻契约；双路守卫改为严格 >，同版本同 payload = duplicate、同版本不同 payload = conflict（先到者胜出），均不写 saved/不 invalidate，outcome 枚举扩展 duplicate|conflict；validate-persist-race.mjs 重写为真实 persist 函数 + 真实 save handler 抽取运行（42/42，含变异敏感性）；构建方在沙箱 DB 以 2099 版本探针实测双路 applied→duplicate→conflict→ignored、null 被拒，生产库未写入。）
- [ ] `H-UNITS-001`（P1，源码与实际函数 synthetic 调用已确认）`health-dashboard/server/src/actions.ts:814-818` 累加 workout.totalVolume 时忽略 workout.unit；client/src/App.tsx:371,484 统一标 displayUnit。实际 buildUnifiedTimeline 输入同日100 lb和100 kg、displayUnit=kg，返回200，正确按本仓换算与一位小数应为145.4 kg。请求 Muse 在服务端按目标单位换算后汇总，并审计 readiness.currentVolume 等其他跨训练聚合，保留单次历史的原始单位。验收：同日/跨日混单位、全lb、全kg、零/缺失工作组、目标单位切换；不把未知重量当0生成比较结论。相同输入在今日与历史页数值/单位一致，切换展示单位不制造进步或PR。
- [ ] `H-SOURCE-001`（P1，源码路径确认，artifact待验）`health-dashboard/server/src/actions.ts:830-834,980-987`：health快照不存在/不合法时，getDashboard提前返回，getSyncDiagnostics也不读取独立strength快照；buildDataStatus(null)把两个来源一起判为缺失。合法力量快照存在但HealthKit首次未同步时，用户看不到已有训练且被提示两边都没数据；自动力量同步同样被health早退挡住。请求 Muse 独立读取与表示两来源，不用伪造健康快照承载训练，按来源显示partial和各自可用操作。验收：仅health、仅strength、两者都有、两者都无、一个payload损坏五种矩阵；损坏/缺失来源不得吞掉另一个可用来源。需说明response兼容、诊断与空态UI，验证已有训练可见。
- 已重新阅读 `workout-log/server/src/actions.ts:175-344` 与 `client/src/App.tsx:500-573,642-715`。`W0.1/W0.2`（仅完成按钮提交、无保存错误与dirty提醒）、`W0.3`（updateSet无active归属过滤）、`W1.1`（预填/周评两套规则）仍存在；作为旧问题确认，不重复新建。另把startWorkout的先建主行、后取历史/建组且无事务纳入W0.4验收：历史查询/组插入失败后不能遗留空active workout，两个并发start不能生成半成品/重复进行中。

### 用户可见交付批次（TL设计，未实现/未发布）

这批用于纠正“功能/UI长期只停在计划”的问题。安全和数据发布门槛仍保留；等待平台证据时，Muse可选择一个不依赖该能力的原子项继续，不能用“所有P0都未完全验收”无限阻挡独立页面改进。一个仓库仍只同时实现一项。

- [ ] `W-UI-001`（第一项可见训练体验，承接W0.1/W0.2/W2.2）训练页以“当前动作 → 上次可比表现 → 本组重量/次数 → 保存结果”为主层级；手机顶部保留训练日、进度与时长，当前动作卡展开，其余动作可收起，底部保留结束入口。输入blur/Enter或短debounce即保存，完成勾选只表达完成；每组明确显示未保存/保存中/已保存/失败重试，失败保留输入。结束前等待进行中保存，dirty/error或未完成组需明确确认；不能靠取消勾选再勾选保存。沿用现有真实数据/API，若需要接口改动必须附兼容说明；不在本项改渐进负荷算法。验收：已完成组改数字后直接结束/切页、慢响应倒序返回、保存失败重试、键盘遮挡、390×844/430×932/桌面；所有控件最小44px、状态不只靠颜色。须给匹配视口/合成数据的前后截图和可打开artifact/version。
- [ ] `W-TIMER-001`（下一项新功能，承接W2.1）完成组后启动可选休息计时器，默认90秒，可在本次训练设60/90/120秒，支持跳过、+30秒、静音；用截止时间计算剩余而非递减setInterval，切后台回来正确，不妨碍录入、不更改训练完成状态；刷新后恢复策略须明确。状态区放当前动作卡下，不用全屏遮罩。验收：切后台、快速连续完成组、暂停/恢复（若提供）、关闭计时及手机单手操作；无权限不得触发写训练数据。
- [ ] `H-UI-001`（健康首屏重排，承接H2/L2，避开未验收分析）首屏顺序固定为“数据日期/来源状态 → 恢复参考与置信度/缺失原因 → 一个可行动入口 → 关键指标 → 7天解释趋势”。同步台账和诊断移到可展开详情，避免技术信息占据主内容；今日/上一完整日清楚分区。恢复算法未通过H1时，不包装成确定训练等级，显示依据不足与缺项；不在视觉改版里暗改公式。入口优先打开训练记录或重试缺失来源，用户能一步找到。验收：正常/partial/仅训练/旧数据/失败五种状态的三视口前后截图；值、日期、单位与来源准确，真实发布版本可复核。每周健康复盘H3依照可信数据与算法的依赖推进，不能仅加标题空卡称已实现。

## 仓库边界

- 本仓保存四个 Interactive App 的源代码、迁移和产品文档；运行数据仍只存在 Muse artifact 的 `app.db` 或已授权的数据源中。
- 不把真实健康记录、训练记录、财务余额、账户尾号、设备 ID、内部任务 ID或其他可识别个人数据写进 Git。开发演示只能使用明确标为 synthetic 的假数据。
- `health-dashboard/` 与 `workout-log/` 保持两个独立产品；健康看板只读取训练摘要，不复制训练录入能力。
- 数据一体原则（用户 2026-10-15 定）：四个 app 对用户是一个整体，界面分开不等于数据分家；同一份数据只设一个事实源，跨 app 使用走可靠的内部通道，不依赖易碎的定时批量拷贝。当前平台下每个 artifact 只有独立 `app.db`，做不到物理共享时，同步链路的触发、失败与权限例外必须显式设计并记录，不得静默失败（呼应 2026-10-14 力量同步冻住事件）。
- 本地仓不能替代 Muse artifact 运行时。代码静态审查可在本仓完成；涉及 action、数据库、定时任务和真实数据的结论，必须在 artifact 中复验。

## 产品组合与成功标准

- `health-dashboard/`：每天回答“我今天恢复得怎样，数据是否可信，应该正常训练还是保守一点”。
- `workout-log/`：训练中快速、可靠地记完每一组，并用历史表现给出保守的渐进负荷建议。
- `weekly-finance/`：每周回答“净资产发生了什么变化、现金与负债是否健康、长期目标是否在正轨”。
- `house-hunting/`：每周把大量房源压缩成少量值得看、原因清楚、总成本透明的候选。

组合级成功标准：

- 私密数据对未登录用户和非 owner 均不可读、不可写、不可触发刷新。
- 所有页面明确展示数据日期、最后成功同步时间、数据来源和同步状态。
- 失败刷新保留上次成功数据，并明确标为旧数据；不得把失败、缺失或部分同步伪装成 0 或“正常”。
- 核心动作在 390×844 手机视口单手可完成；桌面视口不出现过宽行长或稀疏大空白。
- 每个业务公式至少有一个正常、边界和缺失数据测试；核心 action 至少覆盖成功、失败、重复提交和无权限四条路径。

## 发布门槛（所有 app）

### L0 — 隐私与权限（P0）

- [ ] `L0.1` 健康、训练、财务的所有读 action、写 action、初始化 action 和 agent callback 均在服务端校验 `ctx.viewer?.isOwner === true`；`viewer === null` 必须按无权限处理，而不是按 owner 处理。（2026-10-15 PM 复核至 `04bd2a2`：**P0 权限回归，返工**。`79dbd07` 将 health 刷新/两个保存 callback、workout getDashboard 改为放行 null/undefined viewer；缺少可验证服务身份、任务归属及匿名不可达证据，不满足本项。撤回 AUDIT-02 静态修复结论；下一项只关闭该边界，详见本轮记录。原三身份/后台运行矩阵仍待验，不能以恢复同步替代权限验收。）（需用户确认：2026-10-15 同步 job 标注——该收紧与用户 2026-10-14/15 已拍板接受的「owner 或无身份内部同步通道」设计及残余风险保留直接冲突；平台无可验证服务凭据，执行收紧将冻结健康/力量同步与每 2 小时看门狗刷新，安全与同步可用性二选一须用户拍板，拍板前不执行。）（实现方平台限制登记 2026-10-15，用户指示：当前 Muse artifact 运行时不存在可验证服务身份机制——action ctx 只暴露浏览器 viewer 或无 viewer，后台 schedule、agent 回调与跨 app 已发布 action 调用均不携带任何可验证的调用方身份，作者无 API 可签发/校验凭据；故本项对受信后台的验收条件在当前平台不可实现，详见 changes.md 同日《致 PM：平台服务身份限制登记》。请 PM 就后台通道部分给出可执行验收口径，或明确接受其为平台限制。）
- [ ] `L0.2` 看房报告允许公开读取时，刷新、初始化和 ingest 仍只允许 owner/受信 callback；如果 artifact 被定义为私密，则读写统一 owner-only。
- [ ] `L0.3` 无权限响应使用稳定的 typed state，不依赖前端隐藏；直接调用 action 也不能读取 payload 或修改数据。
- [ ] `L0.4` 删除仓库中的真实 HealthKit 明细、真实 workout UUID、设备 ID 和可识别的个人健康样例；首次启动显示诚实空态并引导同步。需要 fixture 时使用独立、明确标为 synthetic 的数据，且生产初始化不会写入 fixture。（2026-10-14 PM 复核至 `205f544`：DATA-PLAN 回灌隐私恢复与步数展示脚本修复局部通过，11:19 两处返工关闭；文档除保留一行同步机制说明外与此前脱敏 `8b87c09` 逐字一致，展示脚本 8/8 通过。无业务/schema/UI 改动。完整契约、受信 owner null/零/旧数字快照保存回读、三视口及原运行要求继续待验，整项不勾选。）
- [ ] `L0.5` 日志和错误文案不得包含账户余额、健康数值、训练明细、完整本地路径或上游原始 JSON。

**验收**：分别以 owner、已登录非 owner、未登录三种身份直接调用每个 action；后二者全部无法读取或写入私密数据。对仓库执行个人数据扫描，不再命中真实健康时序、真实 workout UUID 或固定设备 ID。

### L1 — 统一刷新状态（P0）

- [ ] `L1.1` 每个外部数据源独立保存 `idle | running | success | error`、`taskId`、`lastAttemptAt`、`lastSuccessAt`、简洁结果和错误信息。
- [ ] `L1.2` 客户端以持久状态判断是否完成，不使用固定时长假装同步完成；任务超时后可安全重试。
- [ ] `L1.3` 同一来源重复点击只能复用正在运行的任务；callback 必须幂等，晚到的旧任务不能覆盖更新的数据。
- [ ] `L1.4` 部分成功按来源显示，例如 HealthKit 成功、训练同步失败；保留每一来源最后一次成功值。
- [ ] `L1.5` 页面始终区分“数据日期”“最后成功同步”“本次尝试时间”，并在数据超过预期刷新周期时显示 stale 提示。

**验收**：人工覆盖成功、一个来源失败、全部失败、任务未 callback、旧 callback 晚到和连续双击六种情形；状态、按钮和缓存数据均符合上述语义。

### L2 — 数据可信度与可访问性（P1）

- [ ] `L2.1` 结论旁能查看来源、公式/假设和缺失项；推断值与原始值使用不同标签。
- [ ] `L2.2` 重要状态不只靠颜色表达；键盘焦点可见，dialog 打开后聚焦并限制在 dialog 内，关闭后回到触发按钮。
- [ ] `L2.3` 所有 mutation 都展示 `saving / saved / error`，失败后保留用户输入并可重试。
- [ ] `L2.4` 空态、加载、无权限、部分数据、错误和 stale 都有独立设计，不复用模糊的通用提示。

---

## 健康看板（`health-dashboard/`）

### 产品定位与主流程

首页优先级固定为：数据是否可信 → 今日 readiness 与行动建议 → 昨日关键指标 → 睡眠和训练摘要。趋势和历史用于解释变化，不与首页争夺注意力。Readiness 是个人趋势参考，不是医疗判断。

### H0 — 数据正确性与同步（P0）

- [ ] `H0.1` 用来源级 coverage 取代单一 `coverageIncomplete`。步数、静息心率、HRV、睡眠、呼吸频率、workout 各自记录 `complete | partial | missing | unavailable` 及原因。
- [ ] `H0.2` “还没同步完”只用于对应来源/日期确实 partial 的字段；完整日中缺失才显示“当天没戴表/无记录”。其他 query 的 incomplete 不能污染当前字段判断。
- [ ] `H0.3` 当天晨间数据与上一完整日严格分栏，任何当天 partial 值都不进入完整日趋势或异常判断。
- [ ] `H0.4` HealthKit 与训练记录使用 `L1` 的两个独立刷新状态；同步完成后立即停止轮询，超过合理时限显示可重试错误。
- [ ] `H0.5` 睡眠实际时长只等于 core + deep + REM；效率分母为卧床起止时间。主睡眠必须优先匹配 readiness 当天早晨结束的 session。
- [ ] `H0.6` 所有历史序列按日期升序、同日去重、上限明确；较旧 callback 不得覆盖较新的 `sourceUpdatedAt`。

### H1 — Readiness 可信度（P0）

- [ ] `H1.1` 计算基线时排除正在被评分的当天/当晚数据，避免当前值同时进入基线和评分。
- [ ] `H1.2` 除“至少两项信号”外增加覆盖门槛：显示可用权重；初版只有在可用权重至少 60%，且 HRV / 静息心率至少一项有效时才能给确定等级。睡眠缺失时置信度不得为高，也不能给“全力以赴”；低于门槛只显示“数据不足”和缺什么。当前 `calculateReadiness()` 只检查两项，可能由低权重信号给出过度确定的结论。
- [ ] `H1.3` 睡眠 session 缺失时，睡眠组件必须缺失，不能静默沿用更早一晚却仍称“昨晚”。若回退，明确展示实际日期。
- [ ] `H1.4` 主观晨检只能保守下调，并保存到 readiness 对应日期；重复保存幂等。
- [ ] `H1.5` 评分详情保留公式、滚动窗口、实际可用信号、修正规则和置信度；文案避免“最准”等无来源绝对判断。删除当前“静息心率是跨设备最准的指标”一类无来源绝对表述。
- [ ] `H1.6` 对齐每个信号的时间与指标定义：组件必须展示测量日期/窗口；上一完整日的 HRV / 静息心率不能不加说明地包装成“今日”信号，`morningReference.avgHrBpm` 也不能冒充静息心率。只有同一晨间定义的数据才能进入今日 readiness；否则明确称为“基于上一完整日的恢复参考”。
- [ ] `H1.7` 基线排除正在评分的记录，包括当晚睡眠；当前睡眠不能同时进入 `sleepStats`、`sleepNeed` 再与自己比较。基线改为最多 28 天、至少 14 个有效日的稳健统计（中位数/MAD 或经说明的 winsorized 方法），极端值不能把标准差放大到掩盖异常。
- [ ] `H1.8` 缺失维度不得在雷达图中默认显示为中性 5 分；改为缺口/不可用状态。置信度同时依据可用权重、核心信号、来源 coverage 和数据新鲜度，而不是只数信号个数。

**验收样例**：至少覆盖正常数据、仅两项低权重信号、HRV/RHR 同时异常、睡眠债超过 3 小时、睡眠缺失、晨检下调和跨周一七种 fixture，并逐项核对输出。

### H2 — 今日行动卡（P1）

- [ ] `H2.1` readiness 下给一个非医疗、可执行的训练建议：正常计划、降强度、恢复日或数据不足；必须列出触发依据。
- [ ] `H2.2` 训练建议不自动修改 `workout-log`，只提供“打开训练记录”的入口；两个 app 继续独立。
- [ ] `H2.3` 趋势页支持 7/30 天切换，并在图上标记缺失段、训练日和明显偏离个人基线的日期。

### H3 — 每周健康复盘（P1，新功能）

- [ ] `H3.1` 生成“上一个完整 7 天”复盘，并同时比较前一完整 7 天与 28 天个人基线；睡眠、HRV、静息心率、呼吸频率、步数、运动分钟和训练次数分别显示有效天数与 coverage，不能把缺失当作 0。
- [ ] `H3.2` 首页最多给三条真正可行动的洞察，每条拆成“观察 / 可能解释 / 下周动作”，附数据窗口和置信度；没有足够证据时明确写“无法判断”，不补故事。
- [ ] `H3.3` 单日噪声不触发趋势结论。至少 5 个有效日并出现连续变化或达到预先定义的实用差异，才提示“持续偏离”；阈值、方向和降级规则需要 fixture 测试。
- [ ] `H3.4` 在至少 6 次有配对数据的训练后，才允许探索“睡眠/恢复与训练表现”的关联；只说相关，不说因果，不产生医疗结论，也不自动改训练计划。
- [ ] `H3.5` 周复盘结尾只输出一个下周重点，例如固定睡眠窗口、正常训练、减少一组或安排恢复日；必须能回溯到本周证据，用户可标记“有帮助 / 不适用”供后续调整。

**验收样例**：完整周、仅 3 天数据、单日异常、连续三日偏离、跨时区睡眠、训练数据缺失、恢复与表现样本不足七种 fixture；同一输入重复计算结果一致，所有洞察都能追溯到原始窗口。

### H4 — 同类产品调研新增（P2，新功能）

以下 5 项来自 2026-10-13 同类产品调研（Whoop、Oura、Garmin、Bevel 等），用户已批准启动，排在 `H3` 之后推进；括号内为调研原文候选编号。

- [ ] `H4.1` 行为—恢复影响分析（调研 H1，借鉴 Whoop / Bevel Journal）：晨检增加可选行为标签（饮酒、咖啡因、晚睡、晚进食、出差等）；每种行为累计至少 5 个"有标签日"后，展示该行为与次日 HRV、readiness 的平均差及样本数。只呈现相关性和样本量，样本不足不下结论，不输出医疗判断。
- [ ] `H4.2` 训练负荷平衡（调研 H2，借鉴 Garmin Training Load）：以训练记录的时长与训练量计算 7 天急性负荷与 28 天慢性负荷之比（ACWR），显示负荷状态词（不足 / 适宜 / 偏高 / 过高）并公开计算口径；历史不足 28 天时只展示已有窗口并标注，不以 0 充数。
- [ ] `H4.3` 睡眠债与今晚睡眠需求（调研 H3，借鉴 Whoop Sleep Need）：基于近 14 天实际睡眠与个人睡眠基线计算累计睡眠债，给出今晚建议睡眠时长与建议就寝时间；文案标注为作息参考而非医疗建议，睡眠 session 缺失时不得回退旧日期冒充。
- [ ] `H4.4` 状态模式（调研 H4，借鉴 Oura Rest Mode / Gentler Streak Set Status）：owner 可设置生病 / 受伤 / 旅行状态与起止日期；状态期内 readiness 只显示状态说明、不给训练等级，状态日期不进入基线、异常判断与趋势结论，趋势图标记状态区间。
- [ ] `H4.5` 月度回顾与长期基线漂移（调研 H5，借鉴 Bevel / Oura 月报）：每月生成上一个完整自然月回顾，展示 HRV、静息心率、睡眠、步数月均值相对长期基线的偏移量与方向；与 `H3` 周复盘共用洞察口径，单月噪声不下趋势结论。

---

## 训练记录（`workout-log/`）

### 产品定位与主流程

核心路径是“选训练日 → 自动预填 → 快速修正重量/次数 → 完成每组 → 安全结束 → 下次得到一致建议”。训练中页面要优先速度和防丢数据，复盘信息放在训练前后。

### W0 — 记录不丢失（P0）

- [ ] `W0.1` 修改重量或次数后在 blur/Enter 或短 debounce 后保存，不要求通过取消/重新勾选完成状态才能保存。
- [ ] `W0.2` 每组显示 dirty、saving、saved、error；保存失败保留本地输入并提供重试。切页或结束训练前若仍有 dirty/error 项要明确提醒。
- [ ] `W0.3` `updateSet`、`addSet`、`completeWorkout`、`discardWorkout` 必须校验目标属于当前 active workout；不存在或已完成目标不能仍返回 `ok: true`。
- [ ] `W0.4` 数据库或事务保证同一用户最多一个 active workout；并发 start 不得生成两条进行中训练。
- [ ] `W0.5` 结束训练时：全部完成可直接结束；存在未完成组时显示完成数并二次确认，未填项目保留为未完成，不能伪造为 0。

### W1 — 渐进负荷规则统一（P0）

- [ ] `W1.1` 自动预填与周复盘共用同一套规则和服务端实现，不能一个按最近一次、一个按连续两周却同时声称是“下次建议”。
- [ ] `W1.2` 默认保守规则：目标组全部完成且达到次数上限才建议加重；未完成、低于下限或数据不足时分别给保持、减重/恢复、无建议。
- [ ] `W1.3` 切换 lb/kg 时可换算最近可比记录并标明“已换算”，不能简单表现为没有历史。
- [ ] `W1.4` 训练量只计算 completed 且重量、次数都有值的组；自重动作不以 0 训练量冒充可比较负荷。

### W2 — 训练中体验（P1）

- [ ] `W2.1` 增加可选休息计时器：完成组后自动开始，默认值按动作可配置，可静音且不阻塞录入。
- [ ] `W2.2` 训练页保持一只手可操作：数字键盘、下一输入跳转、44px 最小触控区、页面返回后恢复滚动位置。
- [ ] `W2.3` 周复盘明确是“上个完整周”，同时提供本周进行中摘要，避免用户把旧周建议误认为今日实时状态。

### W3 — 渐进负荷与训练分析（P1，新功能）

- [ ] `W3.1` 每组可选记录 RIR（0–5），每次训练结束可选记录 session RPE、疼痛/动作异常和备注；这些输入必须快速可跳过，不能拖慢打卡。疼痛标记只触发保守提醒，不做诊断。
- [ ] `W3.2` 建立唯一的服务端渐进负荷引擎，供自动预填、训练结束总结和周复盘共同调用。每个动作只输出 `加重 / 保持 / 降重或减组 / 数据不足`、建议值、理由和置信度；输入至少包含最近两次同动作同单位表现、完成率、目标区间、RIR/疼痛与当前建议版本。
- [ ] `W3.3` 增加动作级趋势，而不是只看全局吨位：工作组完成率、总次数、训练量、最佳工作组，以及 1–12 次有效组的估算 1RM。估算公式必须公开，只在同一动作内比较；自重、不同单位和缺失重量不得生成假 PR。
- [ ] `W3.4` 增加最近 4 个完整周的动作/动作模式训练组数与频率，区分“没练”“没记录”“主动减量”；全局重量×次数只能作为工作量参考，不能单独判断训练是否进步。
- [ ] `W3.5` 只有连续两次表现下降并同时出现高 RPE、低 RIR、疼痛标记或低 readiness 之一时，才建议保守调整/恢复；单次状态差不触发自动 deload，任何建议都由用户确认。

### W4 — 计划可配置与健康联动（P2，新功能）

- [ ] `W4.1` 支持 owner 编辑训练日、动作、组数、次数范围、单位与默认休息时间；模板必须版本化，历史记录继续显示当时的名称和目标，不能被新模板回写。
- [ ] `W4.2` 健康看板只能把 readiness 建议作为只读提示带入训练开始页，例如“正常 / 保守 / 恢复 / 数据不足”；不得静默改变重量、组数或完成状态。
- [ ] `W4.3` 训练结束显示本次相对上次的完成率、动作级变化、建议依据和下一次最小调整；避免用一个总训练量数字概括整次训练。

### W5 — 同类产品调研新增（P2，新功能）

以下 3 项来自 2026-10-13 同类产品调研（Fitbod、Boostcamp、Hevy 等），用户已批准启动；括号内为调研原文候选编号。调研候选 T2（RPE/RIR 与 e1RM/PR）已被 `W3.1`、`W3.3` 覆盖，T3（停滞检测与 deload 提示）已被 `W3.5` 覆盖，均不重复纳入。

- [ ] `W5.1` 肌群周组数与恢复热力图（调研 T1，借鉴 Fitbod / Boostcamp）：建立静态"动作 → 主肌群 / 协同肌群"映射，按最近 7 天各肌群完成组数与距上次训练天数展示恢复热力图；映射表对 owner 可见、可修正，不使用不可解释的恢复百分比。
- [ ] `W5.2` 配重计算器与热身组生成（调研 T4，借鉴 Boostcamp）：输入目标重量后按常见杠铃片规格给出每侧配重组合；按可配置比例自动生成热身组（重量与次数），可一键写入本次训练。
- [ ] `W5.3` 围度与体重趋势（调研 T5，借鉴 Hevy / Strong）：owner 手动记录体重与主要围度（至少腰围），与训练量、最佳工作组同图对照展示；只做记录与趋势展示，不给减重或健康结论。

---

## 每周财务总览（`weekly-finance/`）

### 产品定位与主流程

首页优先级固定为：权限与数据新鲜度 → 实时净资产与周变化 → 现金/负债/支出健康度 → 长期 FIRE 方向 → 账户与持仓明细。所有预测必须把假设写在结果旁，不能把线性外推包装成承诺。

### F0 — 权限与数据完整性（P0）

- [ ] `F0.1` 修正 owner 判定：只有 `ctx.viewer?.isOwner === true` 才能读取、刷新或 ingest；匿名 `viewer === null` 必须拒绝。（2026-10-13 PM 复核至 `d439ac6`：静态 guard 通过，非 owner 汇总证据不能替代三种身份逐 action 和受信后台 callback 验证；撤回原实现方勾选，与 `L0.1` 一致保持“运行待验”。）
- [ ] `F0.2` payload JSON 损坏时返回 typed error 并保留可恢复路径，不能让 `JSON.parse` 直接使整个 action 崩溃。
- [ ] `F0.3` 月度文件先按合法真实日期校验、再排序；同一个自然月有多个快照时明确选择月末/最新快照，不能当作多个“月份”画图。
- [ ] `F0.4` 标记当月快照为 partial 或 complete。“本月收入/支出/储蓄率”必须显示截至日期；FIRE 年支出只使用完整且非异常月份。
- [ ] `F0.5` Firance、Plaid account、holdings、transactions 分别记录 coverage 和最后成功时间；交易失败不阻断余额刷新，但支出推断必须明确降级。

### F1 — 指标语义（P0）

- [ ] `F1.1` 应急金覆盖使用可配置的“可动用存款 ÷ 近 3 个有效完整月平均支出”，不使用可能 partial/异常的单月支出。
- [ ] `F1.2` 周变化拆成“本次余额差”，不要暗示已能准确归因为市场、投入或消费；只有来源足够时才增加归因。
- [ ] `F1.3` FIRE 达标年限明确标为“不含投资回报的线性估算”；P1 可提供保守/中性两种可编辑假设，但默认不承诺收益率。
- [ ] `F1.4` 贷款以正数未偿余额展示，但净资产计算仍按负债扣减；所有卡片和账户行保持同一符号语义。
- [ ] `F1.5` 数据异常月说明触发原因（交易未覆盖、推断为负、来源缺失等），用户能判断是数据问题还是实际异常。

### F2 — 每周决策摘要（P1）

- [ ] `F2.1` 顶部增加最多三条摘要：净资产变化、现金覆盖变化、当月支出进度；每条都带比较区间和来源完整度。
- [ ] `F2.2` 只做事实型提醒（数据过期、集中度、现金覆盖、负债变化），不生成买卖建议。
- [ ] `F2.3` 持仓集中度分母、现金头寸是否计入、Top 10 截断方式在详情中可见。

### F3 — 同类产品调研新增（P2，新功能）

以下 5 项来自 2026-10-13 同类产品调研（Monarch、Copilot、Rocket Money、YNAB 等），用户已批准启动；括号内为调研原文候选编号。全部只做事实呈现与试算，不生成买卖建议。

- [ ] `F3.1` 净资产周变化归因拆解（调研 F1，借鉴 Monarch / Copilot）：在 `F0.5` coverage 与上周持仓快照齐备后，把周变化拆成收入、支出、持仓市值变化、负债变化四项，逐项显示金额与数据完整度；任一来源缺失时回退为 `F1.2` 的"本次余额差"，不硬凑归因。
- [ ] `F3.2` 订阅与周期支出体检（调研 F2，借鉴 Rocket Money）：从 Plaid 交易识别周期性扣费，列出每项的年化成本、最近一次涨价幅度与下次预计扣费日；只做事实展示与提醒，不提供代取消、代谈判或自动操作。
- [ ] `F3.3` 未来现金流日历预测（调研 F3，借鉴 Monarch）：基于已识别的周期收支与当前存款余额，生成未来 30–90 天逐日预计余额曲线，标注预计低点与每条假设的来源；必须标注"基于历史周期推断"，不包装成承诺。
- [ ] `F3.4` 目标情景试算 What-if（调研 F4，借鉴 YNAB / Empower）：owner 手动调整月支出、月投入与目标金额，试算应急金达标、FIRE 达标与购房首付三个目标的预计日期变化；与 `F1.3` 线性估算口径一致，假设写在结果旁，不输出建议。
- [ ] `F3.5` 交易待复核队列（调研 F5，借鉴 Copilot）：把分类不确定或金额异常的交易集中为待复核列表；owner 确认或改分类后，同类交易按规则自动归类。分类结果只用于本看板展示，与 Firance 月度口径冲突时以 Firance 为准并标注。

---

## 南湾看房周报（`house-hunting/`）

### 产品定位与主流程

核心流程是“先看本周 3 个最值得行动的候选 → 调整硬筛选和成本假设 → 比较原因与风险 → 保存看房决定”。硬条件先过滤，综合分只在合格房源之间排序。

### HH0 — 列表与刷新正确性（P0）

- [ ] `HH0.1` 筛选结果为空时不回退显示全局第一名；hero 同步进入空态，避免把不满足筛选条件的房源称为“当前筛选首选”。
- [ ] `HH0.2` 刷新状态实现 stale recovery 和幂等 callback；任务失联后不能永久卡在 running。
- [ ] `HH0.3` 新报告在 report + listings 同一事务中原子保存；不足最低数量、重复 URL/地址或字段不完整时保留上一期。
- [ ] `HH0.4` 当前挂牌状态必须有核验时间；sold/off-market 从推荐列表移除，pending/contingent 降级展示，不与 active 混为可直接行动。
- [ ] `HH0.5` 排名必须由明确 rubric 产生并保存分项分：硬条件、环境、学校/私校、房龄/状态、空间、价格/可比成交。agent 不得只返回无法解释的总分。

### HH1 — 决策能力（P1）

- [ ] `HH1.1` 月成本从单一 P&I 升级为透明估算：本金利息、地税、房屋保险、HOA 分项展示；默认假设可编辑并保留“不含维修/装修”的提示。
- [ ] `HH1.2` 增加 2–4 套对比模式，固定比较价格、面积、地块、房龄、学校、道路/噪音、状态、风险和月成本。
- [ ] `HH1.3` 增加 owner-only 的“收藏 / 排除 / 已看房”状态；周更时沿用用户决策并标记价格或状态变化。
- [ ] `HH1.4` 每套提供看房核对清单，重点围绕噪音、道路、采光、装修质量、屋顶/HVAC/电气、地块与 HOA；不把未核实信息写成事实。
- [ ] `HH1.5` 学校评分和按揭利率都显示来源与日期；超过七天明确标 stale，不以旧值继续称“本周”。

---

## 当前代码审计基线（2026-10-13）

本轮只完成仓库静态审查；因 README/各 app `AGENTS.md` 明确要求只能通过 Muse web-artifact builder 运行和审计，且本会话没有已连接的 builder/artifact 实例，所以以下“风险确认”指代码路径已确认，“运行待验”指仍需在 artifact 实机复现。

### 已确认风险

- [x] `AUDIT-01 / P0` 财务 owner 判断为 `ctx.viewer != null && !ctx.viewer.isOwner`；当 `viewer === null` 时会走 owner 数据路径。见 `weekly-finance/server/src/actions.ts` 的 `isSignedInGuest`。（2026-10-13 已修复：`isSignedInGuest` 改为严格 `isOwner` 校验，见 changes.md）
- [ ] `AUDIT-02 / P0` 健康和训练 action 必须有显式服务端权限校验。（2026-10-15 PM 撤回此前静态修复勾选：`79dbd07` 在 health 三个入口和 workout getDashboard 新增无 viewer 放行；当前 guard 无法区分未登录与受信后台。不能以“只有内部通道会缺 viewer”的代码注释代替平台身份保证；见 L0.1 及本轮返工记录。财务既有静态结论沿用，运行验收仍以 L0.1/F0.1 为准。）（需用户确认：同 L0.1，见该条 2026-10-15 同步 job 标注。）（平台限制登记同 L0.1，见 changes.md 2026-10-15 条目。）
- [ ] `AUDIT-03 / P0` 健康源码及文档不得包含真实健康序列、个人基线、workout UUID、设备 ID 或真实初始快照。（2026-10-14 PM 复核至 `205f544`：health DATA-PLAN 恢复此前脱敏版本，仅保留新增同步机制说明；四组旧个人内容均不再命中，本次回灌隐私返工关闭。首次启动及 owner 运行证据仍待验，整项不勾选；见 L0.4。）
- [ ] `AUDIT-04 / P1` 看房筛选为空时 `filtered[0] ?? report.listings[0]` 仍展示全局首选，hero 与空列表互相矛盾。
- [ ] `AUDIT-05 / P1` 看房 running 状态没有 stale 判断；agent 未 callback 时刷新会永久不可用。
- [ ] `AUDIT-06 / P1` 健康前端只用固定 60 秒等待，没有可查询的来源任务状态；过早完成和超时未完成都无法准确表达。
- [ ] `AUDIT-07 / P1` 健康使用一个全局 `coverageIncomplete` 决定字段显示“还没同步完/当天没戴表”，不能真正做到按字段区分缺失原因。
- [ ] `AUDIT-08 / P1` 训练重量/次数输入只在点击完成按钮时提交；编辑已完成组后直接离开可能丢失，且为了保存需要先取消完成。
- [ ] `AUDIT-09 / P1` 训练 mutation 只按传入 ID 更新/删除，未验证 active workout 归属；完成不存在或已结束 workout 仍可能返回成功。并发 start 也没有数据库唯一约束或事务兜底。
- [ ] `AUDIT-10 / P1` 自动预填按最近一次全部达到上限就加重，周复盘却要求连续两周全部达到上限，两个“下次建议”规则不一致。
- [ ] `AUDIT-11 / P1` 财务应急金使用最新单月支出，最新快照可能是月中或异常；FIRE “还差 X 年”是忽略投资回报的线性外推，但主文案未先说明限制。
- [ ] `AUDIT-12 / P2` 四个 app 尚缺公式 fixture、action 自动测试及可追溯 runtime 回归证据。（2026-10-14 PM 勘误：`ddb105c` 已新增确定性 Handoff Gate，本地执行通过；旧“没有 CI”描述失效。该 Gate 不检查业务公式、身份矩阵或 artifact，不能据此关闭本项。）

### 当前可保留的正确方向

- 健康数据已区分上一完整日与今晨参考，睡眠阶段和 readiness 方法有较完整解释。
- 训练记录有明确 push/pull/legs 模板、历史预填、训练量和周复盘，不应与健康看板合并。
- 财务已把存款与贷款分开、异常月排除出图表/FIRE 支出，并保留上次成功快照。
- 看房已实现预算、3+ 房、城市、面积和首付/利率交互，并明确 P&I 不含税险 HOA。

这些方向只能视为“代码中存在”，不是运行验收通过。

## Muse 实现后的验收流程

### `changes.md` 每条交付必须包含

1. 日期、app、需求编号（例如 `W0.1`）。
2. 用户可见变化及不在本次范围内的内容。
3. 修改文件、schema/migration 变化和兼容策略。
4. 自动验证命令与结果；不得只写“已测试”。
5. Muse artifact 实测证据：owner/guest、成功/失败、手机/桌面、真实或 synthetic 数据类型；证据必须脱敏。
6. 已知限制与回滚方式。

### PM / Design 验收顺序

1. 从 `changes.md` 找到需求编号和声称完成范围。
2. 对照本文验收条件做代码审查；发现范围外副作用先退回。
3. 在 Muse artifact 复验 action、数据库迁移、刷新成功/失败/超时和权限。
4. 在 390×844、430×932 和桌面视口验证加载、空态、长内容、键盘焦点和核心流程。
5. 用独立样例复算关键公式：月供、训练量、lb/kg 换算、睡眠时长/效率、readiness、净资产、FIRE。
6. 验收结果回写本文：只有证据齐全才把 `[ ]` 改为 `[x]`；部分通过不得勾选整项。

## 异步协作框架（OPS-001）

- [ ] `OPS-001` 建立两个角色、一项在制需求、提交即检查、三小时漏检兜底的协作契约。根目录 `AGENTS.md` 约束职责；`.github/workflows/handoff-gate.yml` 在 push/PR 检查提交范围、语法、交付编号和明显凭证；该 gate 不代表业务验收通过。（2026-10-14 PM 独立复核：契约、workflow 配置与本地 Gate 检查已确认；本轮未取得 GitHub push/PR 触发成功记录，撤回新增交付中的自勾选，完整交接链路保持待验。下一业务需求仍为 `L0.4`，不并行扩展 OPS。）
- PM 先在本文定义一个可独立验收的需求编号、边界和证据。Muse 一次实现一项，优先使用 `muse/<id>-short-name` 分支/PR，代码与 `changes.md` 证据一起交付；PM 才能修订本文和勾选验收。
- 正常交接：Muse 完成 → push/PR 触发 Handoff Gate → 通过后通过已授权渠道立即请求 PM → PM 在本文写通过/返工/运行待验 → Muse pull 后继续。每项最多两轮同问题无进展返工，再交由用户决策。
- 当前已配置确定性 CI；GitHub 语义评审与自动唤醒 PM 尚未接通，不能把 CI 描述为自动产品验收。没有即时通道时，以 `changes.md` 留下交付，由三小时任务补检。GitHub CLI 认证/secret 配置当前不可用，后续接通后须用一项 PR 验证从提交到 PM 结论的完整链路。
- 成本控制：先查游标和文件差异，有新业务或新证据才读取相关源码、运行验证；无变化不改文件、不提交。三小时任务自身仍有启动开销，不承诺零 token。

## 每 3 小时兜底验收机制

`plans.md` 是需求、优先级、验收结论和返工要求的唯一事实源；`changes.md` 只由实现方提交“做了什么和证据是什么”，不能自行宣告需求已验收。实现方不得修改 `plans.md` 的勾选状态；只有 PM 验收任务可以把 `[ ]` 改为 `[x]` 或撤回错误勾选。三小时任务只是漏检兜底；Muse 完成并提交证据后应立即发起验收，不应等待下一次轮询。

每轮自动审查按以下闭环执行：

1. 先比较远端 HEAD 与上次已审查源 commit；没有新业务变更、需求设计变更或实现证据时立即结束，避免重复读取整个仓库和消耗 token。存在变化时再安全同步 `origin/main`，读取本文件、`changes.md`、相关 `AGENTS.md` 和对应业务 diff。
2. 没有新的业务变更、需求设计变更或实现证据时不修改仓库、不产生空提交；PM 仅改 plans 的验收提交不算新交付，同一运行待验阻塞没有新证据或环境变化时不重复追加。
3. 新实现没有需求编号或 `changes.md` 证据时，不验收；把缺失证据和下一步写入本文件的“自动审查记录”。
4. 对有证据的实现逐项做范围审查、静态检查和可用的自动测试；需要 Muse artifact 才能确认的项目保持待验，不能用本地编译代替运行验收。
5. 全部满足验收标准时，在对应需求上勾选，并记录通过的源 commit、证据和下一优先项。
6. 不满足时不改业务代码、不勾选需求；写清失败条件、代码位置、复现方式和 Muse 下一次必须提交的修改。
7. 审查只允许修改 `plans.md`；若确需修订需求，必须说明原因。自动任务不得 force push、不得覆盖用户未提交改动、不得直接替 Muse 实现 feature。
8. 文档有实质变化时提交并推送 `main`；发生冲突、工作区不干净或非 main 时保护现场，停止写入并报告。运行验证环境缺失时保持运行待验，不猜测通过；提交前重新 fetch，安全保留并发工作，不能覆盖或改写历史。

### 自动审查状态

- 上次已审查源 commit：`e3c6848f764aec75d00d11c12290b2bc928b35a1`
- 上次运行：2026-10-15 11:28 PDT（自动 PM 验收；本轮开始远端 HEAD 为 `e3c6848`）
- 上次结论：忽略 `71ca51e` PM-only；审查 `8f9f242` 平台限制登记、`7a63c2e` TL需求/责任更新及 `e3c6848` 的 `L1-RACE-001` 交付。保留平台限制与既有例外待决，不要求虚构服务身份 API、不自动收紧同步。固定版本原子写入局部通过；HealthKit 完成时刻版本仍可倒灌旧读取，相同 callback 重试重复 saved，继续返工；两个 save action 的 artifact 落库/回读/页面运行待验。无完整验收项，所有勾选不变。
- 当前应推动：一次只收尾 `L1-RACE-001`：HealthKit 与力量都使用可执行的源读取版本/开始时刻契约；相同版本重复 callback 不重复逻辑保存与 saved，冲突内容明确处理；交付真实 handler 的可复跑回归脚本与脱敏 artifact/version 保存回读证据。修复后再按现有队列 `H-UNITS-001` → `H-SOURCE-001`；仅等待外部运行证据时推进独立 `W-UI-001`，随后 `W-TIMER-001`。`L0.1/AUDIT-02` 平台能力/例外继续单列待决，`L0.4` 与身份矩阵仍为受影响发布门槛，不冻结无关设计开发；保留健康/fitness 优先级，不新增功能。

### 自动审查记录


- 2026-10-13 23:08 PDT · `d439ac6` · `L0.1/F0.1`：**运行待验（证据有新增，未完全通过）**。`changes.md:26` 新增 15 个 action 的非 owner 直接调用汇总，但实现方明确无法区分 guest/anonymous，且没有 owner 与 schedule/callback 成功链证据；本轮重新查找可用工具，未提供 Muse web-artifact builder / invoke_action，不能执行 plan → audit 或验证数据库无写入。Muse 须按实际 15 个路由提交 owner / 已登录 guest / anonymous 分列调用矩阵、合法请求与脱敏 typed response、拒绝前后数据不变证明、后台 schedule 及三个 save/ingest callback 的受信上下文和成功结果；并补 390×844、430×932 与桌面空态/无权限/核心操作和键盘焦点证据。本轮撤回 `F0.1` 旧勾选，`L0.1` 不变。四 app 均尝试 `bun run typecheck`，均退出 127（缺 Bun）；node_modules、运行时 SDK 均缺失，未通过类型检查；没有 test script/fixture，未执行禁用的本地 build，也未读写 app.db。现有阻塞只在这条随新增证据更新，不重复追加旧记录。
- 2026-10-13 23:08 PDT · `d439ac6` · `L0.4/L0.1/F0.1` 交付说明：**返工**。`changes.md:21` 仍称首次启动“写入空快照”，而 `health-dashboard/server/src/actions.ts:592-600` 的 initializeSnapshot 为无写入空操作；`weekly-finance/DATA-PLAN.md:17,24` 仍把 callback 写为不存在的 saveFinanceSnapshot，实际路由为 `weekly-finance/server/src/actions.ts:631` 的 ingestFinanceData。复现：逐项对照这两处文档与 Actions 路由/handler。Muse 下次只修正文档为真实行为与路由，明确本次无 schema/migration 和业务实现变化，提交可追溯的脱敏调用表；审查任务不修改 changes 或业务代码。

- 2026-10-14 02:14 PDT · `ddb105c`（交付 `523a4d4`）· `L0.4/AUDIT-03`：**静态通过（局部，不勾选）**。两处业务 diff 均只有刷新 prompt 一行：health 的固定个人基线改为从完整日数据派生，finance 改为运行时解析主目录，解析失败要求 `success:false` callback；设备仍在运行时解析，没有靠删除来源破坏定位。92 个 tracked 文件扫描 UUID 0、`INITIAL_*` 0、绝对用户路径 0、固定 device flag 0；通过对照旧 blob 确认个人基线原句不再出现，仅输出命中数。`changes.md` 已更正 initializeSnapshot 无写入空操作，finance DATA-PLAN:17,24 已更正为 ingestFinanceData；初始化 handler:592-600 与实际 callback:631 可对应，旧文档返工关闭。本轮未改 schema/migration、UI 或 readiness；prompt 输出契约发生变化，不能按“无业务逻辑变更”跳过兼容验证。
- 2026-10-14 02:14 PDT · `ddb105c` · `L0.4`：**返工（新的契约缺陷，静态确认，未冒称实测）**。位置：health-dashboard/server/src/actions.ts:655 要求少于 14 个完整步数日或无数据时 baseline/usualMin/usualMax 为 null，但 :99-103 三字段仍为必填非 nullable 数字，saveHealthSnapshot:618 使用该 request schema；client/src/App.tsx:86-93、279 的 MetricBars 也只接受数字，null 若仅绕过校验会被 Math.round/Math.max 当作 0。复现输入为明确 synthetic 的 13 个完整步数日（其余请求字段合法），按新 prompt 令 steps 三基线/范围字段为 null：契约静态推导该 callback 无法通过当前 request 校验；另须覆盖 14 日全零和高方差均值减标准差小于零，当前 positive/nonnegative 约束与未限定的均值±标准差不一致。预期：短历史仍能保存已获取的真实指标、基线/范围诚实标为缺失，趋势不伪造 0 基线；完整样本的有效零与非负范围有明确规则。下一次只修此原子边界：统一生成/保存/旧快照读取/前端展示的缺失值与范围契约，说明是否需要 migration 与旧数字快照兼容、回滚；不要回填个人常量或顺带修改 readiness/H1。必须交付上述 synthetic 样例的可复现命令/断言和脱敏结果，及 owner artifact callback 保存/回读、缺失态在 390×844、430×932 与桌面显示证据。
- 2026-10-14 02:14 PDT · `ddb105c` · `L0.4`：**运行待验（源码有进展，证据未齐）**。weekly-finance/server/src/actions.ts:618 的主目录解析成功与失败、:646-650 失败回调保留旧数据、health 首次空库 initializeSnapshot 不写入 fixture、健康 owner 同步成功均缺可复现独立运行证据。可用工具未提供 Muse web-artifact builder / invoke_action，不能走 plan → build → audit → submit，未运行本地 build、未读写 app.db。Bun 仍不可用，沿用原类型检查阻塞，本轮不重复执行四 app 失败命令。Muse 下次交付脱敏 owner 刷新成功、主目录/来源不可用失败且旧快照保持不变、首次空库前后无种子写入的操作步骤与 typed 结果；后台受信上下文仍引用既有 L0.1/F0.1 待验要求。
- 2026-10-14 02:14 PDT · `ddb105c` · `OPS-001` / Handoff Gate：**本地检查通过，完整交接待验**。独立运行 `node --check scripts/validate-handoff.mjs` 和 `node scripts/validate-handoff.mjs d439ac6e3e9bba25d1ec8f7cdba0a9e3143d68d2 ddb105ce4bb0647687aafbfd18b8477a080dda8d` 均退出 0（8 files / 1 script / 2 implementation files）；分别检查 85af069..523a4d4 和 523a4d4..ddb105c 也退出 0。workflow 配置为 push main/PR、Node 22、fetch-depth 0 和只读 contents 权限；本地成功不能证明 GitHub 已触发运行。撤回新增交付的 OPS 自勾选，须补脱敏 push/PR Gate run 结果与一项提交到 PM 结论的交接记录。Gate 的语法/凭证/已知编号检查不代替权限、公式、schema、刷新幂等和手机运行验收。`85af069` 为仅 plans 审查提交，已忽略。本轮同步机制文字只为对齐当前授权的“需求设计/新增证据也触发，重复待验不触发”规则，不新增功能队列。

- 2026-10-14 05:18 PDT · `be86e01` · `L0.4/AUDIT-03`：**静态通过（局部，不勾选）**。独立核对四文件交付 diff 和 changes 编号/范围：actions.ts:101-103 三展示字段允许 null/非负数，:655 prompt 明确完整日、14 日门槛、有效全零和非负下界；client App.tsx:86-93,248 的 null 分支不再伪造零基线。saveHealthSnapshot:618 请求与 normalizeStoredSnapshot:530 回读共用 snapshotSchema，旧数字格式为放宽兼容；schema.ts 与 migrations 未改，payload 仍为 JSON blob。readiness 函数与交付前逐字比较相同。回滚旧代码无法解析新 null 快照而显示空态，changes 已披露，不能称无损回滚。93 个 tracked blob 扫描 UUID / INITIAL_* / 绝对用户路径 / 固定 device flag 均 0，只输出命中数。原 02:14 null/schema 冲突关闭，整项未完全通过。
- 2026-10-14 05:18 PDT · `be86e01` · `L0.4`：**返工（缺基线的结论仍不诚实）**。位置 health-dashboard/client/src/App.tsx:237,244,248；server/src/actions.ts:99-108,655。复现：明确 synthetic 的 13 个完整步数日、当日 steps.value 为合法非空数值，baseline/usualMin/usualMax 均 null，其他快照字段合法。直接用 Node 提取源码 stepSummary 表达式求值：status=正常 时仍说“步数在常见范围”；status=数据缺失 时说“步数未记录”，与已获取步数矛盾；偏低/偏高同样没有可比较范围。此为纯表达式复现，未冒称页面实机结果。预期：先区分原始值缺失与比较基线不足，有值无基线保留值、说明“基线不足，无法比较”，不输出正常/异常或未记录结论；有有效零基线时仍正常展示零。下一次只统一这个步数展示/状态边界（首页摘要、KPI 标签、趋势），不得顺带改 readiness/其他指标；提交合法完整 synthetic null/零/旧数字快照输入、预期文案断言和 artifact 三视口截图/操作证据。
- 2026-10-14 05:18 PDT · `be86e01` · `L0.4`：**返工（synthetic 边界证据不足）**。位置 health-dashboard/validate-steps-contract.mjs:28-32,36-40,47-48。现有半数零/半数相同大值的 14 日样例，其总体均值恰等于标准差，未钳制前的下界为零，无法检出删除 max(0, …) 的回归；check 仅断言 schema 接受/拒绝，不断言派生字段与窗口。独立在内存提取交付 deriveSteps 并用 node:assert 核对：13 日为 null、14 日全零为零、原样例下界为零、14 日中 13 个零加一个正值的原始下界为负且 helper 返回零，四例算术断言通过；只证实测试 helper，不是 agent 的生产计算/保存运行。下一次将真正负下界样例纳入交付脚本，明确断言三字段期望值/缺失状态，加入无数据场景，并证明移除钳制会失败；交付可复现完整命令和脱敏结果，不能只用 safeParse 成功声称公式通过。本轮已修正前次契约缺陷，有实际进展，不触发“两轮同问题无进展”升级。
- 2026-10-14 05:18 PDT · `be86e01` · `L0.4` 新快照 / Handoff Gate：**运行待验；本地 Gate 通过**。node --check scripts/validate-handoff.mjs、node scripts/validate-handoff.mjs ddb105ce4bb0647687aafbfd18b8477a080dda8d be86e01557bd96c7e69c93a9887f6398cd864338（5 files / 1 script / 3 implementation files）、单交付范围 17e32f241b062774ecf40400bdd42b45b2cdacd7..be86e01557bd96c7e69c93a9887f6398cd864338（4 / 1 / 3）均退出 0。直接 node health-dashboard/validate-steps-contract.mjs 退出 1：ERR_MODULE_NOT_FOUND zod；没有在仓库安装依赖或运行禁止的 build。未提供 Muse web-artifact builder / invoke_action，changes 的非 owner getDashboard 拒绝不能证明新 null 快照保存、回读或页面显示。新增必须交付：同一合法 synthetic 快照分别用 null / 有效零 / 旧数字步数范围，以受信 owner callback 保存再 getDashboard 回读，证明原始步数/独立 readiness 不受损，并在 390×844、430×932、桌面核对首页/KPI/趋势及空缺状态。changes 声称临时副本 tsc 通过，本轮未独立复验、不计运行成功。原 owner 刷新/配置缺失/首次空库、L0.1/F0.1 三身份与后台受信链、OPS 托管 Gate/即时交接阻塞无新证据，不重复追加。

- 2026-10-14 08:14 PDT · `1bcedec` · `L0.4/AUDIT-03`：**静态通过（局部，上轮展示返工关闭，不勾选）**。交付有明确 ID、四文件范围与 changes.md:55-59 的验证/兼容/回滚说明。App.tsx:237-239 先判断原始值缺失与 baseline/usualMin/usualMax 任一 null，:250 KPI 使用派生 stepStatus，:246 首页保留已获取步数；有值无比较基础不再称常见范围/偏低/偏高/未记录，零基线仍为有效值。独立执行 `node health-dashboard/validate-steps-display.mjs` 7/7、退出 0；另在 Node stdin 从实际源码抽取三表达式，对三基线字段分别 null × 四状态、value=null × 四状态及有效零执行 17 个 synthetic 断言，全部通过。这些是表达式验证，未当作浏览器实机结果。服务端、schema/migration、刷新/callback、readiness 及其他指标实现均无 diff；旧数字兼容和原 null 快照回滚限制沿用上一轮。Muse 的门禁页审计/非 owner 拒绝声明不能证明 owner 页面或保存链路。既有 05:18 owner 保存/回读与三视口要求仍运行待验，无新环境变化，不重复追加。
- 2026-10-14 08:14 PDT · `1bcedec` · `L0.4` synthetic / Handoff Gate：**静态通过（局部，边界证据返工关闭）**。validate-steps-contract.mjs:47-78 已明确断言三派生字段，加入无数据、全零、同值和真正负下界；在 Node stdin 内存抽取从 deriveSteps 至文件末尾，注释顶层 schema check 调用、保留原 checkDerived/负下界断言，6 个派生案例加负下界检查共 7/7 通过；只将 `Math.max(0, mean - sd)` 替为 `mean - sd` 后退出 1、1 个派生断言失败，独立确认钳制回归可检出。此为测试 helper 算术，不是 agent 生产计算；直接 `node health-dashboard/validate-steps-contract.mjs` 因 `ERR_MODULE_NOT_FOUND`（zod）退出 1，未复验 Muse 声称的完整 14/14 或临时 tsc，不冒称 schema/运行通过。`node --check scripts/validate-handoff.mjs`、`node scripts/validate-handoff.mjs be86e01557bd96c7e69c93a9887f6398cd864338 1bcedec36f75aaabed3dc21b67fbdb985f6fca52`（5 files / 2 scripts / 3 implementation files）及 `f023f347e35f6eaa4436e4e942943358a4b22b6b` 到同 HEAD（4 / 2 / 3）均退出 0。94 个 tracked blob 的 UUID/INITIAL_*/绝对用户路径/固定 device flag 扫描命中均 0，仅输出计数。本会话工具无 Muse builder/invoke_action，未安装依赖、未本地 build、未访问 app.db；未新增旧运行阻塞记录。有实际返工进展，不触发两轮无进展决策升级。

每轮只保留最近 20 条，格式为：时间、源 commit、涉及需求、结论（通过 / 返工 / 运行待验）、证据或阻塞原因。

## 推荐执行顺序

1. 按本轮反例先完成 `L1-RACE-001` 的HealthKit源版本与重复callback返工及运行验收，再处理 `H-UNITS-001/H-SOURCE-001`，每次一项；仅等待平台能力/证据时推进 `W-UI-001`、`W-TIMER-001` 的可见交付。`L0.1/AUDIT-02` 后台能力/例外与 `L0.4` 既有保存回读/三视口矩阵保持受影响发布门槛，不据此通过，也不冻结无关设计开发。后续分析/新功能仍按真实数据依赖验收。
2. `L1` + `H0`：统一来源级刷新状态、coverage、stale recovery 和时间语义，建立分析可信基础。
3. `W0/W1`：修复训练记录丢失、越权目标、并发 active workout 与两套建议规则冲突。
4. `H1.1–H1.8`：修正 readiness 的时间对齐、基线泄漏、覆盖门槛、稳健统计和缺失展示。
5. `H3` + `W3`：在数据与算法可信后，上线每周健康复盘、RIR/RPE、动作级趋势和统一渐进负荷引擎。
6. `HH0` + `F0/F1`：完成看房与财务的 P0 正确性；随后再做 `H2/W2/W4/F2/HH1` 的体验和新功能。
7. `H4` + `W5` + `F3`（同类产品调研新增，P2）：在体验和新功能批次之后推进；看房类调研候选（周报增量 Diff、Quiet Score 等）经用户决定暂不纳入。

## 当前状态

- [x] 完成四个 app 的第一轮 PM、设计和静态代码审计。
- [x] 建立需求编号、优先级、发布门槛和 Muse 交付验收流程。
- [ ] Muse 按推荐顺序实现 P0。
- [ ] 同类产品调研候选已排入队列：`H4` 5 项、`W5` 3 项、`F3` 5 项（用户 2026-10-13 批准启动）；调研候选 T2/T3 已被 `W3.1/W3.3/W3.5` 覆盖、未重复纳入；看房类候选暂不纳入。
- [ ] 在实际 artifact 对 P0 做首轮运行验收。

- 2026-10-14 11:19 PDT · `7d848b7` · `L0.4/AUDIT-03`：**返工（回灌隐私回归；未完全验收）**。health-dashboard/DATA-PLAN.md:5-25、50、64-66 从已脱敏文档回退到真实来源日期/时间、个人基线、日序列、晨间指标、睡眠阶段与行为明细；:7,13,17,21 四组内容与历史 `e54adca` blob 完全一致（仅记录位置和 4 组命中，不复述原值）。复现：对比 `git diff 8b87c09..7d848b7 -- health-dashboard/DATA-PLAN.md` 的本地内容并使用不输出原值的扫描；94 个 tracked blob 的 UUID/INITIAL_*/个人绝对路径/固定 device flag 均 0，不能把窄扫描当作个人健康数值清零。预期：恢复之前明确 synthetic、占位日期及脱敏来源说明，保留本轮必要同步机制说明；禁止给真实值加 synthetic 标签冒充脱敏。另 client/src/App.tsx:297 把 stepsBaselineMissing 改名，未同步 validate-steps-display.mjs:17-24；`node health-dashboard/validate-steps-display.mjs` 退出 1（expression not found），旧 7/7 验证不再有效。独立抽取当前 stepsBaselineIncomplete/stepSummary/stepStatus 的 18 个 synthetic 边界断言退出 0，只证明表达式，不证明真实渲染。下一次仅交付 L0.4 隐私恢复及既有展示验证契约修复：changes 写明确 ID/修改范围/无 schema migration 或实际兼容策略/回滚边界，附全仓个人内容扫描的位置与计数、脚本可复现断言；不得附原始健康值。随后补原 owner null/零/旧快照保存回读与三视口证据。本次是已关闭问题的新回灌回归，尚未构成连续两轮同问题无进展。
- 2026-10-14 11:19 PDT · `7d848b7` · 交付门槛及 `H0.4/L1` 候选范围：**不予验收／运行待验**。changes.md:61-66 新条目没有 plans 需求 ID、精确验证命令/typed 结果、schema/migration/API 兼容与回滚说明；构建审计两轮 pass/双视口/非 owner 汇总不能替代可复现证据。`node --check scripts/validate-handoff.mjs` 与 `git diff --check 8b87c09..7d848b7` 退出 0；`node scripts/validate-handoff.mjs 8b87c09f456fbf927d82f02da359d49b22f8a8ef 7d848b7bc948f7917e5228deca0735f1245dc328` 退出 1（缺已有需求 ID）。独立核对 health 现 8/8 action 首句严格 owner guard，新增 refreshStrengthTraining/getRefreshStatus 在 agent 调用前拒绝非 owner，静态局部通过。DB schema/migration 无 diff，但 response 新增必填 task 字段，须说明客户端/服务端同步发布和回滚兼容。风险复现步骤（源码推导，未冒称 artifact 实测）：从两个 owner 标签页重复同步或让自动任务运行超过两分钟再读 getDashboard，actions.ts:575-588 仅 worker 内节流且桶会变化，:701,728,730 使用 allowParallel；:539-553 两种保存均无条件 upsert，先发旧任务 A、再发新任务 B，按 B→A 顺序 callback，缺任务版本/sourceUpdatedAt 比较，会允许旧数据覆盖新数据。预期 L1.3 同源运行任务复用、幂等/旧 callback 不覆盖；不得用每次新建并行任务替代该保证。App.tsx:427,445 与 :467,474-476 使用分开的轮询实例，后台自动任务不参与 Dashboard 的按钮禁用/失败提示，已存在数据视图无法看见自动同步失败；有缓存也须展示来源级失败/旧数据。没有持久来源状态、未确认 reload 后任务恢复及两个来源部分成功表现；来源/训练量公式 prompt 既有口径未修改，本轮不重新验收公式。实现方须在 changes 引用准确已有 ID，给该最小需求提交三身份直接调用（清单现为 health 8 路由）、后台受信 callback、同源双击/跨标签页/旧 callback/超时重试/来源失败保留缓存和 390×844、430×932、桌面的 synthetic 脱敏步骤与结果。当前工具无 Muse builder/invoke_action，未运行禁止本地 build、未安装依赖、未读写 app.db；既有运行阻塞不重复追加，新同步及 API 边界保持待验。当前先完成上一条 L0.4，不并行扩展刷新需求。

- 2026-10-14 14:13 PDT · `205f544` · `L0.4/AUDIT-03`：**静态/可复现脚本通过（两处返工关闭；整项运行待验）**。本轮开始远端 HEAD 为 `205f544afb97e26edbe433403fa6082ad7d6f3f6`，忽略 `3f8fab2` PM-only 提交。changes.md:68-74 已给准确 ID、三个文件范围、无 schema/migration/API/业务/UI 变化、回滚及证据限制；独立对照 diff，回滚会恢复未脱敏文档与失效脚本，不能作为安全脱敏回退。DATA-PLAN.md:5-25、50、64-66 已恢复此前脱敏文本，除 :59 一行 Timeliness fix 外与 `8b87c09` 逐字一致；四组原个人内容精确比对剩余命中 0，四处 SYNTHETIC 标签为无个人数值结构说明，未以重新标注真实值冒充脱敏。94 个 tracked 文件窄扫描 UUID/固定 device flag 均 0，源码 INITIAL_*/绝对用户路径均 0；DATA-PLAN 实际测试日期、带单位两位小数、长步数序列、精确时刻专项扫描均 0，只输出位置/计数，窄扫描不代表全仓个人数值绝对清零。validate-steps-display.mjs:21-29 已跟随当前 App.tsx:297-299 的 stepsBaselineIncomplete 绑定，:38-40 新增有值/完整基线但 status 缺失样例；独立执行 `node health-dashboard/validate-steps-display.mjs` 退出 0（8/8 synthetic 文案组），`node --check health-dashboard/validate-steps-display.mjs` 与 `git diff --check 3f8fab2..205f544` 均退出 0；`node scripts/validate-handoff.mjs 3f8fab23f7750102685d77f3e3da667b1b4bc6f1 205f544afb97e26edbe433403fa6082ad7d6f3f6` 退出 0（3 files / 1 script / 1 implementation file）。以上仅验证仓库脱敏与表达式脚本，构建方 pass/非 owner 汇总不能证明 owner 产品流程通过。无 Muse builder/invoke_action，未执行禁止本地 build、未安装依赖、未读写 app.db；既有缺 zod 的完整 contract 脚本和 owner/后台/三视口阻塞未变，不重复运行失败命令或追加记录。L0.4/AUDIT-03 不勾选，下一次只补当前应推动的受信 owner synthetic 保存回读与三视口及原运行证据；本轮有实质修复进展，不触发两轮无进展决策。

- 2026-10-15 02:21 PDT · `04bd2a2`（新交付 `79dbd07`）· `L0.1/AUDIT-02`：**P0 返工；撤回 AUDIT-02 勾选**。位置 health-dashboard/server/src/actions.ts:185-187、895-925、1026-1034，workout-log/server/src/actions.ts:115-117、142-153。新 isOwnerOrSyncChannel 将 null/undefined viewer 与 owner 同等放行；两个健康 callback 可保存，健康刷新可 spawn，训练读取可返回完整历史。changes.md 自述平台无可验证服务凭据，源码/DATA-PLAN 却断言无 viewer 只有内部调用可产生，缺保证。独立 Node stdin 用 node:module.stripTypeScriptTypes 从两份实际源码抽取 guard，并以 node:vm/node:assert 检查 owner、guest、null、缺 viewer 四例：两 app 均 owner=true、guest=false、null=true、缺 viewer=true，确认谓词回归；这不是 artifact 匿名调用实测，不声称已发生外部泄漏。预期未认证调用拒绝且零读/零写/零 spawn，受信后台需可验证身份、当前 app/来源/任务归属与权限范围，不能仅凭缺 viewer、请求参数或注释。下一次只交付此四入口原子修复；按 L0.1 在 changes 引准确 ID/范围、兼容/回滚、可复现命令与脱敏三身份分列结果、拒绝前后数据不变和后台 schedule→callback 成功链。平台若无法提供受信能力，保留门禁、显式显示同步不可用并说明能力缺口，不能再次匿名放行。本轮因新隐私风险优先于 L0.4，未新建功能队列；首次回归返工，尚未达到两轮同问题无进展升级条件。
- 2026-10-15 02:21 PDT · `04bd2a2` · `L1.1–L1.5/H0.4/H0.6/L2.1` 候选交付：**返工，不验收；先完成上一条 P0**。changes.md 最新一体层条目无准确需求编号、无完整兼容/回滚及可复现 owner 证据；不能把整组面板视为一个已批准最小需求。新后台失败 note 已由 App.tsx:554、601 透传已有数据 Dashboard，关闭旧“后台失败文案完全不可见”静态问题，运行仍待验。两条 persist 的新顺序守卫有进展，但 actions.ts:564-577、586-601 是 select→无条件 upsert，缺事务/条件写：独立 Node stdin 抽取实际函数、仅去除 TS 类型，以 synthetic mock DB 固定两请求都读旧值，延迟旧请求写入至新请求完成之后；health/strength 两例均最终退回旧版本（断言通过，只证明 mock 调度下源码竞态，非 artifact 实测）。strength updatedAt=null 还会跳过比较；相等版本仍重复写 saved 台账。actions.ts:697-715 只有 worker 内两分钟缓存/时间桶，:938、1037-1039 继续 allowParallel，无持久来源任务复用；自动 spawn 拒绝/异常直接 null，失败台账只依赖 getRefreshStatus 被客户端查询（:950-952），关页/无轮询无持久失败证据，不能声称不再静默。后续 L1 最小交付须证明同源双击/跨标签页/重启复用、超时重试、重复/晚到 callback 原子拒绝与按源失败保留缓存，task/source 关联和失败落盘不能依赖页面存活。新时间线 actions.ts:814-821 直接累加 workout.totalVolume，App.tsx:371、484 用统一 displayUnit 标注，却未逐条按 workout.unit 换算；独立抽取 buildUnifiedTimeline 的 synthetic 同日 100 lb + 100 kg、displayUnit=kg 返回 200，预期按既有系数换算为约 145.4 kg。后续在 L2.1 边界修正聚合/日期/coverage，明确只有记录日并非连续14个日历日，不能以缺记录作零；时间戳新鲜不等于来源日期新鲜。只记录此次新增风险，不并行要求实现这些扩展。
- 2026-10-15 02:21 PDT · `04bd2a2` · 交接与运行证据：**局部检查通过；单提交 Gate 失败；运行待验**。本轮清洁 main 从 af6ecea 安全快进到起始远端 `04bd2a23d8f19dd19cdd4509d34215d3f682ca5a`，af6ecea 为 PM-only 忽略。独立执行 `node scripts/validate-handoff.mjs af6ecea 04bd2a2` 退出0（11 files/0 scripts/7 implementation files）；af6ecea..79dbd07 与79dbd07..f8a195e 单段 Gate 退出0，`node scripts/validate-handoff.mjs f8a195e 04bd2a2` 退出1：Added changes.md evidence must cite an existing plans.md requirement ID。汇总检查借前一条的 L0.1 文本通过，不代表新一体层有需求映射。`node --check scripts/validate-handoff.mjs`、`git diff --check af6ecea..04bd2a2`、`node health-dashboard/validate-steps-display.mjs` 均退出0，后者8/8 synthetic；窄扫描 tracked 文件 UUID/个人绝对路径/固定 device flag 命中文件数均0，不能据此宣称全部个人数字清零。新增0005 SQL只在 Python sqlite3.connect(':memory:') 独立空内存库解析，sync_log七列与journal末项对应，退出0；这是SQL/静态一致性，未接触 app.db，不能证明 artifact升级、旧数据兼容或回滚。台账写入/读取异常 actions.ts:723-754 被吞成无日志，需迁移成功/失败不冒充健康的运行证据。本会话仍无 Muse builder/invoke_action，未执行禁止本地build、安装依赖或访问app.db；构建方pass、非owner门禁及“两视口正常”不能证明owner面板或打开→受信同步→保存回读，也不能覆盖390×844、430×932与桌面核心流程。新增API字段与migration须在对应最小交付中补同步发布/旧客户端兼容、保留历史数据的回滚方案和脱敏运行步骤。既有L0.4 owner/空库/配置失败及三视口阻塞无新证据，不重复追加；本轮无完全通过项，19条审查记录（≤20）。

- 2026-10-15 05:18 PDT · `89a22c6` · `L0.1/AUDIT-02`：**设计冲突待决；原权限返工/运行待验不变**。清洁 main 从 e5d5134 安全快进至本轮起始远端 `89a22c64f8d67208b3d7612401f900a6bd7b2917`；游标后的 e5d5134 为 PM-only 忽略，新增仅 plans.md 两处「需用户确认」标注，无业务、schema/migration、UI 或 changes.md 新证据。复核 plans.md 的 L0.1、AUDIT-02、组合成功标准及 changes.md 同步链残余风险说明：新标注声称已有用户接受内部通道/风险，但未在本文件明确改写原门禁验收与例外边界，不能据此勾选，也不由 PM 自动推翻其所述授权或要求实现方立即冻结同步。保留该标注，统一当前在制项和推荐顺序；下一次仅补既有决定的可追溯脱敏摘要及入口/能力/调用方/风险/复审与回退范围，或明确选择严格门禁及同步不可用状态，再按确定边界交付。无新修复，本轮不虚计一次失败实现返工；不重复追加旧 owner/三视口/平台阻塞。独立 `node scripts/validate-handoff.mjs e5d5134 89a22c6` 退出0（1 file/0 scripts/0 implementation），`git diff --check e5d5134..89a22c6` 退出0。工具仍无 Muse builder/invoke_action；未本地 build、未安装依赖、未访问 app.db；无运行成功结论。仅 plans.md 有实质审查变化，游标更新到起始远端，现20条审查记录（≤20）。

- 2026-10-15 11:28 PDT · `e3c6848` · `L1-RACE-001`：**局部修复通过；返工；artifact运行待验，整项不勾选**。本轮起始远端 `e3c6848f764aec75d00d11c12290b2bc928b35a1`；清洁main由7a63c2e安全快进，游标后71ca51e为PM-only忽略，8f9f242登记平台限制、7a63c2e更新TL职责/明确需求，本轮只验一项竞态修复。已读根/health AGENTS、plans、changes及3文件实现diff，追踪请求schema→既有身份guard→save handler→persist→sync_log/invalidate→getDashboard合并→客户端轮询。源码两条单语句条件upsert+RETURNING消除了“固定版本先查后写”竞态；strength null映射epoch，payload仍null；schema/migration及UI无变更，原blob读取兼容，新增outcome保留ok/forbidden，changes有回滚说明。实际persist函数经node:module.stripTypeScriptTypes与node:vm抽取，注入受控query adapter、sql tag、normalizeSleep恒等桩及内存SQLite（仅`:memory:`），独立22个断言通过：固定新版本后旧版本ignored且无saved/invalidate、null先创建后有效替换/晚到null拒绝；同时确认以下反例。另抽取两个真实save handler，注入persist桩，guest零persist调用、owner applied/ignored返回通过；不是request schema/SDK/Drizzle或artifact验证。
  - **P1 返工：HealthKit来源版本仍可倒灌。** `health-dashboard/server/src/actions.ts:1057` 的refreshHealthData prompt仍在读完数据后要求updatedAt为“real current instant”，:578-583只比较此值；仅:703的strength prompt改readStartedAt。复现（全部synthetic）：早任务先读取旧源并延迟，新任务较晚读取新源且先保存（版本02:00），早任务03:00完成并依原prompt回写updatedAt=03:00；调用抽取的真实persistSnapshot，第二次返回true，最终payload为旧读取，符合当前代码但违反晚到旧任务不得覆盖新数据。预期比较源版本或读取开始时刻，与完成时刻分离；下一次只补HealthKit相同可执行契约与倒序完成反例，不能仅断言SQL比较已正确就宣布两来源都安全。禁止回填个人常量、改readiness或扩功能。
  - **P2 返工：同版本callback不具备副作用幂等。** `actions.ts:583,586-588,611,614-616` 使用>=；同一版本同一payload重试在两条真实persist路径均再次返回true、saved计数从1变2、invalidate计数从1变2。`validate-persist-race.mjs:165-171`甚至用不同payload同版本覆盖后称幂等，没有断言日志/返回/拒绝副作用。重复回调可挤占最近8条台账、掩盖失败；同版本不同内容还可最后到达者胜出。预期同版本相同内容不重复逻辑保存/saved，采用ignored或明确兼容的duplicate语义；同版本不同内容明确冲突策略，不能无条件覆盖。下一次在本项内交付真实handler可复跑测试（不是只手写等价SQL+源码regex），覆盖双路首次竞争/固定旧版本/同版本相同与冲突payload/null、saved与invalidate计数、typed outcome，并证明删除守卫或版本契约会失败。
  - **验证与交接边界。** 独立`node health-dashboard/validate-persist-race.mjs`为41/41退出0，但仅源码断言+手写SQL矩阵；上述独立真实函数/handler验证明确使用桩，不证明生产SQL生成、请求校验或实际数据库。`node scripts/validate-handoff.mjs 89a22c6 e3c6848`退出0（5 files/1 script/2 implementation）；71ca51e..8f9f242、8f9f242..7a63c2e、7a63c2e..e3c6848各段Gate均退出0，最后一段3/1/2；`git diff --check 89a22c6..e3c6848`退出0。无依赖安装，不重复旧缺依赖typecheck；实现方声称tsc/build/audit pass与非owner getDashboard只作为交付自评，未独立复验。工具无Muse builder/invoke_action，未本地build、未访问app.db。下一次通过平台允许的隔离测试artifact走plan→build→audit→submit，给实际artifact/version、两save的applied/ignored/重复回调→回读→页面保持新版本及旧格式兼容的脱敏证据，不要求写生产库。现有L0.4 owner/空库/三视口及L0.1后台身份阻塞无新运行证据，不重复展开；平台无服务身份按既有登记单列，不把PM旧谓词测试当作平台完整身份能力证明，不据此批准null例外。本轮实际修复有进展，不计两轮同问题无进展。下一交付仍仅L1-RACE-001收尾；20条审查记录上限保留。
