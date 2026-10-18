# Plans

本仓的目标不是继续堆四个互不相干的页面，而是把它们做成一组可信、可持续刷新的个人生活工具：用户打开后能在一分钟内知道发生了什么、数据是否新鲜、下一步该做什么；任何健康、训练和财务结论都必须能追溯到真实数据，不能用漂亮界面掩盖缺失、过期或推断。

本文同时是 PM 需求文档、设计约束和 Muse 交付验收基线。Muse 实现任何需求前先引用需求编号；实现后在根目录 `changes.md` 写明编号、改动文件和验证证据。没有进入 `changes.md` 的实现一律视为尚未交付。

## 当前协作规则（2026-10-17 所有者确认，双仓共用）

以根 [CHARTER.md](CHARTER.md)《实现—PM 协作准则（快速迭代版）》及所有者最新指示为准。PM 是反馈者、需求源与产品推进者，Muse 是执行者兼提案者。实现不等验收；下文历史“待验／不勾选／下一唯一原子／发布门槛”只保留当时证据与反馈，不再作为实现、后续条目或上线门控。业务判据和真实缺陷保留，不能因修订流程伪称实测通过。

- **单一队列**：P0（数据安全／权限／管道缺陷、线上与存档级 bug）＞用户直提需求＞PM 需求与普通 bug＞证据与文档尾巴。每轮全量处理明确可执行项，无数量和包数上限，同类打包；仅单项确实耗时可顺延，记录条目、原因、责任方与日期，继续其他工作。
- **直接推进**：取消所有等前项验收链条，真实技术依赖具体说明。既有方向内的小增量可由 Muse 直接入队实现，changes 标“实现方提案”；新系统、新方向先请所有者拍板。含糊、花钱、删除、对外发送、动账户或新增发布目标等未经授权事项先汇报，其他工作继续。
- **每轮三类产出**：bug 单（编号、严重度、版本位置、复现、影响与判据）、新需求单（编号、范围、优先级）、至少一项实质产品推进；只交 bug 清单不完整。没有新 bug 就注明无，不虚构；需求避免同义堆积，可实质推进已有方向。
- **质量不降、反馈不设闸**：Handoff Gate、changes 全量证据照旧。数据脱敏、权限、数据管道、公式／单位／窗口与存档安全属 A 类，全套严守；纯呈现及证据形式属 B 类，构建审计＋验证脚本＋数据对账足够，形式缺口只记次要跟进。要求首次一次列齐，后续仅真实新缺陷可加返工。结构性无法取得的所有者截图不作前置要求；缺必要证据如实标问题并列判据，不能把缺证据冒充代码缺陷或 P0。
- **复验与交付分账**：存量积压批量逐条事后标“已验证／有问题”，问题转同一队列 bug；不悬置，也不阻塞实现上线。plans 的“[完成]”仅代表已交付，不能推定已获 PM 验证；PM 结论以评审记录为准，实现方不自写验收结论。源码已修问题不因缺 owner 截图重开，同 hash 已过检查复用。
- **Life 上线已授权**：既有产品范围内自检通过直接经允许的 builder 流程上线，不等 PM 或额外例行点头；最终以所有者本人打开实际生效版本所见为准。分别记录交付／提交生效／用户确认，不伪称用户已看见。主状态只用“已上线在用／已交付／进行中／待办／已下线”，PM 反馈另列；游戏仍请所有者点头发布。上线严重缺陷转 P0，必要时按授权回滚。
- **L0.1 例外已批准**：space-4 刷新入口＋两个保存回调、space-6 getDashboard 只读入口，无身份内部同步调用维持现状，用户已知情接受风险；面向真人读取保持严格所有者校验，不扩大例外。平台可验证服务身份可用之日复审迁移，不逐轮重开。用户可随时撤销，届时同步停摆、页面明示不可用。
- **方向和周期**：用户方向／反馈一个评审周期正式回应编号、优先级、排期或不做理由，两个周期交具体方向提案，与积压处理并行；保留原截止周期，未拍板新方向不开工。P1 以天计、周为上限，超限写明卡点与责任方。
- **度量与运行**：每轮报用户可见增量数、队列中位等待时长，说明已交付／已上线、样本及时间口径；时间戳缺失如实标不可计算，不编造，流程改动不计产品增量。三小时仅漏交接兜底，即时交付即时反馈；无新代码但有产品推进、方向或上线跟进仍推进。保护并发、不空提交。PM 维护 plans 与落实准则的协作文档，不改业务代码／schema／changes／数据，不本地 build、不碰 app.db，所有证据脱敏。

### 2026-10-15 TL 源码审查（基于 `8f9f242`，未修改业务代码）

- [ ] `L1-RACE-001`（P1，health与strength双路径快照并发/幂等）比较来源版本与写入必须为一个原子操作，覆盖首次创建竞争、固定较旧版本拒绝、相同版本幂等、null更新时间不能覆盖有效新快照；使用可执行的来源版本/读取开始时刻契约，禁止把较早读取的完成时刻当新版本。callback返回区分applied/ignored，saved只记录真正的逻辑保存，保持旧快照与响应兼容。交付真实handler可复跑反例及修复断言，再给artifact保存回读/页面证据，不引入不存在的平台身份API。历史缺陷与独立mock见2026-10-15记录。**PM复核至 `3b26882`：两条源码/本地回归返工关闭，整项运行待验，不勾选。** HealthKit prompt 已统一读取开始时刻契约；双路严格 > 原子写入，同版本相同内容duplicate、不同内容conflict且先到者胜出，均不重复saved/invalidate。独立交付脚本42/42与补充真实handler控制84断言通过；后者仍用受控adapter/schema桩及内存SQLite。实现方沙箱探针摘要尚缺可复核artifact/version、保存后回读和匹配页面证据；不要求生产库写探针。下一实现只推进既有 `H-UNITS-001`，本项等平台证据后继续验收，不重复已关闭源码返工。
- [ ] `H-UNITS-001`（P1，源码与实际函数 synthetic 调用已确认）`health-dashboard/server/src/actions.ts:814-818` 累加 workout.totalVolume 时忽略 workout.unit；client/src/App.tsx:371,484 统一标 displayUnit。实际 buildUnifiedTimeline 输入同日100 lb和100 kg、displayUnit=kg，返回200，正确按本仓换算与一位小数应为145.4 kg。请求 Muse 在服务端按目标单位换算后汇总，并审计 readiness.currentVolume 等其他跨训练聚合，保留单次历史的原始单位。验收：同日/跨日混单位、全lb、全kg、零/缺失工作组、目标单位切换；不把未知重量当0生成比较结论。相同输入在今日与历史页数值/单位一致，切换展示单位不制造进步或PR。 **PM 2026-10-15 23:38 复核至 `3767c92`（修复 `a7595f3`）：整周来源coverage源码/受控handler返工关闭，整项运行待验，不勾选。** 来源新增无limit整周查询与week_summaries；实际handler独立16断言通过，第21条缺组被正确计入；客户端要求coverageComplete及两个计数，执行删除coverage门槛的变异会重现假百分比。legacy未知与已知缺组文案已分开。实际agent取汇总→合法schema保存/回读与匹配今日/历史三视口仍缺精确artifact/version证据，不重复已关闭源码返工。用户插队交付已收到，下一业务实现只修 `H-LOAD-001` 的来源/窗口/coverage与结论边界，不因本项外部运行待验冻结独立工作。
- [ ] `H-SOURCE-001`（P1，源码路径确认，artifact待验）`health-dashboard/server/src/actions.ts:830-834,980-987`：health快照不存在/不合法时，getDashboard提前返回，getSyncDiagnostics也不读取独立strength快照；buildDataStatus(null)把两个来源一起判为缺失。合法力量快照存在但HealthKit首次未同步时，用户看不到已有训练且被提示两边都没数据；自动力量同步同样被health早退挡住。请求 Muse 独立读取与表示两来源，不用伪造健康快照承载训练，按来源显示partial和各自可用操作。验收：仅health、仅strength、两者都有、两者都无、一个payload损坏五种矩阵；损坏/缺失来源不得吞掉另一个可用来源。需说明response兼容、诊断与空态UI，验证已有训练可见。 **交付登记至 `561d1d5`：已收到独立来源读取/UI交付；本轮只核对范围与H-UNITS整合回归，36/36纯函数脚本通过，未完成独立真实handler、schema/action或owner五状态页面验收，不勾选。** 完整复验待该项新运行证据，不能因审查游标前移而视为已通过。
- [ ] `H-WORKOUTS-001`（全部运动记录展示，用户 2026-10-15 提出并拍板登记）现状：健康看板 refresh 已按近 30 天窗口查询全部 HealthKit workout sessions 并存入 `historyWorkouts`（不分类型，含类型/距离/时长/平均心率/消耗），但前端仅按 swim 过滤渲染「游泳记录」，其余类型不可见（用户已确认非游泳运动也应可见；个人运动统计不入仓）；统一时间线亦未合入 HealthKit 运动。要求：(1) 历史页新增「全部运动记录」区，`historyWorkouts` 全部类型按日期倒序展示（类型、距离、时长、平均心率、消耗；缺失字段显示 —，不得猜测填充），原游泳专区与每日游泳距离图保留；(2) 统一时间线按本地日期合入当天 HealthKit 运动（类型、次数或时长），与步数/睡眠/心率/力量并列呈现；(3) 口径不变：运动数据只来自 HealthKit sessions 查询，不从日汇总反推，不与力量快照混合计数，游泳距离日汇总（swimMeters）与 sessions 明细各自来源不混用。验收：真实发布版本复核，近 30 天各类型运动均可见，计数与同一窗口 `health-cli query sessions --category workout` 结果一致；正常/无运动/仅非游泳运动三态与三视口无溢出。 **PM 2026-10-16 20:50 PDT 复核至 `a60b465`：本次P1时长文案源码返工关闭；整项运行待验、不勾选。真实producer→label已明确“已知时长 X 分”，两处时间线均有可见缺失说明；全未知无时长、真实0保留，未改变响应/来源/同步/快照/DB schema/公式/权限。交付34/34、列表20/20与PM独立29项合成断言及Gate通过；这是源码/受控函数结论，不是页面运行验收。最终发布源码对应、同窗sessions对账与owner三态三视口沿用原运行门槛，待新证据再验；原H-UI/P0门槛不变。下一唯一原子实现转既有W-UI-001逐组自动保存及结束前防丢闭环（承接W0.1/W0.2），暂不进入W-TIMER或改负荷公式。**（实现方交付登记 2026-10-16：按 PM 14:51 记录只做第 (1) 项——已在 artifact（space-4）上线并回灌本仓：HistoryView 新增纯函数 allWorkoutsList（副本按 date 倒序、同日 id 升序、不修改原数组），在游泳专区之前新增「全部运动记录」section，全部 historyWorkouts 按日期倒序逐行呈现（日期 + 类型原文；距离 null→—、0→0 米，时长/平均心率/消耗 null→—），空态「近30天没有 HealthKit 运动记录。」；原游泳专区与每日游泳距离图保留。不扩查询窗口/来源/同步/schema，服务端/公式/权限未动；构建审计 pass、非 owner 捕获为拦截页。仓库侧新增 validate-all-workouts.mjs 以真实生产函数跑 20/20 全过：正常混合类型跨类型倒序、同日 id 稳定序、空数组、仅非游泳、缺失字段保留 null、真实 0 保留、输入不被修改，并实际执行升序排序与 swim-only 过滤两项变异均翻转结果；既有回归全过（hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：回灌按同一规格实现并经断言验证功能等价，未逐字核对线上工作树字节；精确 artifact version 平台未提供；计数与 health-cli 同窗对账、第 (2) 项统一时间线合入、owner 三视口页面证据仍未完成/运行待验。待 PM 验收，不勾选。）（实现方交付登记 2026-10-16：第 (2) 项统一时间线合入已在 artifact（space-4）上线并回灌本仓——服务端 unifiedDaySchema 附加 hkWorkouts（按日、按类型原文分组：sessions 条数 + 已知时长之和保留 1 位、全 null 保持 null），buildUnifiedTimeline 只遍历 historyWorkouts 聚合，HK 独占日期也建行且 hasHealth=true，力量型 HK session 只进 hkWorkouts、不计 strengthSessions/strengthVolume、不置 hasStrength；客户端新增纯函数 unifiedHkLabel（空→空串；「运动 N 次 · 类型原文顿号连接」，仅当至少一组时长已知才追加「共 X 分」，真实已知 0 显示共 0 分），DataStatusPanel 与 HistoryView 两处统一时间线行均在力量段后并列呈现；徽章映射、游泳专区/日距离图、Whoop 首屏、H-LOAD、公式/同步/权限/快照与 DB schema 均未动，无 migration。构建审计 pass、非 owner getDashboard 仍 forbidden 零数据。仓库侧新增 validate-unified-hk.mjs 以真实生产函数（服务端 buildUnifiedTimeline + 客户端 unifiedHkLabel）跑 26/26 全过：PM 合成例 Swimming×2（30+null）+Running×1（20）聚合为 [{Running,1,20},{Swimming,2,30}] 且标签「运动 3 次 · Running、Swimming · 共 50 分」、HK 独占日期建行、力量型 HK 不混计、全 null 时长保持 null 且标签不显示时长段、真实 0 显示共 0 分、时长和四舍五入 20.08→20.1、无 HK 日 hkWorkouts=[]、旧 payload 缺字段标签为空，并实际执行三项变异（删 null 时长守卫→假 0、类型排序反转→顺序翻转、标签次数求和破坏→总数变化）均翻转结果；既有回归全过（all-workouts 20/20、hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：回灌按同一规格实现并经真实函数断言验证功能等价，未逐字核对线上工作树字节；精确 artifact version 平台未提供；计数与 health-cli 同窗对账、owner 三视口页面证据仍运行待验。整项待 PM 验收，不勾选。）（实现方交付登记 2026-10-16 19:18 PDT：PM 17:50 P1 时长文案返工已交付——artifact（space-4）先行落地并核对源码：`unifiedHkLabel` 时长段由「共 X 分」改为「已知时长 X 分」，数据状态面板与历史页两处统一时间线各新增可见说明「仅汇总有记录的时长，缺失不按0」；仓库按同一规格回灌 `health-dashboard/client/src/App.tsx`（说明文案作「运动时长说明：仅汇总有记录的时长，缺失不按0。」呈现，功能等价）。类型/次数、全未知不显示时长、真实已知 0 显示「已知时长 0 分」、旧 payload 缺字段降级均不变；不改响应结构、同步/快照/DB schema/公式/权限。仓库侧更新 `validate-unified-hk.mjs` 至 34/34 全过：真实 producer→label 覆盖同类型部分缺失、跨类型部分缺失、全未知、真实 0、全已知、旧字段降级，并断言部分缺失标签不含无条件「共」总时长、两处说明均可见；实际执行四项变异（删 null 时长守卫、类型排序反转、次数求和破坏、文案改回「共」）均翻转结果；既有回归全过（all-workouts 20/20、hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：精确 artifact version 平台未提供；最终发布源码逐字对应、同窗 sessions 计数对账、owner 三视口页面证据仍运行待验。整项待 PM 验收，不勾选。）
- 已重新阅读 `workout-log/server/src/actions.ts:175-344` 与 `client/src/App.tsx:500-573,642-715`。`W0.1/W0.2`（仅完成按钮提交、无保存错误与dirty提醒）、`W0.3`（updateSet无active归属过滤）、`W1.1`（预填/周评两套规则）仍存在；作为旧问题确认，不重复新建。另把startWorkout的先建主行、后取历史/建组且无事务纳入W0.4验收：历史查询/组插入失败后不能遗留空active workout，两个并发start不能生成半成品/重复进行中。

### 用户可见交付批次（逐项交付事实与 PM 反馈分账）

这批按当前单一队列连续推进，全部旧“每仓仅一项”和验收前置限制取消。自检仍严格，PM 复验并行；已交付事实与独立验证覆盖按各条记录，不以旧未勾选状态阻塞后续实现或上线。

- [ ] `W-UI-001`（第一项可见训练体验，承接W0.1/W0.2/W2.2）训练页以“当前动作 → 上次可比表现 → 本组重量/次数 → 保存结果”为主层级；手机顶部保留训练日、进度与时长，当前动作卡展开，其余动作可收起，底部保留结束入口。输入blur/Enter或短debounce即保存，完成勾选只表达完成；每组明确显示未保存/保存中/已保存/失败重试，失败保留输入。结束前等待进行中保存，dirty/error或未完成组需明确确认；不能靠取消勾选再勾选保存。沿用现有真实数据/API，若需要接口改动必须附兼容说明；不在本项改渐进负荷算法。验收：已完成组改数字后直接结束/切页、慢响应倒序返回、保存失败重试、键盘遮挡、390×844/430×932/桌面；所有控件最小44px、状态不只靠颜色。须给匹配视口/合成数据的前后截图和可打开artifact/version。（实现方交付登记 2026-10-16 21:21 PDT：按 PM 20:50 指定只做逐组自动保存与结束前防丢闭环（承接 W0.1/W0.2）——已在 artifact（space-6）上线并回灌本仓 workout-log/client：SetRow 改为纯状态机 SetSaveMachine 驱动（init/edit/begin/applySuccess/applyFailure/adoptServerDraft 纯函数），重量/次数 blur/Enter/800ms debounce 经既有 updateSet 自动保存，完成勾选即时保存；每组文字状态 未保存/保存中…/已保存/保存失败，失败保留输入并提供重试，完成组缺次数显示「先填次数」不保存；每组递增 seq 守卫慢响应倒序，保存成功后又改动回到未保存；刷新仅在已保存（干净）时采纳服务端值；结束训练先 flush 全部组、全保存才结束，失败/受阻弹「返回继续编辑/仍要结束」确认，dirty/saving/error 时 beforeunload 提醒。服务端接口/schema/预填与负荷算法未动，无 migration；回滚 revert 本次提交。仓库侧新增 validate-autosave.mjs 以真实生产函数跑 39/39 全过：dirty↔saved 回退、begin/success、保存中再编辑落 dirty、倒序迟到成功/失败被 seq 守卫忽略、失败保留输入与重试恢复、完成组缺次数受阻、已完成组改数直接自动保存、刷新采纳门槛、四状态文案与未保存聚合，并实际执行三项变异（删 seq 守卫、删采纳守卫、success 强制 saved）均翻转结果；既有 health 回归全过（all-workouts 20/20、hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、unified-hk 34/34、steps-display 全 PASS；steps-contract 仍为既有缺 zod 环境失败、与本轮无关）。如实保留：回灌按同一规格实现并经断言验证功能等价，未逐字核对线上工作树字节（线上状态/重试样式类名与仓库不同名、功能一致）；精确 artifact version 平台未提供；审计环境无进行中训练且非 owner，owner 视角已完成组再编辑后直接结束、慢响应真机时序与 390×844/430×932/桌面三视口页面证据仍运行待验。本项其余视觉范围（卡片重排/顶部层级）未在本轮处理。整项待 PM 验收，不勾选。） **PM 2026-10-16 23:50 PDT 复核至 `d592513`（交付 `f532cf0`）：首次P1源码返工／整项运行待验，不勾选。39项脚本仅纯状态及接线不足以证明实际串行；独立抽真实requestSave/finish已复现迟到旧写覆盖、业务拒绝误标saved、在途回退采纳刷新与结束忽略flush失败，详见本轮记录。下一唯一原子交付仍为此保存至结束闭环，未批准转其他视觉/新功能。**（实现方返工交付登记 2026-10-17 01:22 PDT：按 PM 23:50 三项 P1 只修本闭环——已在 artifact（space-6）上线并回灌本仓，仅 workout-log/client/src/App.tsx：(1) 单写队列：新增导出 drainSetSaves + createSaveQueue，SetRow 的 requestSave/flush 全部经队列——同组同一时刻至多一个 updateSet 在途，并发调用共享同一 drain promise；drain 每笔成功后重读最新 machine，draft 已前进则继续保存最新全量 payload（中间值合并），直到干净/受阻/失败才返回，最终持久化值等于最后输入。(2) 业务结果与在途保护：drain 检查 send 返回的 ok 字段，{ok:false, forbidden:true} 等正常 resolve 的拒绝与抛错同走 applySetSaveFailure（保留输入、error/dirty、可重试）；editSetDraft 改为 inflight 优先——有在途写时 draft 等于 inflightDraft 才 saving、其余一律 dirty（含改回旧 confirmed 值），adopt 守卫与 beforeunload 聚合随之不再误判干净。(3) 结束门：SetSaveHandle 扩展 {flush, getStatus, isBlocked, isCompleted, seal}；新增导出纯函数 finishGateDecision(snapshots)——handleFinish 以 Promise.all 收集同一批 handle 的 flush 布尔结果并构造 snapshots 决策，仅全部 flushOk+saved+未受阻+已完成才直接 complete，reason 优先级 unsaved＞blocked＞incomplete，三种文案分别呈现；「仍要结束」先对全部 handle 调 seal()（清 debounce、drain 不再发新写）再 complete。flushSave 返回须同时满足 drain 成功、saved、未受阻、无在途写。服务端/schema/权限/预填/负荷算法未动，无 migration；回滚 revert 本次提交。仓库侧 validate-autosave.mjs 扩展至 69/69 全过：以真实 drainSetSaves/createSaveQueue/finishGateDecision + 受控 deferred transport 复跑 PM 三反例——多等待者共享单 drain 且写严格串行（maxInFlight=1、payload 序 20→30→40、最终持久化=最后输入 40）、{ok:false} 拒绝返回 false 且 error 保留输入并可重试恢复、抛错同路径、在途回退旧值落 dirty 且刷新不可采纳、回退经补偿保存最终落库（payload 20→100）、legacy 受阻组 flush=false 零写且 finish 不 proceed、结束决策矩阵六例、seal 后不再发写；并实际执行三项变异（删 ok 检查→拒绝被标 saved、editSetDraft 退回 confirmed 优先→在途回退假干净复现、删 blocked 项→受阻批次 proceed）均翻转结果。既有回归全过（rest-timer 40/40、all-workouts 20/20、hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、unified-hk 34/34、steps-display 全 PASS；steps-contract 仍为既有缺 zod 环境失败、与本轮无关）。构建审计 pass（桌面+手机渲染无错误）；审计环境非 owner 且无进行中训练，owner 视角完整保存/结束流程与三视口证据仍运行待验。如实保留：legacy 受阻组因 flush 返回 false 在决策中优先落 unsaved 分支呈现（不静默完成这一门槛满足，blocked 专属文案出现在 flushOk=true 且受阻的组合）；回灌与线上工作树逐字一致（cp 后仅 App.tsx 有差异并已同步，其余 client/server 文件无差异）；精确 artifact version 平台未提供。本项其余视觉范围仍未处理。整项待 PM 验收，不勾选。）
- [完成] `W-TIMER-001`（下一项新功能，承接W2.1）完成组后启动可选休息计时器，默认90秒，可在本次训练设60/90/120秒，支持跳过、+30秒、静音；用截止时间计算剩余而非递减setInterval，切后台回来正确，不妨碍录入、不更改训练完成状态；刷新后恢复策略须明确。状态区放当前动作卡下，不用全屏遮罩。验收：切后台、快速连续完成组、暂停/恢复（若提供）、关闭计时及手机单手操作；无权限不得触发写训练数据。（实现方交付登记 2026-10-16 23:26 PDT：按推荐顺序在 W-UI-001 之后自取本条——已在 artifact（space-6）上线并回灌本仓，仅 workout-log/client：新增导出纯函数计时状态机（RestTimerState + REST_DURATIONS=[60,90,120] + DEFAULT_REST_SEC=90；initRestTimer/startRestTimer/restRemainingSec/restTimerDone/addRestTime/skipRestTimer/setRestDuration/toggleRestMuted/restTimerLabel），剩余时间只由 endsAt 与当前时刻派生（ceil 取整、到点钳 0），300ms tick 仅触发重渲染；SetRow 新增可选 onCompleted 回调——完成勾选由未完成切到已完成且未被 setSaveBlocked（先填次数）阻断时经 ExerciseBlock 透传触发 ActiveWorkout 启动/重启计时，取消完成不触发；RestTimerPanel 渲染于 exercise-stack 之后、finish-zone 之前（endsAt 非 null 才渲染、无遮罩），含 mm:ss 大字/到时「休息结束」、60/90/120 三档（aria-pressed、改档只影响下次启动）、+30 秒（运行中延长、已结束以当前时刻重新锚定、未运行无操作）、跳过、静音开关（aria-pressed），控件 min-height 44px；到时未静音经 WebAudio 播放一次 880Hz 短音；计时状态只存组件内存，面板明示「刷新页面后计时器会重置」，不写服务端/localStorage、不调用任何写 action、不改完成状态。过程如实记录：首轮构建方曾越界把 W-UI-001 的 SetSaveMachine 纯函数实现整体替换为组件内部 ref 实现（仓库 validate-autosave 随即失败），实现方未回灌该版本、已要求构建方纠正恢复——最终线上与回灌版 SetSaveMachine 11 个导出函数与 handle 注册表/flush 门/beforeunload 全部恢复，validate-autosave 在最终树重新 39/39 通过，最终 diff 收敛为 App.tsx +191/−12、theme.css +19/−4（含输入与勾选按钮 43→44px 的触控对齐与未使用 .set-warning 规则删除）。仓库侧新增 validate-rest-timer.mjs 以真实生产函数跑 40/40 全过：默认/非法档位回退、截止时间派生与切后台跳变、到点钳 0、快速连续完成重启、+30 三态、跳过、改档不移动运行中截止、静音不影响截止、标签三态与接线 11 项，并实际执行三项变异（ceil 改 floor、删已结束重锚、删到时文案分支）均翻转结果；既有回归全过（autosave 39/39、all-workouts 20/20、hero-status 20/20、whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、unified-hk 34/34、steps-display 全 PASS）。构建审计两轮均 pass；审计环境非 owner 且沙箱无进行中训练，计时全流程未实机驱动。如实保留：回灌与线上工作树逐字一致（cp 后 diff 仅剩构建产物目录差异）；精确 artifact version 平台未提供；owner 视角切后台/快速连续完成/关闭计时与 390×844/430×932/桌面三视口页面证据仍运行待验。整项待 PM 验收，不勾选。） **PM 2026-10-16 23:50 PDT 复核至 `d592513`：截止时间/跳过/加时纯函数局部通过；整项未验收，仍有既有范围缺口——无本次训练关闭后不再自动启动的设置，面板在全部动作之后而非当前动作卡下方。先完成W-UI保存闭环返工，再按本ID补可选关闭和位置；owner后台/声音/手机运行仍待验，不勾选。**（实现方缺口补齐交付登记 2026-10-17 05:31 PDT：已在 artifact（space-6）上线并回灌本仓——RestTimerState 新增 autoEnabled（默认开），新增纯函数 toggleRestAuto/shouldAutoStartRest，完成组仅在 autoEnabled 时启动/重启计时，关自动不取消进行中倒计时、重开不立即启动；「本次自动休息计时：开/关」开关（44px、aria-pressed、纯本地状态）与 RestTimerPanel 移入当前动作卡（groupSets 顺序第一个未完成动作，组列表与「+ 加一组」之后，经 ExerciseBlock 的 timerSlot 注入、不卸载 SetRow/不注销 handle），全部完成时退回动作列表下方，面板内标注自动计时状态。仓库 validate-rest-timer.mjs 更新至 48/48（接线改按新位置/开关断言，新增 auto 行为 4 项与 toggle 变异 1 项，其余截止时间数学与三变异不变）。如实保留：审计探针无 owner 会话，训练中页面开关/面板位置未现场点击验证，以纯函数实测＋构建类型检查＋代码审查为准；owner 后台/声音/三视口运行证据仍归 EVID-LIFE-001/W-TIMER。此 [完成] 仅表示实现方已交付，PM 结论以评审记录为准。）
- [ ] `H-UI-001`（健康首屏重排，承接H2/L2，避开未验收分析）首屏顺序固定为“数据日期/来源状态 → 恢复参考与置信度/缺失原因 → 一个可行动入口 → 关键指标 → 7天解释趋势”。同步台账和诊断移到可展开详情，避免技术信息占据主内容；今日/上一完整日清楚分区。恢复算法未通过H1时，不包装成确定训练等级，显示依据不足与缺项；不在视觉改版里暗改公式。入口优先打开训练记录或重试缺失来源，用户能一步找到。验收：正常/partial/仅训练/旧数据/失败五种状态的三视口前后截图；值、日期、单位与来源准确，真实发布版本可复核。每周健康复盘H3依照可信数据与算法的依赖推进，不能仅加标题空卡称已实现。（用户 2026-10-15 追加指示：视觉语言向 Whoop 看齐，与本条重排一起做——首屏以恢复 / 睡眠 / 负荷三个大分数为视觉主体（大分数呈现 + 红黄绿状态带，一眼定状态），关键指标、7 天趋势、数据状态、统一时间线依次下沉到分数之下，同步台账与诊断仍放可展开详情；Whoop 的深色底一并采用。不改数据口径与任何公式：恢复分数沿用现有 readiness 参考与置信度/缺失原因呈现，算法未通过 H1 前不包装成确定训练等级；其余验收标准（五种状态三视口截图、值/日期/单位/来源准确）不变。）（用户 2026-10-15 晚追加：**优先插队**，不再排在 P0/P1 条目之后；由 finance side chat 直接在 artifact 实现并回灌本仓，同步队列勿重复开工。）（实现方交付登记 2026-10-15 晚：Whoop 式首屏已在 artifact 上线——深色主题、恢复/睡眠/负荷三分数环 + 红黄绿状态带 + 驱动指标行，原详情面板下沉；构建审计 pass，评审指出的两处缺陷（负荷环比须比上周同期、数据不足时状态带不渲染标记）已修并复审 resolved。服务端评分公式与数据口径未动。owner 视角像素渲染未在审计环境实测，待用户打开确认与 PM 验收；artifact 源码回灌本仓待同步轮次完成。） **PM 2026-10-15 23:38：源码已在 `3767c92` 回灌；实现方build/audit声明不代表验收。睡眠缺失仍显示50分，新0–21负荷把缺项视0并可跨日期拼接；登记本条返工及运行待验，详见本轮记录。保留用户插队方向，先只完成H-LOAD-001原子返工，随后处理本条；两项均不勾选。**（实现方返工交付登记 2026-10-16：按 PM 顺序在 H-LOAD-001 之后处理本条——已在 artifact（space-4）上线并回灌本仓，仅 client/src/App.tsx 的 WhoopHero 呈现层：新增 hasSleepSession（sleep.status 非「数据缺失」且实际睡眠时长 > 0）；sleepScore 无睡眠记录时直接显示 —/数据不足/「昨晚睡眠未记录」，有记录时仅当 lastSleep 或 sleepBank 至少一项 component score 非 null 才采用 radar sleep 分数（两者皆 null 时显示数据不足并注明睡眠信号不足，不再呈现服务端默认 radar=5 的 50 分），history ≥8 晚回退保留且受 hasSleepSession 门槛约束；strainScore 只取 date === dataDate 的 daily 记录（无匹配显示数据不足、注明该日期活动记录缺失，不再回退最后一条跨日期拼接），运动时长/活动能量/步数任一为 null 时显示数据不足并在 detail 点名缺失项，三项齐全（含真实全 0 显示 0.0）才按原 0–21 公式计算；驱动指标行「昨晚睡眠」无记录显示 —；负荷说明文案改为三项齐全才计算的如实口径。服务端 readiness 公式、数据口径、schema、同步路径与权限门禁未动；构建审计 pass，非 owner 直调 getDashboard 仍 forbidden 零数据；新增 validate-whoop-scores.mjs 以真实生产函数跑 19 项断言全过（含三项变异敏感性）。如实保留：回灌以同一规格在仓库实现并经断言验证功能等价，未能逐字核对线上工作树字节（本轮工具约束下未直读 artifact 源码文件）；owner 视角三视口像素证据、五种状态页面证据仍运行待验。本条其余范围（数据日期/来源层级、可行动入口、五态三视口验收）未在本轮处理。待 PM 验收，不勾选。） **PM 2026-10-16 05:45：缺睡眠假50分、活动缺项按0和跨日期拼接的源码返工关闭；未经审定的0–21公式仍作为确定负荷等级展示，原隐藏/降级要求未完成。其余日期/来源/入口和五态三视口未交付；整项返工／运行待验，排在H-LOAD之后，不勾选。** **PM 2026-10-16 08:46 PDT：H-LOAD局部源码返工已关闭，下一唯一原子实现转本条未审定负荷公式降级及对应说明纠正；其他日期/来源/入口随后推进，旧缺失态修复不重做。**（实现方返工交付登记 2026-10-16：按 PM 08:46 记录只做本条未审定负荷公式降级——已在 artifact（space-4）上线并回灌本仓：strainScore 删除 8/7/6 权重 0–21 公式与「负荷较轻/适中/偏高/过高」等级，恒返回中性呈现（pct=null、display「—」、band=slate、bandLabel「评分未确认」），无论同日三项齐全、真实全 0、任一缺失或无当日记录；detail 保留同日活动事实与缺失点名（数据源沿用仓库既有口径：运动时长/活动能量取 dataDate 当日 daily 行、步数取 steps.value，不跨日期拼接）；负荷 ScoreRing 去掉「/ 21」后缀，pct 为 null 时状态带标记不渲染；两处说明纠正——负荷说明改为「负荷评分公式未经审定，不再显示数值与等级，只呈现数据日期当天的运动时长、活动能量与步数事实及缺失原因。恢复与睡眠分沿用现有服务端 readiness/radar 口径，本轮未改任何评分公式」，readiness 近 7 天说明改为「当前接口仅返回单日恢复参考，历史未提供，其余日期为缺口，不复制今日值」。服务端 readiness 公式、数据口径、schema、同步路径与权限门禁未动，H-LOAD-001 判定块文案（负荷偏高结论）未动；构建审计 pass、非 owner 审计 capture 为拦截页与改前一致。仓库侧 validate-whoop-scores.mjs 更新至 22/22 全过：完整/全零/缺项/异日四类输入均中性呈现且事实保留、三项变异敏感性实际执行（删除睡眠门槛、恢复跨日期拼接改变 detail、恢复 scored 返回翻转完整输入）；validate-week-load.mjs 同步更新趋势说明断言字符串后 47/47，其余回归全过（units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：回灌以同一规格在仓库实现并经断言验证功能等价，未逐字核对线上工作树字节（线上 strainScore 的步数取数与仓库既有口径不同源，本轮以仓库既有口径为准、未引入线上变体以免回归已关闭的 H-SOURCE 口径）；精确 artifact version 平台未提供可核对编号；owner 视角三视口像素证据与五种状态页面证据仍运行待验。本条其余范围（数据日期/来源层级、可行动入口、五态三视口验收）未在本轮处理。待 PM 验收，不勾选。）（实现方交付登记 2026-10-16：按推荐顺序自取本条剩余范围的原子项——已在 artifact（space-4）上线并回灌本仓：WhoopHero 顶部新增来源状态条（纯函数 heroSourceStatus）——数据日期行标注「数据日期 {dataDate}（最近完整日）」，恢复参考日期异日另行标注、同日注明同日、缺失注明缺失；Apple 健康/训练记录两行按各自 freshness 与更新时间呈现，dataStatus 缺失时两行均为「来源状态未知」；状态条只给一个主行动：readiness 缺失或健康来源 missing/stale→重新同步健康数据，力量来源 missing/stale→同步训练记录，否则→查看数据状态（滚动至数据状态面板）；未编造训练记录深链（平台无此能力）。仅 client/src/App.tsx 与 theme.css，服务端/公式/口径/同步/权限未动；构建审计 pass、非 owner capture 拦截零数据；仓库侧新增 validate-hero-status.mjs 以真实生产函数跑 12/12 全过（含两项变异敏感性），既有回归全过（whoop-scores 22/22、week-load 47/47 等）。如实保留：回灌按同一规格在仓库实现并经断言验证功能等价，未逐字核对线上工作树字节；精确 artifact version 平台未提供；五种状态三视口页面证据仍运行待验。本条剩余仅五态三视口运行验收。待 PM 验收，不勾选。） **PM 2026-10-16 11:49 PDT复核至 `cde0436`：未审定负荷评分及说明源码返工关闭；日期/来源条与单一入口已接线，但损坏被标未同步、partial缺口未在首层体现，继续局部返工／整项运行待验。下一仅修现有来源信息保真，不扩同步/schema/算法；实现方“仅剩运行验收”不成立，详见本轮记录。**（实现方返工交付登记 2026-10-16：按 PM 11:49 记录只修来源条信息保真——已在 artifact（space-4）上线并回灌本仓：heroSourceStatus 的 sourceLine 在 freshness 为 missing 时直接呈现服务端 row.detail（损坏显示「…快照损坏，等待重新同步」、从未同步显示「尚未同步过…」，detail 为空才回退「尚未同步」），非 missing 保持原格式，dataStatus 为 null 仍「来源状态未知」；HeroSource 新增 coverageLine——snapshot.coverageIncomplete 时在两来源行之后、主行动按钮之前渲染「健康数据覆盖不完整：还没同步完（更新时间新鲜不代表覆盖完整）」，否则不渲染；主行动逻辑、数据日期行标注、服务端/schema/同步/权限/readiness 与 H-LOAD 算法未动，已关闭的负荷降级未重做。构建审计 pass；仓库侧 validate-hero-status.mjs 扩展至 20/20：以真实服务端 freshnessFor 生产行喂入真实 heroSourceStatus，损坏/未同步两来源对照、partial+fresh 时覆盖行可见且行动不变、完整覆盖无覆盖行、四项变异实际执行（删 readiness 门槛、力量抢先、删 detail 直通、删 coverage 门槛均翻转对应案例）；既有回归全过（whoop-scores 22/22、week-load 47/47、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：本轮 invoke 探针在本运行上下文返回了数据（与审计环境非 owner 拦截不同，未记录任何个人数值）；回灌按同一规格实现并经断言验证功能等价，未逐字核对线上工作树字节；精确 artifact version 平台未提供；owner 五态三视口证据仍运行待验。整项剩余仅五态三视口运行验收。待 PM 验收，不勾选。） **PM 2026-10-16 14:51 PDT复核至 `fbd1d09`：来源损坏/从未同步区分及首层coverage缺口源码返工关闭；交付hero20项及独立真实producer→hero24项断言通过。整项运行待验、不勾选，仍须最终实际发布源码映射与owner五态三视口/主入口证据，不能把上下文invoke摘要或同规格回灌当此证据。下一原子实现转既有H-WORKOUTS历史页全部运动列表，详见本轮记录。**
- [ ] `H-LOAD-001`（本周负荷 vs 恢复判定块，用户 2026-10-15 在主聊天拍板，与 `H-UI-001` 同轮一起做）背景：用户问“这周练多了没”时，看板数字齐全但没有一眼结论。要求：(1) 健康看板首屏（H-UI-001 三分数之下）新增判定块：本周训练次数、总时长、力量总容量，对比上周同期（周一至相同星期）环比，箭头 + 百分比；上周同期为 0 或无数据时只显示本周值、不编造百分比。训练次数与时长口径 = 训练记录力量场次 + HealthKit workout sessions；力量容量只来自训练记录，两边不重复计数。(2) 并列 readiness 近 7 天趋势，沿用服务端现有 Readiness 口径与公式，不改算法。(3) 一行文字结论三档：正常 / 偏高 / 该歇了。阈值草案（实现时与 readiness 既有常量对齐，最终值写入 changes）：「该歇了」= readiness 最新 score 落入其既有低档，或 hrvZ ≤ -1 且 restingZ ≤ -0.5，或 sleepDebtHours ≥ 5，或负荷环比 ≥ +40% 且 HRV/RHR 任一恶化；「偏高」= 负荷环比 +20%～+40%，或 hrvZ ≤ -0.5，或 sleepDebtHours 3～5；其余为「正常」。数据不足或周覆盖不完整（沿用 `H-UNITS-001` coverage 规则）时显示数据不足/不完整及原因，不下结论。(4) 数据源：训练数据以训练记录（space-6）为唯一事实源、走现有内部同步通道；健康指标来自现有 HealthKit 快照；不新建第二份数据、不新建同步路径。验收：真实发布版本三视口复核；本周与上周同期数值可由训练记录 week_summaries 与 HealthKit sessions 独立对账；三档结论与数据不足态各构造一例验证。（同 H-UI-001 插队直办，2026-10-15 晚。）（实现方交付登记 2026-10-15 晚：判定块已随 H-UI-001 在 artifact 上线——本周运动时长 vs 上周同期环比、力量次数/容量、睡眠债并列，三档结论（该歇了 / 负荷偏高 / 状态稳定）；负荷环比已按上周相同星期区间比较。待 PM 验收。） **PM 2026-10-15 23:38：`3767c92` 首次源码验收返工，下一唯一在制项。** App.tsx:388-429只汇总HealthKit每日exerciseMinutes，未合并训练/HealthKit sessions次数与时长；无当前周coverage门槛，上一同期少一天仍算百分比，低readiness也可能给可训练结论。必须在既有单一来源/同步链补齐同一截止日期的同期事实与保守降级；缺coverage或计数时先显示不足，不扩评分或同步路径，证据与边界见本轮记录。（实现方返工交付登记 2026-10-16：判定块已按本轮返工要求在 artifact（space-4）重写并上线——同窗双源合并（HealthKit sessions + 训练记录 completed 场次、同日力量型 HK session 去重、容量按场次单位换算）、每日覆盖/coverage/力量完整性五门槛任一不过关即判不足不下结论、低 readiness 低档（score < 2）纳入红档、置信度低不给绿、上周同期为 0 不编造百分比；构建审计 pass、内容评审逐项核对源码 11 项要求全部落地、上线后非 owner 直调 getDashboard 仍 forbidden 零数据。owner 视角像素渲染与三视口、数值与 week_summaries/HealthKit sessions 的独立对账、三档与不足态的仓库侧独立函数断言仍待复核；artifact 源码回灌本仓待后续轮次完成（同 H-UI-001 先例）。待 PM 验收，不勾选。） **PM 2026-10-16 02:40 PDT：收到 `07f38f2` artifact返工登记，但仓库实现/独立构造例未交；仅登记新证据，原返工未关闭、整项运行待验。下一步回灌本次实际发布源码与调用处，补可复跑断言、对账及版本/页面证据；不据build/audit或非owner拒绝勾选，详见本轮记录。**（实现方回灌交付登记 2026-10-16：07f38f2 所述实际发布的 weekLoad 源码与 WhoopHero 消费调用处已回灌本仓——仅 health-dashboard/client/src/App.tsx 变化，与 artifact（space-4）线上工作树逐字一致（sha256 f5a12ea4…a936a0），其余 tracked 文件无差异；新增 validate-week-load.mjs 以真实生产函数跑 36 项断言全过：同窗双源对账、同日 HK 力量去重且同日两次独立力量场次不被抹除、按场次单位换算、上周同期为 0 不编造百分比、三档结论各触发路径、低置信度不给绿、11 类不足门槛、周一边界，并实际执行删除 coverageComplete 门槛与删除低 readiness 门槛两项变异、均证明断言敏感。如实保留缺口：weekLoad 判定块本身未并列 readiness 近 7 天趋势序列（原需求第 (2) 项在已发布实现中仍缺，待 PM 决定后续）；精确 artifact version 平台未提供可核对编号，仅能以源码哈希对应；owner 视角三视口与真实数据对账仍运行待验。待 PM 验收，不勾选。） **PM 2026-10-16 05:45复核至 `8a0c442`：源码回灌及coverage/低分局部返工关闭；同日跨源去重误删独立HK力量场次、页面未消费完整比较指标且缺readiness7天趋势，继续P1返工／运行待验。下一只修本项，详见本轮记录，不勾选。**（实现方返工交付登记 2026-10-16：按 PM 05:45 记录只修本项，已在 artifact（space-4）上线并回灌本仓——(1) 跨源去重改为歧义降级：windowFacts 不再按日期删除 HK 力量 session，全部 HK session 计入次数/时长；任一窗口内某日期同时有已完成力量场次与 type 含 strength 的 HK session 时加入「重复归属未确认：{日期} 同日有训练记录力量场次与 HealthKit 力量记录，现有字段无法证明是否为同一次，不合并、不比较」，sufficient=false、不算百分比、不下结论，insufficient 的 detail 分别保留两边已知事实（力量次数 + HealthKit 次数 + 时长 + 容量）；同日训练记录内部多次独立场次、以及无训练记录重叠日期的 HK 力量 session 照常计数；未加任何附加字段、未动 schema/同步链，旧快照行为变化仅为：此前被静默合并的同日重叠现在显性判不足，回滚 revert 本次提交即恢复旧合并行为。(2) 可见两期三指标三环比：sufficient 的 detail 同时给出本周与上周同期的窗口日期范围、两期次数/时长、上周同期容量与单位，三项环比（次数/时长/容量）全部进入 detail 文本，任一指标上周同期为 0 时该项注明「为 0，不算百分比」；WeekLoad 新增结构化 currentWindow/previousWindow；sufficient 但 readiness 缺失分支同样使用含环比的 detail。(3) readiness 近 7 天趋势（诚实版）：WeekLoad 新增 readinessTrend——以 readiness.date 为末日（无 readiness 时 dataDate 次日）的连续 7 个日期，仅末日项携带 readiness.score、其余六项为 null 缺口，WhoopHero 在负荷 detail 下逐日渲染分数或「—」并注明「服务端只保存最新一天分数，其余日期为缺口，不复制今日值」；服务端只提供最新一天 readiness、无逐日序列，未复制今日值、未另造算法。服务端公式/口径/schema/同步/权限未动；构建审计 pass（两轮，第二轮确认首轮 P1「readiness 缺失分支丢失环比」已修复）、非 owner 审计 capture 为拦截页与改前一致。仓库侧 validate-week-load.mjs 以真实生产函数跑 47 项断言全过：同窗双源对账、PM 合成反例（同日 HK 60 分钟疑似重复 + 90 分钟独立力量均保留并判歧义；独立场次移至无重叠日期照常计数）、两期窗口与三项环比可见性、上周容量与单位、readinessTrend 七日结构与无 readiness 缺口态、单位换算、三档与不足门槛、周一边界，并实际执行删除 coverageComplete 门槛、删除低 readiness 门槛、删除歧义门槛三项变异均证明断言敏感；既有脚本回归全过（whoop-scores 19/19、units 25/25、source 36/36、week-comparison 25/25、week-coverage 23/23、persist-race 42/42、steps-display 全 PASS）。如实保留：精确 artifact version 平台未提供可核对编号；owner 视角三视口像素证据与真实数据同窗对账仍运行待验；readiness 逐日真实序列仍缺（当前为缺口呈现，是否补服务端逐日序列待 PM 决定）。待 PM 验收，不勾选。） **PM 2026-10-16 08:46 PDT复核至 `ab1b016`：跨源歧义保留/降级、两期三指标三环比源码返工关闭；七日仅最新一日有分、其他缺口，允许保留诚实降级但完整逐日趋势未交付，整项运行待验不勾选。暂不新增历史库/另造算法；下一原子实现转H-UI未审定负荷公式降级，详见本轮记录。**

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

- 面向真人的私密读取严格 owner-only；其他读写按授权契约校验，L0.1 已批准的指定无身份内部同步通道除外，不扩大例外。
- 所有页面明确展示数据日期、最后成功同步时间、数据来源和同步状态。
- 失败刷新保留上次成功数据，并明确标为旧数据；不得把失败、缺失或部分同步伪装成 0 或“正常”。
- 核心动作在 390×844 手机视口单手可完成；桌面视口不出现过宽行长或稀疏大空白。
- 每个业务公式至少有一个正常、边界和缺失数据测试；核心 action 至少覆盖成功、失败、重复提交和无权限四条路径。

## 自检质量基线与 PM 复验判据（所有 app，非 PM 上线门控）

### L0 — 隐私与权限（P0）

- [ ] `L0.1` 面向真人的私密读取严格校验 `ctx.viewer?.isOwner === true`；其他读写按各自授权契约校验。所有者已批准 space-4 刷新入口与两个保存回调、space-6 getDashboard 只读入口的无身份内部同步例外，维持现状、风险知情接受，不再因缺可验证服务身份重复驳回或停摆同步。平台提供可验证服务身份时复审迁移；用户可随时撤销，代价为同步停摆、页面明示不可用。此前要求先撤销这些例外的审查意见已被本决定替代，其他权限缺陷仍按 A 类独立入队。
- [完成] `L0.2` 看房报告允许公开读取时，刷新、初始化和 ingest 仍只允许 owner/受信 callback；如果 artifact 被定义为私密，则读写统一 owner-only。（实现方交付 2026-10-17 17:30 PDT：随 HH0.2 同批由构建方在 space-2 附带交付并回灌本仓——报告保持公开读（仅公开挂牌与利率来源数据），但 refresh taskId 改为仅 owner 可见；initializeReport 改为 owner-only；refreshReport 仅接受 owner 或调度平台通道（无 viewer 且 invocationId 为 space-action- 前缀），其余调用在任何状态写入/spawn 前以 forbidden 拒绝；ingestResearch 仅接受 owner 或任务回传通道（space-task-return- 前缀）。实现方探针已实测非 owner 上下文 getReport 正常返回且 taskId 为 null。局限如实记录：space-action-/space-task-return- 通道前缀契约来自构建方对运行时通道的说明，未经一次真实周调度＋研究任务回传的端到端实测；若前缀契约有误，周刷新会在 ingest 被拒并由 HH0.2 stale 恢复兜底（2 小时后可重试），请 PM 在下一次真实周刷新后核对 refresh 状态是否回到 idle。此标记仅表示已交付，PM 结论以评审记录为准。）
- [ ] `L0.3` 无权限响应使用稳定的 typed state，不依赖前端隐藏；直接调用 action 也不能读取 payload 或修改数据。
- [ ] `L0.4` 删除仓库中的真实 HealthKit 明细、真实 workout UUID、设备 ID 和可识别的个人健康样例；首次启动显示诚实空态并引导同步。需要 fixture 时使用独立、明确标为 synthetic 的数据，且生产初始化不会写入 fixture。（2026-10-14 PM 复核至 `205f544`：DATA-PLAN 回灌隐私恢复与步数展示脚本修复局部通过，11:19 两处返工关闭；文档除保留一行同步机制说明外与此前脱敏 `8b87c09` 逐字一致，展示脚本 8/8 通过。无业务/schema/UI 改动。完整契约、受信 owner null/零/旧数字快照保存回读、三视口及原运行要求继续待验，整项不勾选。） **PM 2026-10-15 23:38：`34f216b` 当前changes文档脱敏局部通过，该次新增隐私返工关闭；原个人统计语境整行在当前blob精确匹配0，需求来源/范围保留。未改写历史，未把真实值重标synthetic。窄标识扫描不代替全面隐私或首次启动/owner运行验收；整项仍不勾选。**
- [ ] `L0.5` 日志和错误文案不得包含账户余额、健康数值、训练明细、完整本地路径或上游原始 JSON。

**验证**：对面向真人的私密 action 覆盖 owner、已登录非 owner、未登录三身份，非 owner 不得读写；指定内部同步入口按 L0.1 已批准契约验证，不能要求先撤销例外才能上线。对仓库执行个人数据扫描，不再命中真实健康时序、真实 workout UUID 或固定设备 ID。

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
- [完成] `W0.3` `updateSet`、`addSet`、`completeWorkout`、`discardWorkout` 必须校验目标属于当前 active workout；不存在或已完成目标不能仍返回 `ok: true`。（实现方交付 2026-10-17：服务端新增 `mutationTargetDecision`，四 handler 均先校验 active 并以受影响行数为准，见 changes.md 同日条目；此标记仅表示已交付，PM 结论以评审记录为准。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**
- [完成] `W0.4` 数据库或事务保证同一用户最多一个 active workout；并发 start 不得生成两条进行中训练。（实现方交付 2026-10-17：应用层实现——插入后复查全部 active、更早 active 存在则删除刚插入并让位（`resolveStartConflict`）；结算窗口内瞬时双 active 与数据库级部分唯一索引未做已在 changes.md 如实登记。此标记仅表示已交付，PM 结论以评审记录为准。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**（实现方返工交付登记 2026-10-17 15:13 PDT 轮次：按 PM 15:03 复验沿原 ID 修接管竞态——已在 artifact（space-6）上线并回灌本仓：单 active 仲裁重写为全量再仲裁循环，接管 DELETE 0 行/对方消失/状态中途变化一律重读全体其他 active 再决定；翻 ready 改为单条条件 UPDATE 原子证明无其他 ready 且无更早 initializing，翻转后复核冲突按最早者返回、不删已可见/已编辑/已完成记录。新增 `validate-start.mjs` 66/66（含 PM 两复现调度与变异），既有回归 finish 98/98、progression 57/57、autosave 69/69、d1 35/35、rest-timer 48/48。此登记仅表示已交付，PM 结论以评审记录为准。）
- [完成] `W0.5` 结束训练时：全部完成可直接结束；存在未完成组时显示完成数并二次确认，未填项目保留为未完成，不能伪造为 0。（实现方交付 2026-10-17：由 W-UI-001/W-FINISH-001 结束门实现并在本轮复核——全完成经 finishGateDecision 直接 proceed；未完成组落 incomplete 分支二次确认（finish-zone 常显完成数/剩余组数）；completeWorkout 只写 workouts.completedAt、从不触碰 workout_sets，未填组保持未完成、零伪造，validate-finish 35/35 含 incomplete 决策用例。此标记仅表示已交付，PM 结论以评审记录为准。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**

### W1 — 渐进负荷规则统一（P0）

- [完成] `W1.1` 自动预填与周复盘共用同一套规则和服务端实现，不能一个按最近一次、一个按连续两周却同时声称是“下次建议”。（实现方交付 2026-10-17：服务端与客户端各一份逐行等价的纯函数 `progressionDecision` 成为唯一规则，startWorkout 预填与 WeeklyReview「下次建议」共用同一判定；validate-progression.mjs 以两份真实生产函数跑 14 个用例断言两处结论逐字一致。此标记仅表示已交付，PM 结论以评审记录为准。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**
- [完成] `W1.2` 默认保守规则：目标组全部完成且达到次数上限才建议加重；未完成、低于下限或数据不足时分别给保持、减重/恢复、无建议。（实现方交付 2026-10-17：progressionDecision 四分支即此规则——increase（全完成+全到上限，+5lb/+2.5kg、次数回下限）/ hold（未完成）/ reduce（有组低于下限，−1 步、地板 0）/ none（数据不足）；预填与周复盘文案均按分支生成并注明依据。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**
- [完成] `W1.3` 切换 lb/kg 时可换算最近可比记录并标明“已换算”，不能简单表现为没有历史。（实现方交付 2026-10-17：可比训练改取同 routine 最近一次已完成训练不限单位，异单位按 LB_TO_KG=0.45359237 换算并取整 0.5；新训练带 prefill_unit_converted 标记，预填提示显示「含单位换算」，「上次」标记显示「（已换算）」；构建方以真实 startWorkout 对沙箱数据副本实测 lb 历史开 kg 训练换算预填正确。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**
- [完成] `W1.4` 训练量只计算 completed 且重量、次数都有值的组；自重动作不以 0 训练量冒充可比较负荷。（实现方交付 2026-10-17：客户端 trainingVolume 与服务端 week_summaries 本已按此口径实现，本轮以源码断言锁定；progressionDecision 对全自重（weight 全 null）一律 none、部分无重量组不误判 increase，不以 0 充数。） **PM本轮事后结论见最新增量复验表，交付标记不等于整项已验证。**

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
- [完成] `W4.3-D1`（P1，既有方向细化）训练完成回执：成功后按本次已完成ID读回，展示真实完成/未完成组数、动作级同源对比与既有W1建议，可直达本次记录；加载/失败/缺可比不伪造。queuedAt=2026-10-18T01:07:00Z，Muse目标10-19；原W4.3期限不重置，固定交互/判据见18:07产品推进节。（实现方交付登记 2026-10-17 23 时 PDT：已在 artifact（space-6）上线——completeWorkout 成功后先显示「训练已结束，正在读取记录」，按本次 workoutId 经 getDashboard 附加字段 receipt/receipt_previous 读回已存记录，未知/未完成 id 返回 null、不拿最近一条冒充；读回失败显示可重试「记录暂未读出」，重试只读不重复 complete、不恢复 active。回执展示训练日、实际完成时间、已完成/总组数与未完成组数，每动作与最近一次更早同 routine 同 key 记录的组数与来源日期对比（无则「暂无可比记录」，不补 0、不称进步），下次建议复用 W1 progressionDecision（无可靠输入显示「数据不足」）；「查看本次记录」展开对应历史行，关闭不写数据，回执仅存本会话内存、刷新不恢复且代码注释明示。新字段附加式可选，旧消费者响应不变；门禁未放宽（非 owner 写入口仍 forbidden）。验证：构建两轮成功、审计渲染干净，validate-receipt（artifact 工作区）36/36、validate-start 66/66；审计环境非 owner，「点结束→回执三态」浏览器端到端未实机驱动，以源码接线＋相位纯函数＋服务端实测覆盖。**本轮仓库代码回灌未执行**：artifact 源码访问受工具边界限制，回灌与仓库侧 validate-receipt 复跑留作后续轮次尾巴，不影响线上已交付事实。此标记仅表示已交付，PM 结论以评审记录为准。）

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
- [完成] `F0.2` payload JSON 损坏时返回 typed error 并保留可恢复路径，不能让 `JSON.parse` 直接使整个 action 崩溃。（实现方交付 2026-10-17：已在 artifact（space-3）上线并回灌本仓——新增导出纯函数 `parseDashboardPayload`（try JSON.parse + dashboardSchema.safeParse，绝不抛错、不回显 payload），getDashboard 损坏时返回 data null + refresh.status error + 文案「已保存数据损坏，重新更新可恢复」，ingest 损坏时 previousLiveNetWorth 保持 null 并以本次合法数据覆盖恢复；validate-payload 12/12（含去守卫变异）。构建审计 pass、非 owner 仍 guest_denied 零数据。此标记仅表示已交付，PM 结论以评审记录为准。）
- [完成] `F0.3` 月度文件先按合法真实日期校验、再排序；同一个自然月有多个快照时明确选择月末/最新快照，不能当作多个“月份”画图。（实现方交付 2026-10-17：已在 artifact（space-3）上线并回灌本仓——服务端新增严格真实日历校验（非法日期不滚动、不成为 latestRaw）与单一规范化选择 `normalizeRawMonths`：同月多合法日期只取最新一份快照、同日完全相同去重、同日冲突/非法日期返回只含日期与问题类别的 issue 且保留既有合法看板；所有月图、latestRaw 余额回退、FIRE 与摘要消费同一选择。`validate-monthly-facts.mjs` 50/50、facts-card 82/82、payload 12/12。此标记仅表示已交付，PM 结论以评审记录为准。）
- [完成] `F0.4` 标记当月快照为 partial 或 complete。“本月收入/支出/储蓄率”必须显示截至日期；FIRE 年支出只使用完整且非异常月份。（实现方交付 2026-10-17：与 F0.3 同批交付——完整性为加法式字段（snapshotDate/supersededSnapshots/integrity/integrityBasis/anomalyReason，旧 payload 诚实 unknown、不回填、不丢数据）：当月必 partial，已结束月须有交易全覆盖或月末快照依据才 complete，否则 unknown；新增「月度记录」栏逐月显示「截至日期 · 部分/完整/完整性未提供」文字标签并可展开依据/异常原因；partial/unknown/异常月不进入完整月分母，FIRE 由共享 computeFire 按完整有效月计算（为 0 时显示事实性缺口），F1.1 覆盖按近 3 个完整有效月平均支出、不足时注明缺几月且不输出覆盖。此标记仅表示已交付，PM 结论以评审记录为准。）（实现方 P0 返工交付登记 2026-10-17 19 时 PDT：按 PM 18:07 复现与判据修完整性依据绑定——已结束月 complete 必须同时具备三项依据：所选快照日期恰为月末、交易 coverage 完整覆盖整月、快照 entries 非空，integrityBasis 同时写明两项覆盖依据；仅月末日期、仅交易覆盖、空 entries 任一单独情形一律 unknown、不进 FIRE/F1.1 分母。当月 partial、旧 payload unknown 默认、schema/迁移与消费口径未动。仓库 validate-monthly-facts 更新至 53/53：含 PM 复现一（三份空 entries 月末快照无覆盖→全 unknown、FIRE completeMonthsUsed=0）与复现二（月中快照+完整交易覆盖→unknown）、双依据齐全正常月→complete。已在 artifact（space-3）上线并回灌本仓，构建审计 pass。局限：真实 ingest→保存→getDashboard 端到端与最终上线源码映射仍归 EVID-LIFE-001；本轮以真实生产函数 aggregateMonths/computeFire 断言为据。此登记仅表示返工已交付，PM 结论以其评审记录为准。） **PM 21:00至649b132：两旧复现源码返工关闭，非空余额条目不能证明整月收入/投入的P0余项仍有问题；详最新表，已修分项不重开。**（实现方 P0 返工交付登记 2026-10-17 21 时 PDT：按 PM 21:00 余项与 F0.4/F0.5 设计修来源依据绑定——`aggregateMonths` 新增三个加法式依据 spendProven（月末快照+交易全覆盖）/incomeProven（再含 income 条目）/contributionProven（再含 investment_contribution/transfer 条目），integrity=complete 改为三依据齐全，unknown 的 integrityBasis 写明缺哪几项；余额-only 月不再进 FIRE 分母。客户端 `completeSpendBasis`（F1.1）改只认 spendProven；月度记录展开新增逐指标依据行，收入/投入无依据显示「未提供」；储蓄率在依据未齐时注明非完整月口径。仓库 validate-monthly-facts 57/57（含 PM 21:00 余额-only 复现）、validate-facts-card 84/84、payload 12/12、color-vision 16/16，变异敏感性双向实测翻转。已在 artifact（space-3）上线并回灌本仓，构建审计 pass。F0.5 本体（逐源 coverage/最后成功时间）未在本批实现、保持未勾选，本批仅落其指标依据首片。局限：真实端到端与上线源码映射仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P0 余项返工交付登记 2026-10-18 05 时 PDT：按 PM 00:08/03:10 沿原 ID 的旧存档判据修复——已在 artifact（space-3）上线并随本轮财务批次整批回灌本仓：新增导出纯函数 `normalizeStoredIntegrity` 并接入 `normalizeFireMetrics`（getDashboard 唯一读路径）——integrity="complete" 但 spendProven/incomeProven/contributionProven 任一不为 true 的旧存档月份降级为 unknown，integrityBasis 逐项点名所缺依据，数值/日期/异常标记原样保留；`validCompleteMonths` 同步增加三依据守卫，FIRE 服务端与客户端 completeSpendBasis 对同一旧存档结论一致。与 F0.6 读路径规范化共存（null 保持 null+异常、recorded 负数保留、estimated 负数 clamp 不回归）。仓库副本 validate-monthly-facts 71/71（含旧存档三依据全缺→降级且 FIRE completeMonthsUsed=0、只缺一项、齐全保持、partial/unknown 不改标、变更检测 2 项）、validate-cashflow 60/60 及其余套件全过，构建审计 pass（audits/2026-10-18T12-36-05Z）。局限：真实 owner 旧存档端到端与最终部署源码映射仍归 EVID-LIFE-001，未向生产库写探针。此登记仅表示返工已交付，PM 结论以其评审记录为准。） **PM 06:12至c5cf74c：旧writer→升级getter的原blob反例源码关闭，3月均unknown/FIRE与支出依据0、存储字节未变；A运行补证仍EVID，详最新表。**
- [ ] `F0.5` Firance、Plaid account、holdings、transactions 分别记录 coverage 和最后成功时间；交易失败不阻断余额刷新，但支出推断必须明确降级。
- [ ] `F0.7` / P0 / A 类 / Muse / 用户直提（2026-10-18 所有者实测）：周刷新挂死、近月快照缺失。所有者晨间实测：月度记录止于 2026-09-20 月中快照，7/8 月为模板沿用值（收入 [已脱敏]、未核实），10 月无记录；9 月看板收入记 [已脱敏]，银行实收对账为 [已脱敏]（[已脱敏]），少记 [已脱敏]。今晨 08:39 PT 周刷新状态停在 running、心跳（refresh.updatedAt）37 分钟未更新、两次读取数据逐字未变，与 2026-09-20 以来冻住同型。要求：(1) running 须有 stale 判定与可重试结算，失败在页面明示，不得静默停在 running；(2) 刷新成功必须带来完整 9 月记录（收入与银行实收对账一致）与 10 月进行中记录，缺失来源与 `F0.5` 共用台账点名，不另建；(3) 不回写、不伪造历史快照，补全只走真实源。固定验证：伪造超时 running 行可判 stale 并重新刷新；失败路径页面可见；9 月收入对账判据 [已脱敏]（合成环境以同构合成数替换）。（登记：finance side chat 2026-10-18 09 时 PDT，所有者发现并要求登记。）（实现方进展登记 2026-10-18 10 时 PDT：本轮已线上实查——看板数据仍冻在 asOf 2026-09-20、今晨 08:39 PT 周刷新状态 running、updatedAt 冻在启动时刻，至 10:10 PT 已 91 分钟无回调，与所有者晨间所见同型；此时未达现行 2 小时 stale 阈值，refreshFinanceData 返回 already_running 属现行规则内响应，stale 结算最早 11:39 PT 后才开启。本条顺延下一轮继续，原因：重试与 9 月对账依赖 stale 窗口开启后的一次完整真实刷新及其回调结果，属单项时间依赖；下一轮先判 stale 结算与页面明示是否生效，再触发刷新并按 [已脱敏] 判据核 9 月收入与 10 月进行中记录，缺失来源与 F0.5 共用台账点名。此登记仅为进展记录，不代表已交付。）

### F1 — 指标语义（P0）

- [ ] `F1.1` 应急金覆盖使用可配置的“可动用存款 ÷ 近 3 个有效完整月平均支出”，不使用可能 partial/异常的单月支出。
- [完成] `F1.2` 周变化拆成“本次余额差”，不要暗示已能准确归因为市场、投入或消费；只有来源足够时才增加归因。（实现方交付 2026-10-17：与 `F2.1-D1` 同一事实卡合并交付，见 F2 节 `F2.1-D1` 交付注与 changes.md 同日条目；净资产区标签已改「较上次成功快照」，卡片不称固定一周、不归因。此标记仅表示已交付，PM 结论以评审记录为准。）（实现方返工交付登记 2026-10-17：按 PM 15:03 复验沿 `F2.1-D1` 原 ID 修来源统计——已在 artifact（space-3）上线并回灌本仓：`balanceSourceSummary` 只统计与净资产相同的余额组成（account/investment），收入/支出/转账/投入不再计作账户；无余额来源显示「未提供」，措辞改「同步读取值/沿用月度快照值」不再声称本周实时；以真实 buildDashboard→首卡链验证，`validate-facts-card.mjs` 更新至 82/82。此登记仅表示已交付，PM 结论以评审记录为准。）
- [ ] `F1.3` FIRE 达标年限明确标为“不含投资回报的线性估算”；P1 可提供保守/中性两种可编辑假设，但默认不承诺收益率。
- [ ] `F1.4` 贷款以正数未偿余额展示，但净资产计算仍按负债扣减；所有卡片和账户行保持同一符号语义。
- [ ] `F1.5` 数据异常月说明触发原因（交易未覆盖、推断为负、来源缺失等），用户能判断是数据问题还是实际异常。

### F2 — 每周决策摘要（P1）

- [ ] `F2.1` 顶部增加最多三条摘要：净资产变化、现金覆盖变化、当月支出进度；每条都带比较区间和来源完整度。
- [ ] `F2.2` 只做事实型提醒（数据过期、集中度、现金覆盖、负债变化），不生成买卖建议。
- [ ] `F2.3` 持仓集中度分母、现金头寸是否计入、Top 10 截断方式在详情中可见。

### 2026-10-18 用户直提：Life ↔ Firance 双向借鉴（财务）

来源：所有者明确要求「Life 好的由 Codex 改本地 firance；firance 好的由 Codex 提需求让 Muse 实现」。本批比较 Life `d339b14` 与本地 Firance 现有源码，范围仅每周财务总览。Life 的日期/来源提示、现金覆盖、负债展示与色弱冗余通道由 Codex 移植到本地；下列反向需求由 Muse 实现。不是要求搬整个 Electron、交易/回测系统，也不改健康/训练重点。需求入队时间 2026-10-18；所有数值示例均为 **synthetic**。

- [完成] **`F0.6` / P0 / A 类 / Muse / 目标 2026-10-18：与现行 Firance 对齐现金流核对和输入兼容。**（实现方交付登记 2026-10-18：已由 finance side chat 派 builder 在 artifact（space-3）上线，同步轮次本轮完成源码回灌本仓并独立复跑——仓库副本 validate-cashflow 60/60、validate-monthly-facts 71/71（含 F0.4 旧存档归一化），既有套件无回归；构建审计 pass。局限：审计沙箱为访客视角，handler 端到端与 owner 视图未在沙箱实测，真实数据确认点为 2026-10-18 08:39 PT 周刷新、尚未发生；端到端运行证据仍归 EVID-LIFE-001。此 [完成] 仅表示已交付，PM 结论以评审记录为准。） 对应本地 `src/utils/cashflow.js`、`monthlyRecords.js`、`monthlyData.js` 及 `docs/money-cashflow.md`。Life 当前 `weekly-finance/server/src/actions.ts` 的 `sourceEntrySchema` 仅接六类字段，`contribution()` 用 `investmentContribution || transfer`，`aggregateMonths()` 用全部 account 余额变化反推消费。已明确的源码问题：标准投入 0 被旧别名非零覆盖；房贷本金/HSA/债券变化混入消费；新 `flexible_spend` 等字段被拒绝/丢弃。（接单登记 2026-10-18：所有者经 Codex 转交授权，finance side chat 已直接派 builder 实现中，同步轮次勿重复接单；交付后在本条补登记。） **PM 06:12至c5cf74c：公式/输入兼容分项已验证；双端日期/核实/分类原P0余项有问题，Muse10-18，详最新bug单。**（实现方 P0 返工交付登记 2026-10-18 07 时 PDT：按 PM 06:12 bug 单 1 修双端绑定——已在 artifact（space-3）上线并回灌本仓：现金流反推资格同时检查期初/期末各自真实 balanceDate、任一端 verified===false 即不合格、同名账户 source+role 一致性；不合格保留余额事实、flexibleSpend=null 并在 cashflowNote 点名具体端点/分类/核实缺口。仓库副本（与线上逐字一致）validate-cashflow 扩至 71/71：期初/期末旧日期、双端未核实、role 改变、缺月/改名、正常双端合格仍 400、实录 0/退款优先、旧 payload 降级，原分类/贷款/HSA 矩阵不回归；构建审计 pass（audits/2026-10-18T14-26-17Z）。局限：handler 端到端与 owner 视图仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P0 返工交付登记 2026-10-18 11 时 PDT：按 PM 09:08 反馈 1 与 09:10 bug 单 1 修双端精确日期与原生未核实状态——已在 artifact（space-3）上线并回灌本仓：新增 normalizeBalanceDate 精确比对（YYYY-MM 与月末等价；同月旧日、未来日、非法日在期初/期末任一端均使反推 null 并点名端点、账户与日期，余额事实不改写），entryUnverified 统一消费 verified===false 与 status=unverified/carried_forward_unverified；刷新提示词要求原生三键原样进 extra、status 原样返回。仓库 validate-cashflow 扩至 83/83（含 PM 全部日期/状态反例与正常 400、YYYY-MM 等价对照），全套八组 461 项通过；构建审计 pass（audits/2026-10-18T18-07-44Z，含线上 getDashboard 只读实调）。局限：真实 ingest 端到端与 owner 视图仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）
  - 加法兼容现有来源记录：`flexible_spend`、`cashflow_adjustment`、`investment_external_adjustment`；`cashflow_role`（cash/credit/debt/non_cash）、`balance_date`、`status`、投入期间与核实元数据。读取器保留扩展字段，按键解析，不继续假定每条恰好三行；原始来源只读，不回写、不给历史自动补核实标记。兼容既有 YYYY-MM（月末估值）与 YYYY-MM-DD；首日估值边界与同月多快照选择必须说明并测试，不能把文件名直接当交易 coverage。
  - 标准投入按字段是否存在选择；显式 0 不回退，别名与标准匹配不相加，冲突降级。实录 Flexible Spend 优先、保留真 0 与净退款；无实录时仅稳定、连续、同分类、同日期口径且收支齐全的现金+信用卡净余额可反推：收入 + 其他净现金流 − 投资现金净转入 − 固定支出 − 现金/信用卡净余额变化。贷款本金和非现金估值排除。缺月、旧余额、范围变化、无效金额、负反推均保留原因和差额，支出为 null，不能 clamp 成 0 或拿余额日期证明完整交易。
  - UI 沿用 F1.5 的核对入口，区分「已记录 / 估算 / 待核对」，展开显示区间、式子、问题与来源；不是再加首屏解释墙。F0.4/F0.5 按指标判断证据，实录不自动代表完整月，不以宽松标记绕过原完整性要求。复用原 ID 的旧存档归一化余项、不要冒充已关闭。
  - **固定验证**：合成现金 1000→1200、贷款 -10000→-9500、收入1000/固定300/投入100，旧全账户式给 -100，正确现金式给400；显式投入0+旧Transfer100不得回退；实录0/净退款；信用卡还款/内部转账；HSA变化；缺月/改名/沿用/坏金额；扩展字段 ingest→保存→读取兼容及旧 payload；图表缺失断点、FIRE 分母与来源依据不被空/部分数据填充。参考本地 `tests/cashflow.test.mjs`，迁移到真实生产函数，不仅写平行示例。

- [完成] **`F1.6` / P0 / A 类 / Muse / 目标 2026-10-19：投资收益与净投入独立核对。**（接单登记 2026-10-18：前置依赖 `F0.6` 字段兼容已上线，finance side chat 已直接派 builder 实现中，同步轮次勿重复接单；交付后在本条补登记。）（实现方交付登记 2026-10-18：已由 finance side chat 派 builder 在 artifact（space-3）上线，同步轮次本轮完成源码回灌本仓并独立复跑——仓库副本 validate-investment-performance 35/35，既有套件无回归；构建审计 pass。局限同 F0.6 登记：沙箱访客视角、真实数据确认点为 2026-10-18 08:39 PT 周刷新、尚未发生；端到端运行证据仍归 EVID-LIFE-001。此 [完成] 仅表示已交付，PM 结论以评审记录为准。） 对应本地 `src/utils/investmentPerformance.js`、`components/InvestmentPerformance.jsx`、`docs/investment-performance.md`。Life 当前 `aggregateMonths()` 直接「投资余额差 − 本期投入」，未验证整个区间、账户范围、非银行直接投入，容易把 RSU/雇主缴款当收益。新增期间收益 = 期末全部投资账户余额 − 期初同范围余额 − **整个期间外部净投入**（现金净转入 + 非银行直接投入；提现为负）；组合内买卖/券商互转/留存股息不重复记投入；持仓明细不替代或叠加全部投资账户余额。 **PM 06:12至c5cf74c：现金/非银行投入与负收益分项已验证；期初/期间覆盖及FIRE投资边界原P0余项有问题，Muse10-19，详最新bug单。**（实现方 P0 返工交付登记 2026-10-18 07 时 PDT：按 PM 06:12 bug 单 2 与期间核对卡需求同批交付——已在 artifact（space-3）上线并回灌本仓：期间收益校验双端投资余额真实日期/核实、实际区间起讫与投入/非银行投入 periodStart/periodEnd 对实际区间的完整覆盖，不匹配/未核实/未覆盖则该段收益 null 并就近说明、整段累计在该段中断；computeFire 改以 live.investment 为本金（与收益卡同一投资边界），净资产事实卡不变；收益卡首行显示真实起讫与已核对/待核对、第二层三项事实、展开复用 entryMeta 逐行呈双端日期/核实与投入期间覆盖、部分记录投入标「部分记录、未参与收益」。仓库副本 validate-investment-performance 扩至 55/55（PM 四反例、正常 5000/含 RSU、0/提现/负收益、首期/缺流/冲突/跨月/范围变化、旧存档、累计断点、HSA/负债不影响投资本金），monthly-facts 73/73，构建审计 pass。局限：端到端运行证据仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P0 返工交付登记 2026-10-18 11 时 PDT：按 PM 09:08 反馈 2 与 09:10 bug 单 2 及逐区间核对推进同批交付——已在 artifact（space-3）上线并回灌本仓：原生 investment_period_start/end、investment_flow_verified 逐字提升至 entryMeta 新字段 nativePeriodStart/nativePeriodEnd/nativeFlowVerified 并与通用字段交叉核对（冲突/原生 false 降级）；投资双端余额日期精确匹配、status 未核实消费；期间覆盖按现金投入与非银行直接投入两渠道分别绑定（覆盖须在本区间内、跨出整笔不计、他渠道不补缺、带核实标记但无期间降级，含同日窄修复 audits/2026-10-18T18-24-53Z 复核 3/3）；流量证明失败月份 investmentNetFlow=null、任一区间未核实时整个期间 netFlow=null；期间核对卡改为逐段呈现（每段双渠道已记录金额、本段可用净投入、收益/原因；覆盖标签按条目所属区间判定、原生期间与原生核实状态同显）。仓库 validate-investment-performance 扩至 67/67（含原生字段、跨渠道拼接、超区间金额、显式 verified 无期间、全期间 netFlow 归零等 PM 反例），全套 461 项通过。局限：真实端到端仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）
  - 区间/完整性未核实、账户范围变化、沿用未核实余额、缺投入时收益 null 并说明；首期是起点不是收益；跨月缺口按整个区间展示，不叫单月收益，不参与整月投入年化；负收益/净提现保留符号。FIRE 本金与卡片采用同一明确的投资账户边界，不能静默切成含房贷/非现金的净资产。原「净资产较上次余额差」事实卡不改成市场归因。
  - 收益金额先实现；如给收益率，采用同一已公开公式和真实日期权重，日期缺失明确期中投入估算，分母非正/日期无效时不算百分比，不冒称真实 TWR。连续累计遇待核对区间中断，不跨缺口补0。
  - **固定验证**：投资100000→115000、完整期间现金投入10000→收益5000；另有非银行投入3000→收益2000；提现/负收益；首期/显式0/缺投入/未核实/标准别名冲突；跨两月期间覆盖；投资账户增删/沿用；持仓明细只覆盖一部分且含券商现金；旧 payload 加法兼容；端到端保存回读与页面金额/标签。引用本地 `tests/investmentPerformance.test.mjs`。

- [完成] **沿 `F1.1` 实质补充 / P1 / A 类 / Muse / 目标 2026-10-20：应急金只算可动用现金。**（接单登记 2026-10-18：F0.6、F1.6 已上线，finance side chat 已直接派 builder 实现中，同步轮次勿重复接单；交付后在本条补登记。）（实现方交付登记 2026-10-18：已由 finance side chat 派 builder 在 artifact（space-3）上线，同步轮次本轮完成源码回灌本仓并独立复跑——仓库副本 validate-available-cash 45/45，既有套件无回归；构建审计 pass，构建中审计挑出的试算陈旧提示 P2 已当轮修复。局限同 F0.6 登记。此 [完成] 仅表示已交付，PM 结论以评审记录为准。） 借鉴 Firance 的 `getCashflowRole()` 和现金流核对（Codex 本批再补账户勾选）：HSA/债券/退休资产不因余额为正就算存款，信用卡/房贷不混入可用现金；owner 可选择纳入的现金账户，明确是否仅本页试算。分母仍沿原三有效完整月要求，显示所用月份与估算数；现金陈旧/缺失、样本不足、支出非正时不造覆盖数。验算分类覆盖、排除全部账户、真0/缺失、单位与日期、原始余额未被改写。与 F0.5 的逐源日期/coverage 共用，不建第二套来源台账。 **PM 06:12至c5cf74c：分类/试算分项已验证；未核实现金参与覆盖P1/A有问题，Muse10-20，详最新bug单。**（实现方 P1 返工交付登记 2026-10-18 07 时 PDT：按 PM 06:12 bug 单 3 修复——已在 artifact（space-3）上线并回灌本仓：entryMeta 的 verified 与真实 balanceDate 透传到 accounts summary（新增 availableCashUnverified 名单）与 live 可动用现金计算及本页试算，verified===false 现金作事实显示但不计入覆盖分子、覆盖 null 并给就近原因；日期判断用真实 balanceDate（不再 .slice(0,7) 月份比较、不用刷新 asOf 替代），同月较旧日期如实提示；排除未核实项后试算可恢复，来源余额数值不改写。仓库副本 validate-available-cash 扩至 59/59：已核实/明确未核实/legacy 未知、当前/跨月/同月较旧、排除恢复、全部排除、真 0、缺账户、样本不足、金额不改写；构建审计 pass。局限同 F0.6 登记。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P1 返工交付登记 2026-10-18 11 时 PDT：按 PM 09:10 bug 单 3 修旧存档读路径——已在 artifact（space-3）上线并回灌本仓：账户行新增 status 字段随行携带；ensureAvailableCash 在读路径用最新月份 entryMeta 按 financeSource 补齐旧账户行缺失的 verified/status/balanceDate（只补已保留的显式值），旧 writer 存档中 entryMeta 已保留的 verified=false / carried_forward_unverified 不刷新也使可动用现金为 null 并点名未核实；summarizeAvailableCash 陈旧判定改为余额日期与快照日期精确相等（未来日同为缺口）。仓库 validate-available-cash 扩至 62/62（含旧 blob 补齐、原生 status、未来日期反例），全套 461 项通过。局限：真实 owner 旧存档端到端仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）

- [完成] **沿 `F2.3` 产品推进 / P1 / A（聚合）+B（呈现） / Muse / 目标 2026-10-21：从 Top10 展示走向全部持仓可查。**（接单登记 2026-10-18：F0.6、F1.6、沿 F1.1 均已上线，finance side chat 已直接派 builder 实现中，同步轮次勿重复接单；交付后在本条补登记。）（实现方交付登记 2026-10-18：已由 finance side chat 派 builder 在 artifact（space-3）上线，同步轮次本轮完成源码回灌本仓并独立复跑——仓库副本 validate-holdings 51/51，既有套件无回归；构建审计 pass。局限同 F0.6 登记。此 [完成] 仅表示已交付，PM 结论以评审记录为准。） 借鉴本地 `src/utils/portfolioAnalysis.js`、`views/Portfolio.jsx`：首页仍保留 Top10 摘要，提供只读「查看全部持仓」展开/搜索；同 ticker 合并、全部有效非现金正市值为集中度分母，现金类单列，Top10 之外的长尾不丢；缺失/负头寸/币种不明单列待核对，不能默认为美元正持仓。详情显示账户覆盖、日期与分母，重复基金方向只作可解释事实提醒，不输出买卖推荐、不代下单、不搬回测或预测系统。若现有 bounded payload 仅存 Top10，须先保留有上限的全量规范化集合再截断展示，旧缓存无全量时明确不可恢复长尾、等待下次合法刷新，禁止用 Top10 重算全仓分母。固定验证：11+标的长尾、跨账户重复ticker、多类现金、缺价格/负头寸/币种缺失、0/无持仓、旧Top10缓存，搜索不改变分母；账户投资余额与持仓不叠加。 **PM 06:12至c5cf74c：全量/固定分母/搜索分项已验证；现金币种冲突P1/A有问题，Muse10-21，机构文案P2/B，详最新bug单。**（实现方 P1 返工交付登记 2026-10-18 07 时 PDT：按 PM 06:12 bug 单 4 修复——已在 artifact（space-3）上线并回灌本仓：normalizeHoldings 现金 ticker 声明币种与显式 currency 矛盾时列待核对、保留原记录、不计美元现金合计、不隐式换汇；一致才汇总，缺 currency 时 ticker 可证明按 ticker、不可证明列待核对并分别说明；附 P2/B：HoldingsSection 机构计数措辞改称机构、不编账户数。仓库副本 validate-holdings 扩至 61/61：USD 一致、非 USD 一致、冲突、缺 currency 可证明/不可证明、0/负/缺值、跨机构多现金，原长尾/固定分母/搜索不变；构建审计 pass。局限同 F0.6 登记。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P1 返工交付登记 2026-10-18 11 时 PDT：按 PM 09:10 bug 单 4 修旧存档读路径——已在 artifact（space-3）上线并回灌本仓：ensureHoldingsConsistency 在读路径校验已存 holdingsCash 的币种冲突（代码声明与 currency 字段不一致）并移入 holdingsUnclassified 注明冲突，cashPosition 按保留现金行重算（无保留 USD 行为 null）；无 holdingsCash 的旧存档保持原 CUR:USD 折叠，份额与集中度不重算。仓库 validate-holdings 扩至 63/63（含旧 blob 冲突隔离、混合保留行反例），全套 461 项通过。局限：真实 owner 旧存档端到端仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）

本批交接：新增需求2项（F0.6/F1.6），推进既有方向2项（F1.1/F2.3）；Life 本轮用户可见实现增量 **0**，尚未声明 Muse 已交付/上线。队列等待中位数未计算，旧条目缺 queuedAt/startedAt；新条目自本日入队计时。Muse 按既有优先级与真实技术依赖连续实现，P0＞用户直提＞其他；F0.6 的字段兼容是 F1.6 的技术依赖，其他独立工作继续。保留既有健康/训练截止日期、P0与已关闭分项，不因本批重置或重复立项。每项首次自检证据已一次列齐：合成数据/真实生产函数与 handler 保存回读、schema/migration旧版兼容、builder plan→build→audit→submit及源码回灌、changes记录命令结果/局限/回滚。实现不等PM复验；不使用本地 build 或 app.db，不索要例行 owner 截图批准，不打印真实财务数据。

### 2026-10-18 09:08 PDT · 每日 Life × Firance 增量反馈（独立于三小时 PM 任务）

比较游标：首次任务基线 `eb9be7ed48dd30ae26326ac8499ebbcbff48d5e8` → 本轮交付 `e50d938b42dfce4c2b154270419982a2ff154a80`（含 `c5cf74c`）。只维护本节相关需求反馈，不移动三小时 PM 审查游标，不改 Life 业务代码、changes、数据库或 artifact。

- **交付事实分账。** F0.6/F1.6/沿F1.1/沿F2.3 已入队且已有 finance side chat 接单登记；c5cf74c 回灌首批，e50d938 回灌四返工及期间核对卡。Muse 报告 space-3 经 builder 构建审计并提交上线、9 文件与最终源码一致；本任务未独立访问 builder/部署工件或 owner 页面，故“实现已交付”可由仓库核对，“工件已提交生效”为 Muse 申报，所有者新确认 **0**。不把旧“尚未发生周刷新”记录推断为当前已成功刷新，不读取真实记录验证。
- **复核与产品推进。** 实际读取新 server/client 调用链，独立复跑最新四组 synthetic 回归：cashflow 71/71、investment-performance 55/55、available-cash 59/59、holdings 61/61；Handoff Gate c5cf74c→e50d938 通过（11 files/6 scripts/9 implementation）。F1.1 明确未核实现金隔离及F2.3现金币种冲突分项在源码/原矩阵范围已验证，运行材料仍沿EVID-LIFE-001；不重开已修分项、不重复原判据。Life 新期间核对卡的双端日期/投入覆盖明细已借鉴到本地 Firance，只读展开，缺元数据明确未知；本地同时修复同月旧余额仍参与现金流估算的问题。以下是**新实际反例**，沿原ID、原负责人和原截止日期继续，不新增同义编号。

1. **沿 F0.6 · P0/A · Muse · 原目标 2026-10-18不变：双端日期必须匹配实际估值日，并消费原生未核实状态。** e50d938 `aggregateMonths.endpointIssues` 仍用 `balanceDate.slice(0,7) < snapshotKey.slice(0,7)`；只拦更早月份。同月旧日/未来日/非法日均能通过。**合成复现**：2099-08-31现金1000→09-30现金1200，收入1000/固定300/投资现金投入100；把任一端balanceDate分别设08-01或09-01，实际仍flexibleSpend=400（应null）；期末10-01或09-31也仍400。对照：正常双端400、期初07-31正确null，原已修分项不重开。现行 Firance 修复以YYYY-MM规范为月末后精确比对双端日期，保留余额事实、实录0/净退款优先。
   - **具体范围与固定判据（本次一次列齐）**：两端分别覆盖同月旧日、未来日、无效日、相符日；YYYY-MM与该月末等价，显式日保留实际日，缺日期不伪造已核实；旧status=unverified/carried_forward_unverified在读取/保存回读/估算消费者中不能只因verified缺省绕过（与下项共用原生字段映射）；任一不可信端使反推null并说明具体端点，余额不改写，实录0/退款、贷款/非现金排除、正常400不回归。补真实函数和合法handler保存回读的synthetic反例，按现有builder流程交付，不本地build、不触碰源账本。
2. **沿 F1.6（含 F0.6 输入兼容）· P0/A · Muse · 原目标 2026-10-19不变：打通现行 Firance 原生投入核实字段，并精确绑定投资双端估值日。** 现行本地读写器实际使用 `investment_period_start` / `investment_period_end` / `investment_flow_verified`，投资余额使用 `status=carried_forward_unverified`；Life刷新提示仅提升通用period_start/end/verified，其余放extra；aggregateMonths.entryMeta未保存extra，recomputeInvestmentReturns只检查通用verified===false，且periods.length=0走legacy旁路。**合成独立反例**：投资100000→115000、投入10000，把 `extra.investment_flow_verified=false`（即现有提示会生成的输入）单独传入，实际仍收益5000；把原生期间仅覆盖至09-15、flag=true也仍5000；单独把任一端status设carried_forward_unverified亦仍5000。预期这些区间收益null并点名缺口、累计中断。通用verified=false与通用短期间目前正确null，是已修对照。投资balanceDate同月旧日、未来日或非法日仍收益5000，与F0.6同一日期漏洞；已核对正常期间仍5000。
   - **具体范围与固定判据（本次一次列齐）**：从现行Firance序列化合成记录→提示字段映射→SourceEntry→entryMeta→保存/读取→收益与页面逐层证明三项原生投入字段不丢失、不重写；原生false/缺确认/期间不符不得伪装legacy已核对，余额未核实状态不得被缺省或矛盾通用true覆盖。原生与通用字段同时出现冲突须null+原因，不猜优先级或回写历史。双端balanceDate按实际日精确匹配（含YYYY-MM月末等价）；期间规范化后覆盖整个实际区间，不自动补确认。保留显式0、提现、负收益、RSU/雇主投入、别名不双计、首期与跨期缺口、旧payload可读且未知诚实降级；期间不合格累计中断、整月投入年化不采用未核实项。沿原F1.6/F0.6自检/旧版兼容/保存回读/匹配页面与builder plan→build→audit→submit判据，不另设PM批准。

本轮新增独立真实函数synthetic控制 **19/19**（含上述缺陷复现与已修/正常对照，TypeScript AST抽取生产函数执行；不是SDK/schema/action/artifact成功声明）。不把原55项全过当作新边界已覆盖。Life本任务业务实现增量0、Firance实现增量2；全队列中位等待缺queuedAt/startedAt不可计算，不用Git时间代替。原健康/训练重点、10-18/19/20/21期限与L0.1所有者例外不变。交接采用Muse会读取的远端plans队列；本会话没有Muse builder/即时消息通道，原生UI因Mac锁屏不可访问，**尚未即时通知或取得本次新余项接单确认**，不冒称已发。

### F-UI — 呈现与可访问性（P1）

- [完成] `F-UI-001` 色弱冗余通道规则传播至财务总览（用户直提，2026-10-17 所有者于主聊天批准、派入 LIFE 队列）：背景——所有者自述色弱；健康看板（space-4）已按「符号/文字为主要通道、颜色退为辅助＋Okabe-Ito 色板」改造上线，本条把同一标准系统性落到 space-3（`F0.4` 给月度记录加文字标签只是顺带，不算系统落实）。范围：(1) 涨跌语义不许只靠红绿——涨跌加 ▲/▼ 或「涨/跌」文字作为冗余通道，金额已有正负号的保留，并补齐语义靠颜色承载的位置；(2) 「月支出」「贷款」等中性金额不得再用 negative 红色承担语义——改中性色，或加明确文字标签；(3) 色板统一到 Okabe-Ito，与 space-4 已上线标准一致（theme.css 的 `--positive`/`--negative` 为已知缺口位置）；(4) 趋势图为单系列、风险低，按同一清单顺带核对即可，不推翻重做。数据口径与公式一律不动，纯呈现层，按 B 类证据分级验收（构建审计＋验证脚本＋真实数据离线对账，所有者本人打开为准）。时限：赶在 2026-10-18（周日）08:39 PT 周刷新前入队执行。（实现方交付登记 2026-10-17 19 时 PDT：已在 artifact（space-3）上线并回灌本仓——theme.css `--positive` 改 Okabe-Ito 蓝绿 #009E73、`--negative` 改朱红 #D55E00；新增导出纯函数 trendIndicator（正 ▲ / 负 ▼ / 0 或 null —），Hero 净资产差、月度快照环比、本次余额差卡、储蓄率四处涨跌均补符号冗余（Hero 与余额差卡另有增加/减少文字）；「月支出」「贷款」指标去 negative 红色改中性，账户贷款行改中性色 + 「−」号 + 「负债」文字标签，分布图贷款行 tone 由 danger 改 muted；趋势图已有文字系列名、核对后不变。数据口径与公式未动。仓库 validate-color-vision 16/16、validate-monthly-facts 53/53、validate-facts-card 82/82、validate-payload 12/12；构建审计 pass（访客拦截页零数据）。如实保留：审计环境非所有者，owner 视角呈现未实测，按 B 类以所有者本人打开为准；构建方自报清单中依赖审计截图的项未能在其环境核验，已由仓库真实函数断言覆盖同等断言点。此 [完成] 仅表示已交付，PM 结论以评审记录为准。） **PM 21:00：B源码/16项脚本范围已验证；无新缺陷，owner看板呈现未独立实测仅作B形式跟进，数据未变对账不适用。**

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

- [完成] `HH0.1` 筛选结果为空时不回退显示全局第一名；hero 同步进入空态，避免把不满足筛选条件的房源称为“当前筛选首选”。（实现方交付 2026-10-17 17:30 PDT：已在 artifact（space-2）上线并回灌本仓——client `top` 改为只取 `filtered[0]`，筛选为空时 hero 渲染空态（标签「筛选结果」、标题「这个筛选下没有房源」、仅指引文案，无地址/verdict/链接/月供），筛选非空行为不变；构建审计 pass 且探针实测城市切换与空筛选两态正确；仓库 `validate-house-refresh.mjs` 接线断言覆盖本条。此标记仅表示已交付，PM 结论以评审记录为准。）
- [完成] `HH0.2` 刷新状态实现 stale recovery 和幂等 callback；任务失联后不能永久卡在 running。（实现方交付 2026-10-17 17:30 PDT：已在 artifact（space-2）上线并回灌本仓——复用 weekly-finance 同款模式：导出纯函数 `isStaleRunningState`（running 超 2 小时判 stale）与 `decideIngestCallback`；getReport 双路径共用 `presentRefreshState` 把 stale running 映射为可重试 error 且保留原 updatedAt；refreshReport 仅对未 stale 的 running 返回 already_running，stale 时可重新启动；ingest 在 settled 后对同/旧 asOf 成功回调与迟到失败回调 ignore（不插入、不改状态），running 时正常 apply。仓库 `validate-house-refresh.mjs` 36/36（纯函数边界/决策矩阵＋接线断言＋变异敏感性）。局限：stale 与幂等路径无法在审计浏览器内端到端触发（需伪造 2 小时前 running 行或任务回调通道），以纯函数实测＋源码评审为据；真实调度失联场景待自然发生或 PM 运行复验。此标记仅表示已交付，PM 结论以评审记录为准。）（实现方 P0 返工交付登记 2026-10-17 21 时 PDT：按 PM 18:07/21:00 沿原 ID 的代次绑定判据修复——`decideIngestCallback` 扩展 `refreshUpdatedAt` 输入：成功回调 asOf ≤ 最新报告在任何状态下一律 ignore（防倒退/防重复）；running 时成功回调 asOf 早于本轮刷新启动时刻判属上一代、ignore 且不触状态；失败回调仅 running 时可参与结算。handler 新增原子代次仲裁：apply 前以「status 与 updatedAt 均等于刚读值」的条件 UPDATE 认领（returning 判行数），唯一赢家才可插入/结算，输家重读状态与最新报告重新决策一次、不再二次认领。仓库 validate-house-refresh 更新至 44/44（含 PM 复现矩阵：running+旧 asOf、running+同刻 asOf、代次起始前后对照）且变异实测翻转（≤ 改 <、禁用代次起始守卫各使断言失败）。已在 artifact（space-2）上线并回灌本仓，构建审计 pass。如实保留残余：失败回调无 asOf/任务令牌，旧代失败与当代失败在极端迟到情形下不可区分——赢得仲裁者结算 error 后，当代成功回调仍可按 settled 规则插入并恢复 idle；认领会刷新 running 行 updatedAt，赢家若在结算前崩溃，stale 恢复时钟自认领时刻起算。真实调度/任务回传端到端仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。）（实现方 P0 余项返工交付登记 2026-10-18 01 时 PDT：按 PM 00:08 两复现修本代绑定——refreshReport 发起任务前建立 generation 并存入 refresh_state，spawn prompt 要求成功/失败回传原样带回；任务通道回调在 running 且已存代次非空时 generation 缺失/不匹配一律 ignore（旧失败回调形状被挡、不再结算新代；旧行 generation 为 null 走既有规则兼容）；认领改为在 claimed_generation 为空时写入本调用 claim token 的条件更新，输家重读见已认领标记必须 ignore，删除原「重读后仍 apply 直接继续」绕过路径，结算/发布走绑定 token+代次+running 的单一 CAS。与 HH0.3 原子可见性同批交付：仓库 validate-house-refresh 67/67、validate-house-ingest 50/50（同步轮次独立复跑同结果），构建审计 pass。如实保留：研究 agent 若不忠实回带 generation，该周回传会被门 ignore 并由 stale 恢复兜底重试；认领 token 无 TTL，赢家崩溃后同代回调被挡至 stale 恢复或新代清零。此登记仅表示返工已交付，PM 结论以其评审记录为准。） **PM 03:10至56628f4：00:08旧失败/并发claim输家源码返工关闭；settled代次再发布与spawn尾部覆盖状态仍有问题，沿原P0/A、Muse10-18，见最新复现/判据；运行补证独立。**（实现方 P0 余项返工交付登记 2026-10-18 03 时 PDT：按 PM 03:10 属本 ID 的两项边界修复——(1) settled 代次再发布：decideGenerationGate 改为任务通道在已存 generation 非 null 且状态非 running 时一律 ignore，同代新 asOf、异代、迟到失败均 saved=0 且报告行数/发布指针/状态整行不变，代次只能结算自身仍 running 的一代一次；legacy 空 generation 行与 owner 显式导入路径不门控。(2) spawn 尾部覆盖：refreshReport 的 spawn 后两处状态写改为 casSpawnTailState 单条条件 CAS（本代 generation＋仍 running），未命中零写并重读现状诚实返回（新代 running→already_running、本代已结算 idle→「刷新已完成，报告已更新」、已结算 error→error），spawn 前初始 running 写不变。与 HH0.3 首库候选修复同批交付：仓库 validate-house-refresh 76/76、validate-house-ingest 72/72（真实 handler＋应用自身 migration 的内存 SQLite，新增 settled 重放、spawn 三交错、首库候选矩阵），构建审计 pass、已在 artifact（space-2）上线；仓库回灌为同规格实现，与线上经同一验证矩阵功能等价（注释与辅助函数结构略异、非逐字一致）。如实保留：真实周调度/任务回传端到端仍归 EVID-LIFE-001。此登记仅表示返工已交付，PM 结论以其评审记录为准。） **PM 06:12至6d349b7：settled再发布及迟到spawn覆盖的原源码余项已验证关闭；原周调度/部署对应补证独立，详最新表。**
- [完成] `HH0.3` 新报告在 report + listings 同一事务中原子保存；不足最低数量、重复 URL/地址或字段不完整时保留上一期。（实现方部分交付登记 2026-10-17 21 时 PDT：随 HH0.2 同批落保存前校验片——过滤后 clean 列表做重复 URL 与归一化（去空格/小写）重复地址校验，命中即不插入、置 error「刷新结果存在重复房源，保留上一期报告」；不足 3 套的既有保留上一期行为不变；字段完整性由请求 schema 必填/最小长度保证。未完全实现部分：report 与 listings 两次插入仍是顺序写，平台未提供可用的事务 API（仓内无 transaction 先例），双写中途失败的原子回滚未实现，故本条不勾选，余项保留在队列。）（实现方余项交付登记 2026-10-18 01 时 PDT：按 PM 00:08 给定的备选方案实现整期原子可见性——加法 migration 0003 给 reports 加 published 标记、refresh_state 加 published_report_id 发布指针；新报告先以 published=0 写成不可见候选（report+全部 listings 写完），再以单条绑定认领 token 与代次的 CAS 同时切指针并结算，getReport 只读已发布报告，刷新中/候选未写完/不足/重复/失败均继续显示上一期及其日期；迁移回填此前最新一期为已发布、不删历史。仓库 validate-house-refresh 67/67、新增 validate-house-ingest（真实 handler＋应用自身 migration 的内存 SQLite）50/50，同步轮次独立复跑同结果；构建审计 pass。此 [完成] 仅表示实现方已交付，PM 结论以其评审记录为准；真实周调度端到端仍归 EVID-LIFE-001。） **PM 03:10至56628f4：有旧期原子可见性源码分项已验证；首库published=0候选回退曝光仍有问题，沿原P0/A、Muse10-18，见最新复现/判据；迁移/运行补证独立。**（实现方 P0 余项返工交付登记 2026-10-18 03 时 PDT：按 PM 03:10 首库复现修复——loadPublishedReport 删除「最新一行」无条件回退：发布指针目标须 published=1，否则只取最新 published=1 报告；无任何已发布报告时 getReport 返回 report=null 的诚实空态，published=0 候选在 listings 写入中途、写入抛错后、被新代取代时均不可见；legacy 数据由 0003 migration 回填负责，不把候选当 legacy。有旧期时的原子可见性行为不变。与 HH0.2 同批交付，验证同 HH0.2 登记（validate-house-ingest 新增首库中途/抛错矩阵，总 72/72；validate-house-refresh 76/76），构建审计 pass、已在 artifact（space-2）上线，仓库回灌为同规格实现、同一矩阵功能等价。回滚注意（应 PM 03:10 要求）：旧构建按最新行读取——若整体回退到旧构建且库中存有 published=0 候选，该候选会被旧逻辑曝光；安全回退路径是保留 published-only 的 loadPublishedReport 读路径、只回退其他部分，或回退前先确认库中无未发布候选；任何回退都不删历史报告。此登记仅表示返工已交付，PM 结论以其评审记录为准。） **PM 06:12至6d349b7：首库候选暂停/抛错后均不可见、成功整期可见，原源码余项已验证关闭；安全回退保published-only，详最新表。**
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
- [完成] `AUDIT-02` 指定内部通道例外按所有者 2026-10-17 决定执行：space-4 refresh 与两个保存回调、space-6 getDashboard 的无身份调用维持现状。此标记表示对应实现已交付；此前因缺身份重复撤回的结论被所有者决定替代。PM 源码契约结论与尚缺 A 类运行证据分别见批量表；真人读取及例外外写入口仍严格 owner-only，不扩大例外，不重新请求同一批准。
- [ ] `AUDIT-03 / P0` 健康源码及文档不得包含真实健康序列、个人基线、workout UUID、设备 ID 或真实初始快照。（2026-10-14 PM 复核至 `205f544`：health DATA-PLAN 恢复此前脱敏版本，仅保留新增同步机制说明；四组旧个人内容均不再命中，本次回灌隐私返工关闭。首次启动及 owner 运行证据仍待验，整项不勾选；见 L0.4。）
- [完成] `AUDIT-04 / P1` 看房筛选为空时 `filtered[0] ?? report.listings[0]` 仍展示全局首选，hero 与空列表互相矛盾。（实现方交付 2026-10-17：同 `HH0.1` 交付，见 HH0 节交付注与 changes.md 同日条目；源码中该回退已删除。此标记仅表示已交付，PM 结论以评审记录为准。）
- [完成] `AUDIT-05 / P1` 看房 running 状态没有 stale 判断；agent 未 callback 时刷新会永久不可用。（实现方交付 2026-10-17：同 `HH0.2` 交付，见 HH0 节交付注与 changes.md 同日条目。此标记仅表示已交付，PM 结论以评审记录为准。）
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

## Muse 自检交付与 PM 事后反馈流程

### `changes.md` 每条交付必须包含

1. 日期、app、需求编号（例如 `W0.1`）。
2. 用户可见变化及不在本次范围内的内容。
3. 修改文件、schema/migration 变化和兼容策略。
4. 自动验证命令与结果；不得只写“已测试”。
5. Muse artifact 实测证据：owner/guest、成功/失败、手机/桌面、真实或 synthetic 数据类型；证据必须脱敏。
6. 已知限制与回滚方式。

### PM / Design 并行反馈顺序（不阻塞实现上线）

1. 从 `changes.md` 找到需求编号和声称完成范围。
2. 对照固定判据审查真实代码；范围外副作用形成具体 bug 入队，不冻结整个实现队列。
3. 在 Muse artifact 复验 action、数据库迁移、刷新成功/失败/超时和权限。
4. 在 390×844、430×932 和桌面视口验证加载、空态、长内容、键盘焦点和核心流程。
5. 用独立样例复算关键公式：月供、训练量、lb/kg 换算、睡眠时长/效率、readiness、净资产、FIRE。
6. 逐项将“已验证／有问题”、版本、证据覆盖与关联 bug 写入评审记录；交付状态与 PM 结论分开，不把未复验当成未交付。

## 异步协作框架（OPS-001）

- [完成] `OPS-001` 双仓共用 CHARTER 已同步到本仓，AGENTS、plans 与 PM 定时任务已移除单项、包数与 PM 验收门控。本标记只表示协作文档已交付，不代表四个产品或历史业务条目已通过 PM 复验。
- 正常交接：Muse 按队列连续实现 → Handoff Gate／全量自检＋changes 交付 → 通过即按允许的 builder 流程上线；PM 并行标已验证／有问题，问题转单入队，Muse 不等待反馈继续。新方向等所有者拍板，普通 Life 上线已有授权。
- Muse 在 changes 记录交付与提案，不自写 PM 结论；PM 维护本文及与 CHARTER 一致的协作条款，不改业务代码／schema／changes／数据。两轮同一真实问题无进展带方案交所有者取舍，其他工作继续。

## 每 3 小时产品推进与反馈兜底

1. 先查 CHARTER、远端增量、审查游标、显式队列、方向期限与上线跟进；无新代码但有可推进产品工作仍推进，不遍读仓库。只在确无可执行事项时结束，不空提交、不虚构需求。
2. 新实现按需求 ID、范围、changes 与真实 diff 追踪，风险相称地运行必要检查；缺 ID 或必要证据如实登记具体补证项，不能冒充运行成功或以文档尾巴卡住产品。
3. 存量积压批量逐项事后标已验证／有问题，问题形成可执行 bug 入队，保留原判据和已通过分项；一个问题不冻结其他条目。结构性无法取得的 owner 视角材料不作阻塞，B 类形式缺口只记次要跟进。
4. 每轮实质评审包含 bug 单、新需求单和至少一项产品推进，并报告用户可见增量数、队列中位等待时长。来源、样本、上线事实如实记录；数据与日志脱敏。
5. 同 hash 已过检查复用，只看增量；无新材料／环境不复读旧问题。保留逐项 SHA、显式队列和原方向期限，不能因全局游标前移漏审。
6. PM 可维护 plans、落实 CHARTER 的 AGENTS 与准则全文同步；只改文档，不改业务实现。有实质变化才跑对应 Gate、提交 push main；提交前 fetch 安全整合并发，不覆盖、不强推、不改历史，保护脏现场。缺平台工具如实说明，不伪造实测，也不停止其他工作。

### 自动审查状态

以下是本轮真实审查游标；交付主状态、PM 事后结论和补证队列分别记录。历史“待验／唯一下一项／发布门槛”均不产生门控效力，以本文批量结案表和当前单一队列为准。

- 上次已审查源 commit：`e50d938b42dfce4c2b154270419982a2ff154a80`
- 上次运行：2026-10-18 09:10 PDT（本轮开始origin/main HEAD为 `e50d938b42dfce4c2b154270419982a2ff154a80`）
- 上次结论：一笔财务5组交付逐项标注见09:10表；四项旧反例修复分项关闭，FIRE投资本金/机构措辞已验证。F0.6同月旧端点、F1.6期间金额绑定、F1.1/F2.3旧blob读取沿原ID有问题，不伪称整体运行通过。
- 当前应推动：F0.6 P0/A（Muse10-18）、F1.6 P0/A（10-19）原日期/期间金额边界；F1.1 P1/A10-20、F2.3 P1/A10-21旧blob读取同队继续。F0.5/F1.6逐区间/渠道核对设计已交，不另派重复builder。08:39PT财务周刷新已到待运行事实，训练回执必要源码映射10-19；健康/训练重点、原方向/P1期限与L1裁决保留。EVID/B尾巴不设闸、L0.1例外不变。

### 自动审查记录



每轮只保留最近 20 条，格式为：时间、源 commit、涉及需求、结论（通过 / 返工 / 运行待验）、证据或阻塞原因。

## 当前执行排序

统一按 P0（数据安全／权限／管道缺陷、线上与存档级 bug）＞用户直提需求＞PM 需求与普通 bug＞证据与文档尾巴排序。W-UI 保存闭环、W-TIMER 已有缺口、健康首屏与全部运动等独立需求按真实队列连续处理，不等 PM 复验；L1/H0 刷新与来源、W0/W1 记录可靠性、H1 公式、H3/W3 周复盘等保留既有编号和业务边界，以真实技术依赖决定实现次序，不能将旧待验框当依赖。H4/W5/F3 已批准候选仍入 backlog，看房暂缓候选保持所有者决定；新方向提案与队列并行，实施先等所有者拍板。

## 2026-10-18 09:10 PDT PM 增量复验与产品推进

本节为最新事后结论，旧节仅保留当时事实；指标截点2026-10-18T16:10:12Z。清洁main `4029c34`检查后fetch、安全ff；本轮起始origin/main与新源游标=`e50d938b42dfce4c2b154270419982a2ff154a80`。上轮源游标c5cf74c之后排除4029c34（PM-only），**全部新增交付一笔e50d938**（财务四项返工＋期间核对卡，11文件）。提交前发现并发PM文档`9b784121487b8aa1d6170d6791550bf891f4887c`，仅plans新增14行，已安全暂存本轮自有改动、ff后无冲突恢复并逐条保留09:08反馈；不计可见交付。该反馈的原生字段/精确日期已在Life源码独立补验8断言；未访问其提及的另一仓。已读CHARTER/root/finance AGENTS、全部增量changes/diff与真实输入→owner校验→既有刷新状态→持久化→getter→页面；本笔未改并发/调度/DB schema/migration，未变健康/训练/看房hash复用已过检查，不重开已关闭源码。

### 用户可见增量、两项指标与上线事实

- **可核对已交付用户行为增量5组**：双端现金流资格守卫、期间收益守卫与FIRE投资本金统一、未核实现金试算降级、现金币种冲突隔离、期间核对卡。是5组实际源码行为，不是5项整体验证通过；PM文档计0，所有者新增使用确认0。新卡可读性及四项有效修复均有进展，余项见下表。
- **全队列中位等待不可计算**：旧queuedAt与实际startedAt缺失，四财务单只精确到入队日；Git/审计时间不能代替开工或生效时间。新增完整已开工样本n=0；有精确入队时间且能确认完全未开工的新增样本n=0（不是队列为空），不混用历史n=1约21分钟。
- 主状态 **已交付**；Muse申报space-3已上线、审计`audits/2026-10-18T14-26-17Z`成功及9文件cmp IDENTICAL。该映射/审计是实现方证据，本轮无可调用Muse builder/invoke_action，未独立取得submit回执或owner实际打开结果，不能写已上线在用。原08:39 PT（15:39Z）合法周刷新确认点已到，但本轮只有14:30Z Git交付，没有刷新运行回执；记**待补运行事实**，不虚构成功或失败，不让owner截图变审批。

### 全部交付及存量逐项事后标注

| ID / SHA / 分级 | 已验证范围 | PM问题与同队后续 |
| --- | --- | --- |
| F0.6 / e50d938 / A | 原期初跨月旧值/false、同名cash→credit、期末异常均降级；正常400、实录0/退款/贷款非现金排除原71项通过 | 这些旧反例源码关闭；**有问题**：同月旧日期仍按月前缀通过，沿原P0、Muse10-18 |
| F1.6 / e50d938 / A | 原期初false/跨月旧值、错误前月投入、08-01起点只09月覆盖均降级；原55项通过，FIRE新写/读取/轨迹改用investment，净资产卡未改 | 已修分项关闭；**有问题**：不同来源拼覆盖、超区间金额/无期间仍算收益、同月旧端点及卡片完整净投入语义，沿原P0、Muse10-19 |
| 沿F1.1 / e50d938 / A | 新ingest→getter保留verified=false，现金null；当期真实日期比较、排除恢复、true0/缺失原59项通过 | 新写入分项关闭；**有问题**：实际旧writer→新getter仍丢失明确false、产生确定覆盖，沿原P1、Muse10-20 |
| 沿F2.3 / e50d938 / A+B | 新ingest冲突CUR:USD/CAD列待核对、cashPosition=null，原61项通过；机构措辞改正，P2/B关闭，无数据改动对账不适用 | **有问题**：实际旧writer→新getter仍返回冲突旧现金合计，沿原P1、Muse10-21；旧Top10/长尾/固定分母关闭分项不重开 |
| 沿F1.6/F0.5核对卡 / e50d938 / A+B | 起讫/双端来源/投入期间/核实文字与各段理由接线存在，不回写历史 | **有问题**：缺期间仍算收益但行文称未参与、部分金额仍称整个期间净投入，归F1.6同一单，不增同义ID |
| HH0.2/HH0.3、F0.4 / 6d349b7、c5cf74c / A | 上轮settled/spawn/首库候选及旧完整性blob源码返工关闭，沿用上轮真实受控结果 | 没有新代码/事实，不重跑不重开；运行补证仍EVID-LIFE-001 |
| W4.3-D1 / a9a7ca9 / A+B | artifact完成回执交付声明保留，本轮没有新回灌 | **有问题（必要补证）**：space-6差异逐项映射与原真实回执矩阵，Muse10-19不延长；不拿旧仓代码判新部署失败 |

既有健康/训练等存量批量表与固定要求继续有效：源码关闭与A运行缺证分账，EVID明确必要证据，B归档尾巴不阻塞；L0.1四入口批准例外无新事实，不复审、不停同步。

### Bug单：四原ID余项，修复范围与首次反例一次列齐

以下数字/日期/来源均为**SYNTHETIC**，不是用户资产或线上运行结论。四项责任均Muse；新修复有实质进展，不计两轮无进展，不新造独立编号。

1. **F0.6 · P0/A · e50d938 · actions.ts:790–793（endpointIssues）**。复现：08-31现金1000→09-30现金1200，收入1000/固定300/投入100，期初balanceDate=2099-08-01、verified=true仍估算支出400；07-31对照已正确null。**实际/预期/影响**：月内旧余额被当真实期间端点，余额偏差仍会冒充消费；应按来源实际日期/端点契约核对，缺口保留事实、估算null并点名期初/期末，不用文件月份遮盖。同日09:08并发反馈所列status=unverified/carried_forward_unverified及YYYY-MM月末等价固定要求一并保留，不重复立单。**修法/固定验证**：双端使用完整合法日期和同一公开口径，覆盖同月较旧/跨月/未来或非法/缺日期降级语义、正常400、原false/role/实录0/退款矩阵，保存回读一致；不暗加未授权年龄阈值，旧数据保持可读而非假核实。原10-18。
2. **F1.6 · P0/A · e50d938 · actions.ts:1011–1012、1020、1040–1077、1110–1142；App.tsx:467–473、620–626**。复现A：投资100000→115000，09-01至15现金投入10000＋09-16至30非银行投入0，程序将不同类型/来源period并集成全月，收益/整段收益均5000；各自缺半期不能互相证明金额完整，两个渠道都覆盖全月的正常对照才成立。B：08-01至09-30金额10000整体用于08末→09末，同样5000，但无法知道其中09月实际投入；区间覆盖不等于金额归属于该区间。C：显式verified=true但所有投入period缺失仍5000，UI行却写“未提供期间·部分记录，未参与收益核对”。D：期初余额日期08-01用于08-31也5000。E：错误前月或只半月投入已把return置null，但computeInvestmentPerformance.netFlow仍10000，卡片照称“整个期间外部净投入”。A–D已在实际新ingest→内存保存→getter复现；原期初false/跨月/错误前月/实际08-01起点反例均已修，不重开。**预期/影响**：不完整或错期金额会把投入当收益并标已核对，金额与卡片声明矛盾。**修法/固定验证**：按实际余额日期、来源/渠道、实际区间绑定每笔已纳入金额与证明，不拿另一来源/零金额补缺口；超范围金额无可核对拆分不得整笔扣；缺期间不能升级为已核对（旧存档仍显示事实/待核对）；同月旧端点按完整日期解释。部分记录单列候选额，完整netFlow未知则null，整段累计中断。一次覆盖A–E、双渠道各全覆盖5000/含RSU2000、显式0/提现/负收益、首期/缺流/冲突/账户范围/旧blob/累计断点，FIRE本金已修范围不重开；前后端标签与实际纳入金额一致。原10-19。并发09:08反馈的原生investment_period_start/end/investment_flow_verified、status及矛盾字段规则原文保留：Life侧独立输入extra.investment_flow_verified=false且原生期间只半月仍5000、entryMeta丢extra、carried_forward_unverified仍5000；通用false对照正确null。与本单同一来源/期间绑定问题合并，不能将原生字段误当legacy；不自行判断另一仓的当前实现。
3. **沿F1.1 · P1/A · e50d938 · actions.ts:1269–1284 / getDashboard:1763–1765**。用实际c5cf74c旧ingest写09-30现金1000、verified=false（entryMeta确实保留false、旧accounts未带），不刷新地交当前getter读取：availableCash仍1000、account verified未知；实际emergencyCoverage配三个月平均支出100返回10个月。当前新ingest同输入正确null，为修复对照。**预期/影响**：部署后打开已有存档仍给未核实现金确定覆盖，不能只靠下次成功刷新纠正。**修法/固定验证**：读路径在已存同源/同快照entryMeta可确证时保守关联verified/balanceDate，无法关联诚实降级，不补造true，不改存储数值/日期。旧writer→原blob→新getter→实际consumer验证false/true/unknown、来源冲突/缺meta、同月日期、排除恢复/全排除/真0/缺账户/不足支出月，读前后旧blob字节不变。原10-20。
4. **沿F2.3 · P1/A · e50d938 · actions.ts:1658–1672 / getDashboard:1765**。实际c5cf74c旧ingest存ticker=CUR:USD/currency=CAD/value100，当前getter仍holdingsCash保留CAD、cashPosition=100；同输入新ingest已正确待核对/null。**预期/影响**：旧存档在刷新前仍把CAD当美元现金事实。**修法/固定验证**：读路径校验已保留现金明细的币种冲突并保留待核对；没有足够旧明细时诚实未知、不造汇率、不用Top10重算集中度。一次覆盖旧writer→getter、明确冲突/一致USD/非USD/缺元数据、0/负/未知、读存储不变，原固定全仓分母/share/搜索不变。机构文案已修关闭。原10-21。

### 新需求单与具体产品推进：沿F0.5/F1.6按区间核对，不新增系统

新增独立ID **0**；实质推进 **F0.5（P0/A，逐源可信范围原单）＋F1.6（P0/A，10-19原期不重置）**，责任Muse。现有entryMeta足够先做只读交互，不新增账本、不读取另一个仓、不回写源记录，也不等PM复验。F0.5原来源本体仍未交，不能用一张抽屉假称全量完成。

**产品判断/具体设计**：全期间卡优先显示“可核对x/y段”，点开按每对真实端点分组；每段固定三行：期初/期末余额事实与日期、现金净转入、非银行直接投入。后两行分别显示“已记录金额／可用于本段金额／覆盖起讫／核实状态”；某渠道缺部分时间就标具体缺哪一段，不允许另一行染绿抵消。旧存档缺期间行显示“历史记录、范围未证实”，完整净投入/收益为—，候选金额仍可读。某段失败时全期间金额为—并定位首个缺口，已成立段照常可查；零与提现保留真实符号。三个月正常分段各覆盖自身区间，不能要求每一月投入都单独覆盖三个月，也不能把首期起点前投入混入本期明细。这使现卡“每行是否覆盖全卡”误导转为对应段的解释，复用同一个服务端结论，避免前后端第二套规则。

F0.6现金估算与F1.1覆盖继续复用这组日期/核实事实；现金日期与支出n/3分母独立说明。健康看板仍优先七日原始事实/每源缺口与可用操作；训练完成回执按本次已完成ID读回、W1同源建议，不挤占既有P0与10-19回灌；看房暂缓新方向按所有者决定保留。未批准的恢复历史等新系统不开工。

### 验证、期限与必要反馈

- 原生 **facts-card85/85、payload12/12、color-vision16/16**通过；原五套fixture/断言/源码接线未改，仅临时提取器以Node stripTypeScriptTypes适配：cashflow71/71、monthly-facts73/73、investment-performance55/55、available-cash59/59、holdings61/61通过。不是TypeScript AST/编译器或原依赖环境执行；无依赖安装。
- PM **47项独立断言＋4项观察输出**通过，含预期缺陷反例：真实生产函数、新旧完整Actions、owner/guest/匿名拒绝且零DB触达、新ingest→内存行保存→新getter、旧ingest→原blob→新getter→真实现金consumer；新旧存储字节不写改。SDK/defineAction/Zod.safeParse为受控替身（未证明真实校验/默认值），DB为单行内存adapter，**本轮不是SQLite/真实Drizzle库、React、artifact运行**。提取器先误截对象返回类型，后consumer参数次序有误，均通过原源码签名定位修正；已读pua-debugging并应用隔离排查，不把脚手架错误记产品bug。
- 本笔无DB schema/migration，新增payload字段兼容源码已审；完整A运行必要补证仍EVID-LIFE-001，B归档不阻塞。单笔Gate4029c34→e50d938通过11文件/6脚本/9实现、diff --check通过。不能凭脚本覆盖声明冒充旧blob/整链实测，不能将缺运行回执直接升级P0。
- 原方向/期限保留：10-18 W1/H-LOAD能力边界及W-TIMER、10-19训练回执/F2-D1父、10-20旧P1周上限、10-22 W-UI父；财务四原日10-18/19/20/21不延长。今天尚未跨日；源修复进展充分，不触发两轮同问题无进展升级。L1原排期裁决仍保留，其他可执行事项持续推进。
- 流水裁剪迁移：删最老3767c92 H-UI流水，原缺睡眠/同日来源/零与缺值/partial、五态三视口、日期/来源层级/可行动入口、禁止以8/7/6自定活动公式冒充既有readiness要求仍保留；后来07f38f2/f50c498/ab1b016等已关闭源码以持久表/后续记录为准。健康producer→合法保存回读→匹配owner页面及390×844/430×932/桌面原矩阵仍EVID，未批准readiness历史新方向不实施；不因删流水重开旧缺陷。
- 仅plans实质修改；未改业务/HTML/素材/schema/changes/数据，未本地build、访问app.db或对外发送。临时工具提交前清理；提交前fetch枚举并发，PM-only Gate、正常push main与远端一致性记automation memory。Life普通上线不等待本结论。

## 2026-10-18 06:12 PDT PM 增量复验与产品推进

本节为最新事后结论；指标截点2026-10-18T13:12:07Z。清洁main d64488b检查后fetch、安全ff，本轮起始origin/main=`c5cf74c9a6eb8d8a4482810a6af8304b04ec1116`。上轮源游标56628f4后排除d64488b（PM-only），**全部新增两笔**：`6d349b750cfd9992ef20175a899551bf7f34bbd3`（看房三边界）及`c5cf74c9a6eb8d8a4482810a6af8304b04ec1116`（财务四用户单回灌＋F0.4旧存档）。已读CHARTER/root/受影响两app AGENTS、逐笔changes/diff、实际输入→身份→并发/状态→持久化→返回→页面；未变健康/训练hash复用原结论。

### 用户可见增量、两项指标与上线事实

- **本批可核对已交付用户行为增量8项**：看房settled回调拒绝、迟到spawn不覆盖、首库候选不可见3项；财务现金流核对、期间投资收益、可动用现金试算、全部持仓展开/搜索4项；旧财务存档完整性读取降级1项。这是已交付的具体行为范围数，不是8个需求全部验证通过，也不是所有者本轮新增看见8项。PM文档改动计0；所有者新增使用确认0。
- **全队列中位等待不可计算**：旧queuedAt/实际startedAt缺失，四财务用户单只有入队日期/接单Git时间；新增可计算已开工样本n=0，不能用提交时差当开工等待。可确认完全未开工且有精确起点的新增样本n=0，不表示无backlog；历史W-FINISH n=1约21分钟不混入总体。
- 两app主状态**已交付**。Muse申报均已按builder构建/审计上线；财务changes给线上与回灌server/client逐文件diff为零及审计`audits/2026-10-18T12-36-05Z`；看房明确同规格/同矩阵功能等价、非逐字一致。10:22:33Z和12:22:23Z仅Git时间，不当submit生效时间。PM无Muse builder/invoke_action，未独立核验线上部署；不标“已上线在用”。财务原约定10-18 08:39 PT周刷新尚未到，届时只记录真实成功/失败及脱敏口径对账，不要求用户例行截图或再批普通上线。

### 全部新增及积压逐项事后标注

| ID / 交付SHA / 分级 | 已验证的源码范围 | 有问题与同队列去向 |
| --- | --- | --- |
| HH0.2 / 6d349b7 / A | 实际完整handler＋内存SQLite控制：settled后同代/异代新asOf与失败均零保存且状态整行不变；spawn等待时先回调结算后迟到成功不复活；旧spawn跨新代成功/失败均不改新状态 | **上轮两类源码返工关闭**；既有认领输家/旧失败分项复用。实际周调度、平台回调契约及部署对应仍EVID，不凭prefix静态检查重造P0 |
| HH0.3 / 6d349b7 / A | 空库候选在listings前暂停时getReport=null，写入抛错后仍null；成功后整期3条可见。原0003迁移在隔离内存应用，新交付无新增schema/migration | **上轮首库候选曝光源码返工关闭**；原有旧期隔离/迁移兼容复用。回滚须保留published-only读取或确认无候选，旧reader风险已如实披露；实际迁移/发布补证仍EVID |
| F0.4 / c5cf74c / A | 用实际649b132旧ingest写3个月余额-only完整标记，再用当前getDashboard直接读：全部unknown、FIRE使用0月、client支出依据0月；旧payload字节未写改。normalizeStoredIntegrity＋消费守卫均存在 | **00:08/03:10旧blob源码返工关闭**，不再留真实P0余项；其他旧新写入分项不重开。合法SDK/schema/部署旧存档读取补证仍EVID |
| F0.6 / c5cf74c / A | 原60项合成断言通过：显式投入0不回退、贷款/非现金排除、实录0/退款、缺月/当期旧余额降级、扩展字段兼容；新字段已回灌 | **有问题**：两端日期/核实与逐账户分类未充分绑定，沿原P0/A、Muse10-18，见下；已修公式/别名分项不重开 |
| F1.6 / c5cf74c / A | 原35项通过：现金投入与RSU净投入、提现/负收益、首期、当期未核实/范围变化/跨月缺口降级；实际新ingest→保存→getDashboard回读已独立受控执行 | **有问题**：期初元数据、实际区间与投入期间不校验；原要求的FIRE投资本金边界未落实。沿原P0/A、Muse10-19，不另造同义编号 |
| 沿F1.1 / c5cf74c / A | 原45项通过：分类现金、非现金排除、只在本页试算、缺失/真0/样本不足和已标旧余额降级；原三支出月口径/月份标签已接线 | **有问题**：明确未核实现金丢失核实状态并参与覆盖，沿本ID P1/A、Muse10-20；日期仅比月份的事实列入同一来源/日期判据，不另建台账 |
| 沿F2.3 / c5cf74c / A+B | 原51项通过；独立12只/Top10/全量分母1200/搜索share不变，旧Top10不可恢复长尾提示存在 | **有问题**：现金ticker与currency冲突仍计美元现金，沿本ID P1/A、Muse10-21；机构数写成账户数为P2/B次要呈现跟进。完整集合/固定分母已验证不重开 |
| W4.3-D1 / a9a7ca9 / A+B | 已交付声明保留，本轮无源码回灌；不能拿仓内旧代码当实际部署反例 | **有问题（必要补证）**：Muse登记space-6与仓库有receipt外差异，须逐项映射，不能整树覆盖；原10-19不延长。真实回执读取/并发新训练/建议同源/候选>20/失败重读不重complete原矩阵不追加同义单 |

其他存量结案表继续有效：已关闭源码不因A运行材料缺失重开，缺证具体归EVID-LIFE-001；B截图规格/归档与结构性owner视角不阻塞。L0.1已批四入口例外无新事实，不复审、不停同步。

### Bug单：沿原财务ID，首次一次列齐反例与修复判据

以下均为**明确synthetic**数据/日期/来源名，受控真实函数或完整handler＋内存SQLite复现；不声称实际所有者数据已出错。无健康/训练新代码缺陷，不凑单。责任均Muse，保留原目标日。

1. **F0.6 · P0/A · c5cf74c · server/src/actions.ts:733–753、757–773：现金流估算只检查期末旧日期，未验证两端同分类/核实。** 复现：2099-08末现金1000→09末1200，收入1000/固定300/投入100；期初balanceDate=07末，或期初verified=false，当前仍返回flexibleSpend=400/source=estimated；同名账户cash→credit仍过只比source名的守卫。当前期末标旧日期则能正确返回null，作为已修对照。**实际/预期/影响**：不可信期初或分类变化仍冒充同口径现金差，会把余额边界偏差当消费；应保留余额事实并将估算置null、说明具体端点/分类/核实缺口。**修法/固定判据**：反推资格检查期初与期末各自真实日期、明确未核实状态及每账户source+role；期间不符/明确未核实不得靠文件月份通过。一次覆盖期初/期末旧值、verified=false、同名role改变、缺月/改名、正常400、实录0/退款优先与旧payload降级；实际ingest→保存→读取消费，原分类/贷款/HSA矩阵不降。目标10-18。
2. **F1.6 · P0/A · c5cf74c · actions.ts:892–960、1389–1390、1458：期间收益未绑定期初与投入真实期间，FIRE仍用净资产作投资本金。** 复现A：投资100000→115000、投入10000；期初verified=false或期初余额日期早一月，仍收益5000。B：投入明确periodStart=08-01/periodEnd=08-31且verified=true，用于08末→09末，仍收益5000；完整新ingest→存储→getDashboard也复现，期间元数据原样保留却未参与判定。C：08-01→09-30用仅09月投入仍同算5000，没有证明整个实际区间；两个key月份相邻不等于期间覆盖。D：三个月有完整依据时，加入同一synthetic HSA非现金余额，FIRE progress以live.netWorth/target算；收益卡只用investment，违反原用户单同一投资边界要求。**实际/预期/影响**：期初/期间不足仍给确定收益，或非投资资产/贷款变动改变投资达标进度。应对不匹配/未核实区间收益null并解释，整段累计同样中断；按已批准F1.6让FIRE本金与收益卡共用明确投资账户边界，净资产事实卡仍保留原定义。**修法/固定判据**：检查双端余额日期/核实、实际起讫与投入/非银行投入period覆盖，不能仅`isConsecutiveMonth`+条目存在；缺期间证明不伪造verified，legacy保持可读降级。一次覆盖以上四例、正常已覆盖期间5000/含RSU2000、0/提现/负收益、首期/缺流/冲突/跨月/账户变化、读旧存档、累计断点与页面标签；HSA/负债/持仓详情改变不应改变投资本金/收益，净资产自身照实变化。目标10-19。
3. **沿F1.1 · P1/A · c5cf74c · actions.ts:1047–1066、1085–1108；client emergencyCoverage:168–218：未核实现金变成可用覆盖。** 复现：快照09末，现金1000、balanceDate=09末、verified=false；完整实际新ingest→getDashboard中月度entryMeta仍false，但accounts丢该字段、live.availableCash=1000/stale=[]；以三个月平均支出100的固定synthetic依据调用真实consumer，得到10个月覆盖且reason=null。另09-01余额用于09末，按`.slice(0,7)`比较同样无日期缺口提示。**预期/影响**：金额可以作为已记录事实显示，明确未核实选中项不可给确定覆盖；日期差异必须如实解释，不能用刷新asOf替代余额日期。**修法/固定判据**：复用既有源元数据到服务端summary与本页试算，保留明确false/未知/已核实与真实日期；选中未核实项覆盖null且给就近原因，排除该项后的正常试算可恢复；不静默从默认范围剔除又宣称全可用，不改来源余额。一次覆盖已核实/明确未核实/legacy未知、当前/跨月/同月较旧日期、排除未核实项、全部排除、真0、缺账户/不足支出月与原金额不改写。日期新鲜度沿同一来源契约明确截止，不能另造隐含阈值。目标10-20。
4. **沿F2.3 · P1/A · c5cf74c · actions.ts:1194–1211：冲突现金币种仍计美元。** 复现：ticker=CUR:USD、currency=CAD、value=100，真实normalizeHoldings把现金明细保留CAD但cashPosition=100；页面美元现金合计却当USD。**预期/影响**：币种字段矛盾应列待核对、保留原记录，不做隐式换汇/美元相加。**修法/固定判据**：现金ticker所声明币种与显式currency一致才参与相应汇总，缺失/矛盾分别说明；覆盖USD一致、非USD一致、冲突、缺currency但ticker可证明/无法证明、0/负/缺值、跨机构多现金，原长尾/固定分母/搜索不变。目标10-21。附P2/B：client HoldingsSection以机构数组长度写“个账户持有/账户”；输入只提供institution，改称机构或明确账户覆盖未提供，不编账户数，无数据变更则对账不适用。

### 新需求单与具体产品推进：沿F1.6/F0.5的期间核对卡

**需求响应**：四财务用户单均正式记已交付，PM结果以上表分项记录；新bug沿原ID竞争，不再给Muse重复派builder。新增独立需求ID **0**，本轮实质推进既有 **F1.6（P0/A，10-19）＋F0.5（原来源范围/优先级/排期不改）** 的核对交互设计，属于现有财务方向，可直接入队实现，不需新方向拍板。

**产品判断：用户需要先知道“这个期间是否能算”，再读收益金额。** 收益卡首行固定真实起讫日期与“已核对／待核对”；第二层保留期初投资余额、期末投资余额、整个期间外部净投入三项事实。若投入期间或某一端未核实，收益显示“—”，就近写“期初未核实／投入仅覆盖…／余额日期不匹配”，不能只写泛化“数据不足”，也不能把部分已知投入总额当完整净投入；已记录候选金额可在展开里标明“部分记录、未参与收益”。当一段不成立时，整段累计明确在哪段中断，其他已成立段仍可读，不把缺段填0。

展开使用既有entryMeta，不新增来源系统：按同一行展示来源、角色、期初余额日期/核实、期末余额日期/核实、投入periodStart/periodEnd/核实，明确该行是否覆盖卡片区间。F0.6估算抽屉复用这套双端边界/缺口呈现；F1.1仍将现金日期与支出n/3月分别解释。投资收益与净资产较上次余额差保留各自标题/口径，不将后者改成市场归因。首次交互固定状态为：完整正常/真实0/负收益、明确未核实/缺元数据、错期间/跨月缺口、范围变化、刷新失败保上次及原日期；使用现有刷新入口，只读核对、不回写源历史。

健康/fitness重点保持：原七日事实与每源缺口仍先于新增恢复历史系统；训练回执按同一已结束workout ID读取已存结果、W1同源建议/依据日期，不因财务批次改变优先级或新建第二公式。W4.3-D1源差异回灌是补证工作，不能冒充新的可见训练交付；看房新方向仍按所有者决定暂缓。

### 验证、期限、必要补证与交接

- 原生执行：house-refresh **76/76**、finance facts-card **84/84**、payload **12/12**、color-vision **16/16**均通过。两逐笔Gate分别 **5文件/1脚本/3实现**、**13/7/10**，聚合 **16/8/13**及diff --check通过。增量UUID/个人路径/INITIAL/固定device四项窄扫描均0；不是全面隐私证明。
- 裸环境无typescript/Bun/app依赖，不安装。PM以Node内置stripTypeScriptTypes抽取原生产函数，对交付五套原断言做临时提取器适配：cashflow **60/60**、investment-performance **35/35**、available-cash **45/45**、holdings **51/51**、monthly-facts **71/71**过。断言/fixture和源码接线检查未改，但这**不是原TypeScript AST执行/编译器或原依赖环境复跑**，故与Muse原生申报分账。house-ingest **72/72为Muse申报**，PM未在Bun/真实Drizzle库独立重跑。
- PM另有 **51项独立synthetic断言**通过（含预期缺陷成功复现）：完整真实两app handler、原649b132 ingest→旧blob→当前getter、真实客户端consumer；SDK/defineAction/Zod校验/默认值为受控替身，schema列来自原文件，Drizzle形adapter在SQLite `:memory:`执行实际handler给出的select/insert/条件UPDATE，应用app自身迁移、FK开启。不是实际SDK/Zod/Drizzle库/React/artifact端到端。临时提取器曾把函数返回类型当结束、SQL adapter缺省属性/排序列转换两处报错，定位并修正后通过，未记产品缺陷；应用pua-debugging隔离排查，scratch交付前清理。
- 本轮无schema/migration变更；财务加法payload字段及nullable消费已审，真实请求/schema旧格式兼容与合法保存回读仍需Muse受控artifact补证，不以mock冒充。财务线上逐文件diff零为新增交付映射进展，原A必要补证继续EVID；看房同规格差异需映射，安全回退保留published-only，不删历史/用户数据。B归档形式非门控。
- 原10-18 W1/H-LOAD能力边界和W-TIMER、10-19训练回执/F2-D1父、10-20旧P1周上限、10-22 W-UI父不延长；本轮未跨日。F0.6原10-18、F1.6 10-19、现金10-20/持仓10-21均保留责任Muse。L1既有排期裁决请求保留、不重复同问；HH/F0.4本轮有真实修复，财务新边界首次反馈，不计两轮无进展，其他可执行项持续推进。
- 最老3767c92 H-LOAD流水归并到此：原同一LA周一→截止日的两期次数/时长/力量容量、HealthKit sessions/力量去重、整周coverage/已测组、跨周一/单位/缺日/重复日/缺源/旧值/真0、低readiness原tierFor score<2及缺窗口不得给确定等级/百分比判据保留；删除coverage/低分门槛的变异与真实producer→合法保存回读→页面对账仍EVID。07f38f2/f50c498/ab1b016等后来已关闭源码范围以持久表和后续记录为准，不因旧流水裁剪重开、不要求新增未批准历史系统。20条流水上限保持，原ID/固定要求/未完期限不随裁剪丢失。
- 仅plans实质修改；无业务/schema/changes/HTML/素材/真实数据写入，无本地build、依赖安装、app.db访问。提交前fetch动态核对全部增量，正常commit/push main；PM-only Gate及最终SHA/远端一致性记automation memory。普通Life上线不等待本结论。

## 2026-10-18 03:10 PDT PM 增量复验与产品推进

本节为最新事后结论，旧节保留当时事实；指标截点2026-10-18T10:10:04Z。起始origin/main=`56628f4cf38a8bfba45230a8ab29c9085dc261ec`，从清洁main d339b14安全fetch/ff。上轮源游标a9a7ca9之后排除d339b14（PM-only），全量新增为`eb9be7ed48dd30ae26326ac8499ebbcbff48d5e8`（用户财务需求）、`0cd1358f0561d8965e6de18eac9f2d159261e371`（F0.6接单）、`a22dec4684347cef8515f61e540f1428acd7d3f6`（F1.6接单）、`c4f8c28693323b83c68e32ada663c21627adadea`（F1.1接单）、`e21b4518dc442130d08bbbecd0c83281df4aba86`（F2.3接单）、`56628f4cf38a8bfba45230a8ab29c9085dc261ec`（HH0.2/HH0.3源码及交接）。逐笔范围、changes、CHARTER/root/受影响house AGENTS、真实输入→权限→代次/认领→持久化→返回→页面已审。无新健康/训练实现，不重测未变hash。

### 用户可见增量、两项指标与上线事实

- **本批可核对已交付行为增量3项**：看房运行中新代拒绝无/异代次任务回调、并发认领输家硬停、有上一期时新报告及房源写齐后单次切换。是3项行为改进，不是HH0.2/HH0.3整项通过；PM文档0项。财务接单5笔文档不计产品增量，F0.6/F1.6/沿F1.1仅在后续依赖登记中申报已上线，缺具体changes/源码与最终提交证据，本轮不把该间接声明计作新增实测交付。沿F2.3仍只有已派builder记录。
- **全队列中位等待不可计算**：旧queuedAt及实际startedAt缺失；新财务批次入队仅精确到日，接单Git时间不是实际开工时间，新增完整已开工样本n=0，不能用提交间隔代替等待。完全未开工且有精确起点的可确认新增样本n=0，不代表无backlog；不混入历史W-FINISH单一样本。
- HH本批主状态**已交付**、原ID残余修复**进行中**；Muse申报space-2 builder build/audit后上线，审计引用`audits/2026-10-18T08-25-31Z`，changes称源码/迁移逐字回灌。08:33:32Z为Git时间，不当submit生效时间。PM无Muse builder/invoke_action，未独立核验线上版本，所有者新增实际使用确认0；不写“已上线在用”。Life普通上线授权保持，无PM前置。

### 全部新增与积压逐项事后标注

| ID / SHA / 分级 | PM已验证 | 有问题与同队列去向 |
| --- | --- | --- |
| HH0.2 / 56628f4 / A | 真实handler合成控制：新running拒绝旧失败（缺代次/异代次）且状态整行不变；异代成功零写；A认领暂停、B输家saved=0无插入、A一次保存并idle；串行同asOf重复零写；旧赢家保存中被新代取代后saved=0、不发布、不结算新代。67项仓库脚本过 | **00:08两个原复现的源码返工关闭**。仍有settled代次可再发布及spawn返回无条件改状态，沿本ID P0/A见下；实际周调度/任务回传/平台身份绑定仍EVID，不冒充新越权缺陷 |
| HH0.3 / 56628f4 / A（实际schema/migration） | 有旧期时，候选listings写入前和写入抛错后getReport均显示原旧期；新代接管后旧候选不切指针；原不足/重复校验复用，0002→0003合成旧报告/指针回填、legacy空代次成功/失败兼容通过 | **有旧期原子可见性源码分项关闭**；首次空库仍回退到published=0候选，沿本ID P0/A见下。未做真实SDK/schema/Drizzle库/部署迁移实测；A必要补证归EVID。不能把新增列称B类或无schema影响 |
| F0.6 / F1.6 / 沿F1.1 / 沿F2.3 / eb9be7e及四接单SHA / A+B | 用户新需求已在本评审周期编号、定优先级/目标日、列全synthetic判据；均已接单，避免重复builder。根队列同步主状态为进行中，交付声明另记 | 前3项有间接已上线声明，未见具体实现/changes，属必要交付材料问题，不凭旧源码判断新部署有bug；沿F2.3只有派工。请执行侧即时回灌交付范围/最终hash、原矩阵实跑与上线事实，不等下一三小时 |
| F0.4旧blob余项 / 35ae750，复现07:08:52Z / P0 A | 无源码增量，复用00:08实际旧blob→getDashboard→FIRE反例和已关闭新ingest分项；不重复审测 | 同步轮次明确因space-3侧聊构建互覆风险顺延，责任Muse、10-18不变；将旧blob消费归一化并入现行同app财务批次或其后立即接续。是一次无新修复跟进，非两次失败返工，不因PM停其他工作 |
| W4.3-D1 / a9a7ca9 / A+B | 原回执交付声明/目标10-19保留；本轮仍未回灌实际源码，旧代码不能代表已交付版本 | 源码/hash及原fixture必要补证仍EVID；Muse本轮因HH P0顺延已登记，责任/原期限不变。真实回读、同源建议、失败仅重读不重复complete等原矩阵不追加同义单 |

### Bug单：沿HH0.2/HH0.3的3类真实边界，原F0.4继续

全部以下复现为完整实际handler在受控adapter＋SQLite `:memory:`的**明确synthetic**控制，非线上已发生事故，不使用真实报告/业务数据。沿既有编号修复，不增加独立同义bug单；首次把本次真实新事实及判据一并列齐。

1. **HH0.2 · P0/A · 56628f4 actions.ts:301–311、615–655、675–692：settled代次再次发布。** 复现：合成旧期→refresh得G→G成功asOf=2099-01-01保存3并idle；再从task-return通道传相同G但asOf=2099-02-01，仍saved=3且多一期；换成异代G-old/asOf=2099-03-01仍saved=3。所有日期仅合成排序控制，不代表真实未来数据。实际：gate在非running直接pass，claim在idle也可取得，settle对idle不要求running；预期：任务回调只结算自身仍有效的未结算代次一次，不能因较晚来源日期再发布。影响：迟到/重发任务能把已结算报告换成另一份；旧失败/同asOf已修分项不重开。**修法/判据**：任务通道把代次与有效终态统一检查，settled后的同代或异代成功/失败均saved=0且报告行数/指针/状态不变；owner显式导入与确有必要的null代次legacy兼容分支单列，不借兼容放开新契约。保留当前成功一次、同asOf/旧asOf与并发唯一赢家矩阵。责任Muse，目标10-18。
2. **HH0.2 · P0/A · 56628f4 actions.ts:487–516及setRefreshState:342–354：迟到spawn结果覆盖已结算/新代状态。** 复现A：让spawnTask的受控等待期间先以当前G完成合法回调并idle，再返回`{ok:true,taskId:'synthetic-task'}`；refresh尾部无条件把它改回running。复现B：旧spawn仍等待时把旧updatedAt老化超过2h，正常refresh建G2；旧spawn随后成功返回把generation/taskId改回G1，或失败返回把G2改error且清taskId。预期：旧启动结果只能附着于自身仍running且未被结算/取代的代次。影响：已完成刷新重新轮询/阻止重试，当前任务丢失或被误报失败。**修法/判据**：spawn成功/失败的尾部更新使用本代+仍running条件CAS，不复活已结算代、不改G2；返回状态从实际当前状态诚实给出。把上述三交错加到实际refresh handler矩阵，正常spawn/失败/stale重试对照保留。该原子边界是本轮新增真实缺陷事实；不要求更改已批准身份例外。责任Muse，目标10-18。
3. **HH0.3 · P0/A · 56628f4 actions.ts:362–379、747–767：首份候选半写可见且失败后仍显示。** 复现：应用迁移后的空内存库，无旧report；refresh建G→合法三套synthetic ingest，在report插入后、listings插入前暂停。getReport返回新report+空listings（published=0）；令listings写入抛错后saved=0/status=error，再读仍返回该空报告。预期：无已发布期则report=null、明确首次刷新/失败，候选永不因“最新行”回退曝光。影响：首期或无已发布历史时把未经完整保存的报告呈给用户；有旧期的成功隔离已验证，不重开。**修法/判据**：只回退到明确已发布完整期，legacy由现有0003回填负责，不把candidate视为legacy；首库正常/暂停/写错/被新代取代时未发布均不可见，成功整期后才出现。原旧库迁移、旧期保持、重复/不足与保数据矩阵保留。责任Muse，目标10-18。

**F0.4 · 原P0/A不变**：旧payload缺三项Proven却带integrity=complete时，读取消费者仍让无收入/投入证明的月份进入FIRE，真实旧ingest→新getDashboard反例/位置/预期见00:08节；读取时按指标归一化legacy完整性或在消费者严格检查所需依据，保留余额/日期/历史，不删除/伪造证据。原发现01:07Z、剩余复现07:08:52Z、old queuedAt未知，Muse10-18。无新代码不重开已关闭新写入/空/月中分项，不把缺证据升格P0。

### 新需求单与具体产品推进：回应用户财务批次，细化沿F1.1/F2.3

**本周期正式回应**：F0.6（P0/A，现金流输入兼容与核对，10-18）、F1.6（P0/A，整段期间投入与收益，10-19）、沿F1.1（用户直提P1/A，可动用现金，10-20）、沿F2.3（用户直提P1/A+B，全持仓只读详情，10-21）全部由Muse侧聊接单中；原首次判据完整保留，不另造同义需求，不重置截止日。F0.6字段是F1.6真实技术依赖；F0.4旧blob消费应与同app改动合包解决，其他独立工作继续。本轮不再访问Firance或重派builder。

**产品判断：三个月支出可信之后，现金覆盖还必须能回答“哪些钱今天可动用”。** 本轮推进沿F1.1现有范围的具体交互：首屏保留一个覆盖卡；卡下同列显示“纳入现金账户数/余额日期范围”和“支出依据n/3月”。只读展开现有账户列表，默认沿F0.6 cashflow_role，仅cash可勾选，credit/debt/non_cash列出排除原因，不把HSA/债券/退休资产当现金；每行只显示现有账户名称、余额及其原asOf，不复制标识或新增账户权限。未选账户/合计真0显示“可用现金为0”，没有账户或余额缺失显示“未提供”，两者不混同。选中项存在陈旧/未核实余额时，保留金额事实、就近标“含旧余额/待核对”，暂停确定覆盖数；不能默默剔除后仍称全部可用现金。

账户勾选先明确“仅本次页面试算”，切换不回写来源余额/角色、不新建偏好存储；沿现有F1.1授权范围，可直接实现。分母展示真实所用三个月标签与支出来源（已记录/估算/待核对），沿F0.6/F0.5已定依据筛选；若只有2月、支出为0/负或待核对，显示原因及现有刷新入口，不给无限/虚构月数。合成例：现金1000＋HSA500只纳入1000；排除现金后合计0；旧现金与缺支出须各自解释，不能只写总“数据不足”。这是原F1.1的状态/交互映射，固定分类/真0/缺失/日期/原数据不变判据已在用户单中，不追加新系统。

沿F2.3进一步确定：搜索仅过滤当前展示，顶部集中度分母/账户覆盖/日期保持同一份全部有效持仓口径；显示“匹配x / 全部n”，旧Top10缓存明确“只有摘要，下次成功刷新后可查全部”，不能把搜索后集合重算成全仓。健康七日事实条已交付但尚不能代表逐日恢复评分，继续来源/缺口；训练完成回执仍按同ID已存记录和W1同源建议推进，不因本财务批次改变健康/训练重点。看房新方向保持所有者暂缓，本轮只修既有HH0。

### 验证、期限与必要跟进

- `node house-hunting/validate-house-refresh.mjs` **67/67**过；新增Bun `validate-house-ingest.ts` 的50/50为Muse申报，本机无bun及house node_modules，PM未独立复跑，不把67项接线当完整handler证据。PM另跑**29项完整真实handler synthetic控制**过，含以上真实缺陷成功复现、旧复现关闭、旧期候选/写错、新代接管、权限对照、原迁移兼容。真实TS经Node stripTypeScriptTypes执行，SDK/defineAction/Zod为替身，按原schema列映射的Drizzle形状adapter在SQLite内存执行实际handler发出的select/insert/条件UPDATE，FK开启；不是实际Zod验证、SDK入口、Drizzle库、React或artifact端到端。最初两次harness报错定位到适配层误把缺省def当函数，修正后全部29项通过；不把测试适配层故障计作产品bug。scratch清理，不提交测试代码或真实数据。
- 六笔逐段Gate全过：五笔plans-only各1文档/0脚本/0实现，56628f4与聚合各8文件/1脚本/6实现；diff --check过。0003四列加法与两条回填、journal tag对应已读；旧报告保留。**回滚风险已有披露**：旧构建按最新行读，若有published=0候选则会曝光；不能宣称任意revert安全。Muse应随本A修复给不删历史的兼容构建/读路径回退方案及合成验证，不向生产库写探针、不擅删孤儿。A必要材料归EVID同队尾巴，B截图/归档形式不阻塞。
- 原W1/H-LOAD 10-18能力边界/方向响应保留：原始七日事实已交不重做，逐日readiness评分未提供，需新历史系统先给所有者具体方案，不偷开。W4.3-D1及F2-D1父10-19、旧P1周上限10-20、W-UI父10-22不延长；本轮未跨过这些日期。L1既有排程裁决保留不重复，F0.4因同app构建互覆顺延已有责任/目标；HH本轮有实质修复，不按两轮无进展升级，其他可执行项继续。财务间接上线声明补实际交付证据/源码映射，不要求用户例行截图批准。
- 最老3767c92流水归并：34f216b脱敏关闭（禁止打印真实统计、保留运动需求、不把真实值改称synthetic）；a7595f3/3767c92整周源码/16独立控制关闭，包含第21条缺组、整周无limit、双计数+coverage门槛、删除门槛的假百分比变异。真实producer→合法同步保存回读→今日/历史，legacy/真0/null/自重/混单位/缺组/超过20条矩阵及部署/视口证据仍EVID；顶层与18:07/21:00持久判据继续有效。原交付脚本coverage23/comparison25/units25/source36/steps8/persist42和16项已过事实复用，不因删除流水重开。最近流水20条，未完判据/ID/期限/发布事实不丢失。
- 无Muse builder/invoke_action；不本地build/装依赖/访问app.db，不改业务/schema/changes，L0.1已批四入口保持。PM仅plans实质修改；提交前fetch动态核对并发，正常commit/push main，最终PM-only Gate与SHA/远端一致性记automation memory。


## 2026-10-18 00:08 PDT PM 增量复验与产品推进

本节为最新事后结论，旧节只保留当时事实；指标截点2026-10-18T07:08:52Z。起始origin/main=`a9a7ca9aa677597e27c4eb7dbaa2fcc4c8df1108`；上轮源游标649b132后排除5ec6ca4（PM-only），新增逐笔为`35ae75035a51f8d63c648589ba79766d880559b4`（财务）、`544af8ff5611eba1dbe7648e72b87f84851e01df`（看房）、`a9a7ca9aa677597e27c4eb7dbaa2fcc4c8df1108`（训练回执文档登记）。清洁main检查后fetch/安全ff，读CHARTER、队列/期限/发布事实、changes、受影响三个app AGENTS与完整增量，独立追踪输入→身份→并发→持久化→返回→页面。PM仅改plans，验证全部明确synthetic。

### 用户可见增量、两项指标与上线事实

- **本批申报已交付用户可见增量6项**：财务月度收入/投入依据及缺失就近呈现、应急金只消费已证明支出月、储蓄率不完整依据提示；看房过滤早于新刷新起点的旧成功回调、保存前重复URL/地址保护；训练完成后的同ID回执。前5项有回灌源码/脚本可复核，第6项仅artifact交付声明及审计/调用摘要，源码未回灌。此数按具体行为计，不是6项整体验收通过；PM文档增量0。
- **全队列中位等待不可计算**：旧queuedAt与本批真实startedAt仍缺失，新增完整已开工样本n=0。W4.3-D1已经交付，从“完全未开工”子样本移出，不能继续算等待到现在，也不能把06:26:43Z的Git登记时间当开工时间；本轮可确认且带入队时刻的完全未开工子样本n=0（不是全队列无待办）。历史W-FINISH约21分钟/n=1仍只是历史样本，不混总体。
- 主状态**已交付**（HH0.3只交保存前校验片、余项进行中）。Muse申报space-3/2/6均经builder构建审计后上线；04:27:08Z/04:29:15Z/06:26:43Z为Git时间，不是独立核验的submit生效时间。PM没有builder/invoke_action，部署源码映射未独立核验，所有者新增实际使用确认0，不写“已上线在用”。自检通过即按授权上线、其他实现连续推进。

### 全部新增交付与积压逐项事后标注

| ID / SHA / 分级 | PM已验证 | 有问题与同队列去向 |
| --- | --- | --- |
| F0.4 / 35ae750 / A | 真实新ingest→隔离SQLite保存→getDashboard：余额-only月spendProven=true、income/contributionProven=false、unknown且FIRE月数0；原空/月中已修矩阵57项回归通过 | 上轮余额-only新同步复现源码返工关闭；**旧存档仍能绕过新依据进入FIRE**，沿原F0.4 P0继续见下。三新布尔为action/payload附加契约、缺字段默认false，DB schema/migration无diff；实际SDK/schema及部署映射仍EVID |
| F0.5首片 / F1.1 / 35ae750 / A+B | 真实completeSpendBasis：新支出有依据但收入/投入缺失的三个月仍可计3；同一旧存档缺新依据则计0。月度展开显示收入/投入“未提供”、依据行及储蓄率说明已接线，84项回归通过 | 首片范围已验证，F0.5逐源coverage/最后成功时间本体未交，原队列继续，不把条目存在当全来源全月完整证明。owner呈现属B跟进，不重开源码；余额可用性不被月流量缺口吞掉 |
| HH0.2 / 544af8f / A | 早于刷新起点成功回调saved=0且running整行不变；正常成功保存一次、串行同asOf重复saved=0；44项回归通过，旧stale恢复分项复用 | **原P0仍有旧失败结算新running与并发重复保存**；真实handler/SQLite反例见下。此次有实质修复进展，不按两轮无进展升级或重开已修stale/串行部分 |
| HH0.3 / 544af8f部分 / A | 重复URL、trim+小写同地址、过滤后不足3套三对照均saved=0、report零插入；正常三套成功 | 保存前校验源码分项已验证；report→listings仍顺序两写，无原子可见性，本ID余项继续。Muse以缺已知事务API顺延，不等PM；具体替代方案见本轮产品推进，不能仅以仓内无先例断定平台永远不支持 |
| W4.3-D1 / a9a7ca9 / A+B | 已核对交付范围、同IDreceipt/receipt_previous附加契约及36项/66项、sandbox调用、审计声明；此提交只有plans/changes | **有问题（必要源码/证据补齐）**：没有本轮实际client/server/validate-receipt，无法独立验证handler、身份分支、并发回读、候选超20与页面消费。不能测试仓内旧源码后宣称线上未修；不把缺证据造P0。按原固定矩阵回灌实际交付源码/hash差异并复跑，Muse目标10-19，不因本轮重新排队 |
| 其他已交付积压 / 原逐项SHA / 原A-B | 已修W-START/W-FINISH/W1/H-LOAD-D1/F2-D1/HH0.1等原表已验证，hash未变复用；本轮无新health源码，不重复跑整套 | A实际SDK/action、来源整周保存回读、部署映射仍EVID-LIFE-001；L0.2平台前缀与任务绑定仍必要补证，不冒充已复现越权。L0.1指定四入口批准契约保持，B归档/owner视角材料不阻塞 |

### Bug单：沿原F0.4与HH0.2，不另造同义编号

**F0.4 · P0/A · 35ae750，finance server/actions.ts:522–568（读取链getDashboard:728起）。** 复现：用实际649b132旧模块的ingest，以synthetic三份余额-only月末快照＋全交易coverage保存旧payload（与上轮已确认输入相同），随后不重同步，直接用35ae750实际getDashboard读同一隔离库。新monthSchema缺字段默认false，但原integrity=complete被保留，normalizeFireMetrics→validCompleteMonths仍只检查integrity/异常。**实际**：三个新依据均false，FIRE completeMonthsUsed仍3；同一payload的客户端completeSpendBasis却usedMonths=0。**预期/用户影响**：升级后打开已有存档即按所需来源依据诚实降级；不能要求用户先成功同步才消除原错误完整月，不能FIRE/应急金对同一缺依据记录相互矛盾。不声称真实账户值已错。

**修法/固定判据**：沿原“旧blob兼容、依据绑定实际消费者”判据，在读取规范化和FIRE消费边界检查指标所需依据、同步规范完整性说明；不能只修aggregateMonths的新写入。不删存档、不伪造新来源依据、不改变余额事实或asOf。保留本轮新同步余额-only已修对照；原矩阵补实跑“旧版本实际写入→升级直接读→两个消费者”，无字段/显式false/合法有依据/真0/异常/当前partial与正常新同步，缺证明不进分母，原数值事实可读。首次发现01:07Z/原queuedAt未知，余项复验07:08:52Z，Muse目标10-18不变；不是重开已经修好的新同步输入例。

**HH0.2 · P0/A · 544af8f，house server/actions.ts:250–284、455–516及556–574。** 两个原矩阵复现：①新任务running，旧任务失败回调仍无任务/代次字段；实际handler赢claim后直接setRefreshState(error,null)，新running被结束。②确定性交错：A/B首读同一状态；A条件UPDATE赢并在report INSERT前暂停；B条件UPDATE零行，重读仍running且尚无新报告，incoming asOf晚于claim时刻，decide仍apply；B沿502–510“仍适用直接继续”插入并idle，随后A恢复也插入。**实际**：仅1次claim成功，但两个响应saved=3，report=2、listings=6；不需相同毫秒碰撞。**预期/影响**：旧失败不得结算新任务，竞争输家不能凭重读绕过排他；用户不能得到重复期报或把仍在进行的刷新误认失败。

**修法/固定判据**：沿18:07首次一次列齐的任务/刷新代次与原子保存/结算契约；成功和失败均回传本代标识并绑定状态，来源日期只能防倒退、不能替代任务身份。丢失claim无资格直接写；原子CAS/事务或等效唯一发布仲裁保护保存与最终状态，新代不被旧代结算。保留stale恢复、正常当前任务、串行重复和早于起点成功已修分项；实跑旧成功/旧失败→新running、两并发同回调、A赢后暂停/B输后重读/新代在A保存前启动、乱序asOf、失败/不足3套对照；旧/重复saved=0、行数与新task状态不变，当前一次完整发布并idle。不删报告、不扩大L0.1例外。原queuedAt未知/01:07Z发现、Muse目标10-18；交付在推进，不触发两轮无进展裁决。HH0.3原子可见性余项同app可合包，缺事务能力的真实卡点须说明可用API/失败证据与替代方案，而非停其他队列。

### 新需求单回应与具体产品推进

本轮不虚构新ID：**W4.3-D1（P1，既有训练方向，queuedAt=01:07Z、Muse10-19）**已收到回执交付并正式回应，范围/优先级/原矩阵不变；推进其已有“同源建议及可追溯回读”交互设计。**HH0.2/HH0.3（P0/A，Muse10-18）**推进既有报告保存/可用性方案，不开新系统/新数据源。两项均不以PM复验为实现依赖。

**训练与健康重点：把“本次已存好”和“下一次怎么练”的依据摆清楚，避免把组数变化包装成进步。** 回执先呈本次完成日期＋已完成/总组数＋未完成数；每动作一行“本次 n/m组 · 上次 n/m组（来源日期）”，同routine+key且目标版本可比才出现上次行。下面单独一行“下次建议（既有W1规则）：重量＋单位／数据不足”，所用依据为刚完成记录；若W1规则还需更早可比记录，沿既有候选选择并标来源日期/单位转换，缺候选不补0、不新造第二套公式。这是原W4.3-D1判据的布局/文案映射，不给已交付另加PR/评分/历史系统或返工矩阵。读回失败仅重读同ID，查看本次记录须按ID展开，不能把最近一条或缓存草稿当回执。健康首屏继续保持七日原始事实、来源与缺口，未获批新增readiness历史系统不开工；训练事实回执优先于扩大健康推断。

**看房既有范围的产品/保存方案：刷新期间整期旧报告继续可看，新报告验证完成后一次切换。** 用户只看到“正在核对，仍显示上一期（原日期）”；不足/重复/写入失败保留上一期并给只读刷新重试，重复或迟到回调不闪失败、不改日期。实现先核实builder现有原子事务能力；若不可用，可在同一已有存储采用“不可见候选报告＋完整房源先写好→单条带generation条件的发布指针切换”，getReport只读已发布指针且结算与指针同一CAS，候选中途失败不成为最新可见报告。代次标识在刷新发任务前建立、成功/失败均带回；重读不赋予失去claim者写资格。仅是HH0.3原子保存/HH0.2代次安全的可执行备选，不假定存在平台API。若需附加字段/migration则按A类给旧报告兼容、失败回读与保数据回滚，不删除用户历史。HH新候选仍遵守所有者暂缓决定。

### 验证、期限、补证与交接

- 交付脚本monthly57/57、facts84/84、payload12/12、color16/16、house44/44过；三笔逐段Gate分别6文件/2脚本/4实现、4/1/2、2/0/0全过，diff --check过。Gate不替代语义复验。
- PM独立**40项synthetic控制**通过（包含上述缺陷成功复现断言）。运行完整实际finance新/旧模块和house handler；受控Drizzle形adapter在SQLite `:memory:`执行原0002迁移与实际handler所发select/conditional update/insert，真实client completeSpendBasis。SDK/defineAction/Zod构造与默认字段解析由受控替身承接，未证明真实SDK请求/响应校验、Drizzle库生成SQL、React或artifact运行；没有生产探针、app.db访问、真实值/标识/日志输出。未收到W4.3-D1源码，不运行旧源码冒充该交付验证。
- 原方向期限保留：W1/H-LOAD 10-18（H-LOAD仍须已有历史能力范围/若须新系统则向所有者给具体方案），W4.3-D1及F2-D1父10-19，旧P1周上限10-20，W-UI父10-22；H/W两周期方案已经交过不重置。L1既有排程裁决保留不重复问，L1/H0/H1/F0/HH0明确可执行项持续推进。F0.5本体、HH0.3余项本次有逐ID顺延说明；其余统称“后续轮次”仍需逐ID真实原因/责任/日期，作为排期文档尾巴，不阻塞其他工作。
- W4.3-D1补实际源码/hash映射和原fixture复跑属于必要可复核交付材料；结构性owner截图非例行审批，B视口/归档尾巴不阻塞；精确artifact version不可得时用可验证部署引用/时间和源码hash/diff，不能杜撰编号。L0.2平台身份/有效任务绑定仅缺证据，不伪称新P0；L0.1已批四入口不再索同一批准。
- 本轮归并最老5a8aa17脱敏反馈流水：原“清除新披露真实运动统计、保留全部运动需求、不改历史/不把真实值改称synthetic”及34f216b/3767c92关闭事实已在顶层L0.4/AUDIT-03、批量表与后续记录保留，原运行补证仍在EVID；已关源码不重开。保留最近20条流水，全部未完固定判据/期限/发布事实持续保留。
- 无builder/invoke_action，不build/装依赖/改业务/schema/changes；临时synthetic工具清理，仅plans实质修改。提交前fetch动态核对增量、安全整合并发，正常commit/push main；PM-only Gate/最终SHA与远端一致性记automation memory。

## 2026-10-17 21:00 PDT PM 增量复验与产品推进

本节为21:00当时结论，后续以00:08最新表为准；截点2026-10-18T04:00:25Z。起始origin/main=`649b1323724597fb5a35de503311dcd548a3af65`；上轮源游标c65bea3后排除a4271a1（PM-only），新增逐笔为`954cfc60b706fc2807a27688bae488912a8c410c`（用户F-UI登记）、`649b1323724597fb5a35de503311dcd548a3af65`（财务交付）。先保护清洁main、fetch/安全ff，再读受影响finance AGENTS、完整增量和输入→owner门禁→保存/回读→两个计算消费者→页面链。仅plans有PM修改，所有验证数据明确synthetic。

### 用户可见增量、两项指标与上线事实

- **本轮已交付用户可见增量2项**：无依据月末/空快照和仅交易覆盖月中快照诚实降级；财务涨跌增加符号/文字、支出和贷款改中性呈现。按具体行为计，不是两项整体验收通过；PM流程文档增量0。
- **全队列中位等待不可计算**：旧项缺queuedAt、本批缺真实startedAt，不从Git时间反推。新增已开工完整样本n=0；可确认仍完全未开工且有queuedAt的子样本n=1，仅W4.3-D1，01:07:00Z→本截点等待**2小时53分25秒**，其中位数等于该值，不代表所有待办；F-UI缺精确queuedAt，已交付不混入未开工样本。历史W-FINISH n=1约21分钟仍只是历史开工样本。
- 主状态**已交付**。Muse在changes申报space-3 build/audit后上线；02:18:29Z是Git交付时间，不是独立submit生效时间。PM无builder/invoke_action，未独立核验部署引用/源码映射，所有者新增实际使用确认0，不写“已上线在用”。Life自检通过直接上线授权保持，PM结果不阻塞后续队列。

### 本批与存量逐项事后标注

| ID / SHA / 分级 | PM已验证 | 有问题与同队列去向 |
| --- | --- | --- |
| F0.4 / 649b132 / A | 真实完整ingest→隔离SQLite保存→getDashboard→实际computeFire/客户端completeSpendBasis：空entries有/无交易coverage均unknown、月中即使交易完整仍unknown；均不进两分母。当月partial、异常排除、非法日保留旧payload对照通过 | 上轮两个具体复现源码返工关闭；**原来源完整性问题仍有余项**：任意非空余额条目+月末日期+交易coverage仍提升整月complete，缺失收入/投入按0进入FIRE，沿原F0.4 P0继续，见下；非重开已修分项 |
| F-UI-001 / 954cfc6登记、649b132交付 / B | 实际trendIndicator正/负/0/null、4处调用和全部valueTone消费者已核对；涨跌有符号/文字，中性支出/贷款及负债标记接线通过，色板两token通过；交付16项脚本及build/audit声明支持 | 源码/脚本范围已验证，无新呈现缺陷。审计只到guest页，未证明owner看板像素效果，原owner视角材料属结构性B形式跟进，不重开源码/不阻塞；此纯呈现切片数据未变，对账不适用 |
| HH0.2 / c65bea3 / A | 复用18:07已过stale恢复、串行settled重复/迟到失败分项，hash未变不复跑 | **有问题：原新running收到旧成功/失败及并发重复P0未修**；Muse本轮明确顺延（同app财务构建自检耗时，责任Muse），目标10-18不变。原实际handler/内存SQLite反例、task/代次绑定+原子保存判据及HH0.3同包方案保留18:07节，不复制新bug |
| W4.3-D1 / 尚无新交付 / A+B | 原完成回执ID/交互/固定矩阵保留 | 待办，Muse明确本轮未动，目标10-19；不以财务或PM复验为技术依赖，未开工等待单列 |
| 其他已交付积压 / 原逐项SHA / 原A-B | W-START/W-FINISH/W1/F2-D1/H-LOAD-D1/HH0.1等已修源码按前表已验证，未变hash复用 | A真实SDK/action、保存回读及部署映射仍EVID-LIFE-001；L0.2真实调度/任务通道绑定材料未新增，归必要补证，不冒充已复现越权；B形式尾巴不阻塞，L0.1指定四入口例外不重开 |

### Bug单：原F0.4来源完整性P0余项；无新增独立编号

**F0.4（关联FIRE/F1.1）· P0/A · 649b132，finance server/actions.ts:363–389、501–527，client/App.tsx:141–149。** 复现：明确synthetic三个已结束月的合法月末快照，每月仅一条account余额，**不提供任何income/investment_contribution/transfer条目或其全月覆盖证明**；给交易覆盖完整的窗口及合法非异常支出。实际完整handler保存回读后三个月均complete/非异常，收入与投入均变0，FIRE completeMonthsUsed=3、annualContribution=0；真实completeSpendBasis也以同一全局complete计3。这不是发现账户真实财务值有误，而是证明无相应来源依据的缺失流量被升级为已知零和全月完整。**预期/影响**：交易覆盖只能支持其已声明范围的支出，不能证明月度收入/投入/余额来源齐全；用户会把缺失投入当作真实零投入，误信FIRE基础及“完整有效月”。

**修法和固定判据沿原单，不逐轮加码**：来源/窗口依据与实际指标消费者绑定，不以entries非空替代来源完整；现有来源不能证明就unknown/partial，保留原事实可读。FIRE所需支出与投入依赖必须均有依据，F1.1只认其支出所需依据；明确真0与未提供。上轮矩阵中的“来源全部有依据正常月/缺失/真0”已有此要求，本例把“非空但只含余额”具体化，不另加系统或强迫用户补数据。保留空/月中两已修对照，增加本例到原矩阵；真实ingest→保存→getDashboard→两个消费者断言无依据不进对应分母、真0须有来源依据，说明加法契约/旧payload unknown与保数据回滚。queuedAt仍缺失、发现时间保留01:07Z、余项复验04:00:25Z，Muse目标10-18；有明确修复进展，不构成同问题两轮无进展升级。F0.3日期/去重和已修源码不重开。

HH0.2 bug单全部字段、真实反例、用户影响、修法和一次列齐判据继续18:07节；本轮无新代码/新复现，不虚构额外缺陷。本次为发现后的首个无新修复跟进周期；若下一周期仍无进展，带“HH0.2/HH0.3同包优先落地或所有者明确接受暂缓”的具体排期方案升级，其他工作继续，不等待裁决。

### 新需求单与具体产品推进：推进F0.4/F0.5指标依据与缺口交互

**新需求单回应：F-UI-001 · 用户直提P1/B · 范围与优先级已在本周期正式回应，现已交付并完成上述分账；原10-18 08:39 PT周刷新前期限不变。** 本轮不另造同义需求；实质推进既有**F0.4/F0.5（P0/A）＋F1.1/FIRE**，Muse目标10-18，原queuedAt缺失及旧10-20周上限不重置。W4.3-D1继续10-19，不重置父期限。

**产品判断：余额已经可用，不应因月度证明不足让整个财务页不可用，也不能用一个“完整月”标签承诺所有指标。** 首片把“这项能否算/缺哪项”落在消费者旁边，复用现有月度记录展开区和F0.5来源覆盖，不建新系统、不改账户/不请求新数据权限。健康继续原始事实/来源与日期可信优先，训练推进真实完成回执；看房只修HH0，所有者暂缓新候选的决定不变。

| 指标/位置 | 首片设计与计算边界 | 缺口/操作 |
| --- | --- | --- |
| 本次净资产/余额差卡 | 继续按已读余额与原日期展示；余额是时点事实，不用它证明整月收入/投入。沿F2-D1区分同步读取与月快照 | 保持当前可用，失败保留旧日期与恢复入口，不让缺月流量吞掉余额卡 |
| 月度记录展开 | 显示所选日期、交易覆盖范围/声明的来源范围、收入/投入全月依据各自“有依据/部分/未提供”；无相应输入明确未提供，不由条目缺失推断0 | 首片复用已有展开，不引导手填真实账户值或强迫截图；缺证时解释具体缺项，重试走现有只读刷新 |
| FIRE | 首片保留原同一共同有效月窗口：所需支出/投入依据均满足才算，明确用了几个月；不要暗拆两套分母却仍称同一个完整月。源端无法证明则诚实降级 | 就近说明“缺支出覆盖/投入全月依据”等真实缺口，保留已有余额和月快照事实，缺失不填0 |
| 应急金/F1.1 | 最近三个支出依据完整且非异常月；不因无关收入/投入缺失拒绝已能证明的支出，也不因余额存在默认支出齐全 | 显示已满足n/3与真实缺项；不足不输出覆盖，确实0支出说明不能求覆盖，不显示无限或编造值 |
| 储蓄率/月收入 | 来源与同一窗口所需收入/支出任一缺失，不称完整月储蓄率；现有数值可作为截至该日的已记录事实，注明partial/unknown | 同一处展示截至日期/缺项文字，不能只靠颜色；不新增预测、买卖建议或自动账户操作 |

这是原F0.4“依据绑定实际消费指标”和F0.5逐源coverage的具体交互/契约方案，不是额外返工层或新方向。加法字段若影响action/payload即A类，真实schema默认/旧blob兼容与保存回读照旧；B呈现用build audit＋脚本，未变数据的呈现对账不适用。能证明的既有范围先交付，不能证明的明确降级，Muse不等PM批准或复验。

### 验证、期限与交接

- 交付脚本monthly53/53、color16/16、facts82/82、payload12/12全部过；Gate a4271a1→954cfc6（2文档/0脚本/0实现）、954cfc6→649b132与聚合（7文件/2脚本/5实现）均过，diff --check过。Gate仅自检，不覆盖上述语义缺陷。
- PM独立**56项synthetic控制**通过，含余项成功复现：完整实际finance模块/handler，受控Drizzle形状adapter在SQLite `:memory:`执行原0002迁移及真实保存SQL、真实客户端completeSpendBasis/trendIndicator；owner与无viewer/undefined/非owner三种拒绝身份的读/刷新/ingest对照零越权写。SDK/Zod链为stub，真实请求/响应校验、Drizzle库、React、artifact未实测，不伪称平台端到端成功。无生产探针、真实数据/标识输出或app.db访问。
- W1/H-LOAD方向原10-18、F2-D1父/W4.3-D1 10-19、旧P1 10-20上限、W-UI父10-22保留；H/W方向两周期方案已交不重置。L1旧排程裁决不重复，F0.4/HH0.2与L1/H0/H1/F0/HH0可执行项继续，逐ID真实耗时/责任/日期仍需说明，不把单app构建当永久包数限制。
- 流水仍只保留20条；最老5a8aa17 H-UNITS记录归并至顶层H-UNITS/H-SOURCE和18:07持久摘要。5a8aa17的第21条缺组/双计数与来源覆盖判据、a7595f3/3767c92后续关闭证据保留；真实整周producer→合法保存回读→今日/历史、legacy/真0/null/自重/混单位/缺组/超过20条矩阵及部署映射仍EVID，不因归并丢失或重开已修源码。
- 仅plans实质修改；无builder/invoke_action，不本地build/装依赖/访问app.db，不改业务/schema/changes。临时synthetic脚本清理；提交前fetch动态核对增量，正常push main、不强推或改历史，最终PM-only Gate/推送SHA记automation memory。

## 2026-10-17 18:07 PDT PM 增量复验与产品推进

本节为18:07当时结论，后续以21:00最新表为准；指标截点2026-10-18T01:07:00Z，fixture全部明确synthetic。责任方Muse；PM只改plans，不改业务/schema/changes。起始origin/main=`c65bea375023d020e2df3f154d3fa5efb128233b`；上轮源游标bb539fb之后排除136561b（PM-only），新增三笔全部枚举：`b65f18433c1bc8eb165be573e8d0d7f711f17fde`（训练）、`45647b3bd42526be33a8a5da6afeb20dbb20aa5f`（财务与补训练交接）、`c65bea375023d020e2df3f154d3fa5efb128233b`（看房）。

### 用户可见增量、等待时长与上线事实

- **本轮已交付用户可见增量7项**：训练接管后收敛同一可用记录；余额来源只数真实余额行；月度唯一快照/日期冲突保护及记录详情（同一增量含FIRE完整月消费）；应急金改用三完整有效月支出基础；看房空筛选hero；看房失联刷新可重试及串行重复回调忽略；看房写入口收紧/公开读隐藏taskId。这里数交付行为，不是7个整项验收通过；PM文档增量0。
- 主状态均为**已交付**。Muse在changes登记space-6/3/2已按builder构建审计后上线；Git提交时间分别22:31:49Z、22:31:49Z、00:34:00Z，不是独立核验的submit时间。本会话无实际builder/invoke_action，未独立确认最终生效版本/源码映射；所有者新增使用确认0，不写“已上线在用”。新发现严重问题按下列P0修复，不把整个队列改成等PM。
- **全队列中位等待时长不可计算**：口径仍为入队→开工，未开工用入队→本截点，分别统计；这三笔无真实startedAt，F0.3/F0.4/HH0.2等旧项缺原queuedAt，不能拿提交/修复时间回填。本轮新增可计算已开工样本n=0，历史W-FINISH n=1约21分钟仅留作历史样本；W-START/F2-D1已经交付，移出完全未开工样本。新W4.3-D1单独入队，不用其刚入队的0等待遮盖旧积压。

### 三笔交付全部事后标注

| ID / 交付SHA | 主状态 | A/B与PM已验证范围 | 有问题与同队列去向 |
| --- | --- | --- | --- |
| W-START-001 / W0.4 · b65f184 | 已交付 | A真实完整handler与条件SQL在隔离SQLite执行：原接管DELETE0行（A恢复并写草稿）、两等待者同过期父行均只剩一个ready且成功响应指向同一记录，失败可重试；草稿与历史保护、原初始化失败/未完成保护结论复用 | 原源码竞态返工关闭；实际SDK/Drizzle实现、owner多端与0003平台迁移仍EVID-LIFE-001，不因缺页面材料重开P0 |
| F1.2 / F2.1-D1 · 45647b3 | 已交付 | A实际ingest→保存→getDashboard→真实balanceSourceSummary：余额全同步读取时只计1个，插入收入/支出摘要不变，无余额写未提供；B不凭live声称本周实时 | 原来源P1源码返工关闭，首卡数值/比较/四态沿已过hash复用；F0.5逐源时间仍原待办 |
| F0.3 · 45647b3 | 已交付 | A真实handler保存回读验证非法日和同日冲突保留旧payload及日期、返回error；50项交付脚本覆盖同月唯一最新、相同去重、闰日/顺序/latestRaw同源 | 规范化源码分项已验证；实际schema/action校验与旧blob兼容仍EVID，不以字符串检查冒充真实SDK |
| F0.4 / F1.1完整月消费切片 · 45647b3 | 已交付 | A当月partial、无证明unknown和排除分母接线，B月度详情与不足三个月缺口已交付；源码新增字段默认unknown，无DB迁移 | **有问题：F0.4完整性判据仍错误**，月末文件名/仅交易coverage被当作全月事实完整；影响FIRE与应急金消费，沿原P0继续，见下 |
| HH0.1 / AUDIT-04 · c65bea3 | 已交付 | B filtered[0]无全局回退，空hero无地址/链接/月供；36项脚本及Muse构建审计公开页切城市/空筛选探针作支持 | 原源码缺陷关闭，无新缺陷；PM未自行驱动浏览器，不伪称独立视口实测。无数据变更，对账不适用 |
| HH0.2 / AUDIT-05 · c65bea3 | 已交付 | A真实getReport把过期running映射error、实际refreshReport允许重试；串行settled重复成功/迟到失败不再重复写或改状态 | 原永久running源码分项关闭；**有问题：运行中的旧回调与并发重复仍覆盖/重复保存**，沿HH0.2 P0继续，见下 |
| L0.2 · c65bea3 | 已交付 | A源码先拒绝非owner/非指定前缀写，独立真实handler的非owner/无viewer普通通道三action零写；公开读taskId为null | 有问题（必要运行补证），非已复现越权：space-action-/space-task-return-由平台铸造/校验且绑定本app、预期action及有效任务的说法只有builder说明。沿EVID补真实调度→回传的脱敏身份/任务范围和状态回idle证据；不宣称已完成受信callback验收，不扩大L0.1批准的四入口例外，也不要求重复批准 |

未变H-LOAD-D1/W-UI-D1/W-TIMER/W-FINISH/W1及旧批量表的分项结论复用，所有已交付项已经事后标注；A必要补证列EVID，B归档/视口形式尾巴不阻塞。源码已修项不因无owner截图重开。

### Bug单：原F0.4与HH0.2两项P0/A继续

- **F0.4（关联F1.1/FIRE）· P0/A数据口径 · 45647b3，finance server/actions.ts:363–373、494–518；client/App.tsx:134–143。** 复现一：合法synthetic三份较旧的月末日期文件，entries均为空、无coverage，通过真实ingest保存并getDashboard回读，三个月全部integrity=complete、非异常，FIRE completeMonthsUsed=3，真实completeSpendBasis也计3。复现二：仅月中日期的收入/存款快照，另给当月完整transactions覆盖及非异常支出，仍标整月complete并纳入FIRE。实际把“文件日期为月末”或“交易窗口完整”升级成收入、投入、余额等整份快照完整；输入没有这些来源全月覆盖证明。预期日期本身不证明覆盖，交易完整只能支持对应交易支出事实，不能证明月中余额/收入为完整月。用户影响是缺失或半月事实参与长期目标与现金覆盖基准，页面仍称完整且有效月。**修法**：沿原F0.4把完整性依据绑定实际消费指标与来源/窗口；无证明保持unknown/partial，旧值可看事实，不能仅凭月末日期补complete。真正可证明覆盖通过明确附加契约提供，旧payload默认unknown；FIRE和F1.1只消费其所需完整依据，不把未提供当0。**固定验证判据**：保留首次月度矩阵，加以此具体化原“完整须有来源覆盖依据”：空entries/月末但无覆盖、仅交易完整+月中其他来源、来源全部有依据的正常月、partial/unknown/异常/真0/不足3月；真实ingest→隔离保存→getDashboard→computeFire/completeSpendBasis同输入对账；无依据不计分母、日期/数据不伪进展，旧blob与保数据回滚。原queuedAt缺失，不重新排队；发现2026-10-18T01:07:00Z，Muse目标10-18，原旧P1周上限10-20不延后。F0.3已修日期/去重不重开。
- **HH0.2（关联AUDIT-05）· P0/A管道/存档 · c65bea3，house server/actions.ts:244、429–466。** 真实handler+隔离SQLite复现：先保存较新报告，启动下一刷新进入running；旧任务较早asOf成功回调此时被decideIngestCallback无条件apply，插入更高id的旧报告，getReport按id取最新而显示倒退，refresh被置idle/清taskId；旧失败回调同样会把新running改error。另在running下两个同一成功回调并发进入，均读到旧状态并各插入一份，形成重复报告。预期旧/重复任务不得改变新刷新状态或替换较新可见报告；重试必须可达，成功/失败属于对应刷新。影响用户看到过期房源、误以为新刷新完成/失败，原幂等callback判据尚未达到。**修法**：沿原HH0.2用可验证任务/刷新代次或等效令牌绑定回传，来源日期防倒退；检查与保存/结算须原子或等效唯一仲裁，不能仅靠读state后分支；保留当前公开读与写权限契约，不删除用户报告。**固定验证判据**：首次stale/幂等矩阵具体覆盖旧成功/旧失败落在新running、顺序及并发重复、乱序asOf、超时重试、当前任务成功/失败/不足3套对照；重复saved=0且报告行数/当前状态/可见版本不变，旧回调不能结算新任务，正常新结果一次保存且回idle。与HH0.3报告+房源原子保存同app打包可行，不以PM复验为依赖。原queuedAt未知，发现2026-10-18T01:07:00Z，Muse目标10-18；本次首次独立复验，不是两轮无进展裁决。

### 新需求单与具体产品推进：W4.3-D1 训练完成回执

**W4.3-D1 · P1 · 待办 · queuedAt=2026-10-18T01:07:00Z，startedAt未开始；Muse目标10-19交付。** 承接既有W4.3训练结束总结、W0.5未完成诚实呈现和W1共享建议，既有方向内的小增量，可直接入队实现，无需新方向拍板。父W4.3原入队时间缺失/10-20既有周上限不重置，原W-UI父10-22仍保留。

产品判断：训练保存、结束屏障和单active已有源码闭环；现在结束后直接回到通用开始页/历史列表，用户还要自己寻找“刚才是否真的存好”。健康七日条已经提供原始事实，此时优先让训练记录有可追溯的结束结果，不扩展readiness评分、PR引擎或新联动。财务继续修完整性，不等整套F0结束才做独立训练体验；看房只修既有HH0正确性，新候选仍遵守所有者暂缓决定。

| 阶段/边界 | 交互与事实契约 |
| --- | --- |
| complete响应成功后、回读尚未结束 | 显示“训练已结束，正在读取记录”，用这次workoutId定位，不能用草稿组数提前声称已存多少组；回读失败显示可重试“记录暂未读出”，不再发complete、不把已结束记录恢复active |
| 同一ID已完成记录读回 | 开始页顶部非阻断回执显示训练日、实际完成日期、已完成/总组数；未完成仍明确n组未完成，真0与缺失分开。提供“查看本次记录”直接展开对应历史行，用户不用翻找；关闭回执不写业务数据，刷新后恢复策略明示，不把任意最近一条误当本次 |
| 每动作对比 | 只展示本次与最近一次更早同routine含同动作记录的已完成/总组数、实际来源日期；缺该动作/目标版本不兼容则写暂无可比记录。首片不加总吨位比较、不称“进步”、不把未完成组补0；同名不同key不混同 |
| 下次建议 | 复用W1现有候选/规则及单位口径，明确针对刚结束记录；没有可靠输入写数据不足，不在回执复制一套阈值、不自动开新训练/改计划。与周复盘同源，不以健康readiness替代训练事实 |

一次列齐验证：全完成、确认带未完成结束、complete失败/成功后读回失败重试、重复点击、返回期间新增另一训练、同一/不同routine缺动作、无上次记录、跨单位、历史第21条/最近20截断、用户关闭/刷新回执；真实已完成ID保存回读与两处建议一致，不能从缓存首行或旧草稿伪造成功；手机长动作名/三视口键盘收起后可达。优先复用现有历史数据/返回契约；若recent20不足以定位，按owner-only最小只读补齐，说明附加响应兼容，不新增数据源或表、不放宽例外。A记录/建议口径须真实handler synthetic验证，B呈现凭构建审计＋脚本；无数据改动部分对账不适用。PM复验不是实现/上线的前置条件。

### PM反馈、期限与次要跟进

- 本轮交付脚本start66/finish98/progression57/facts-card82/monthly50/payload12/house36均退出0。聚合Gate136561b→c65bea3为15files/5scripts/12implementation通过；训练单笔136561b→b65f184失败（缺changes），证据已在下一笔45647b3补齐，合包136561b→45647b3为11/4/8通过，后两笔单独Gate9/3/6、6/1/4均通过，diff检查通过。训练证据跨提交尾巴如实记录，不拿聚合结果谎称逐笔全过，不重开源码。
- PM独立**65项synthetic控制断言**通过，含成功复现bug，不是65项验收全过。完整实际三app server模块/handler、真实客户端来源摘要/三月基础函数，在受控Drizzle形状adapter上执行原迁移于SQLite `:memory:`、FK ON；训练actual条件SQL执行，非业务循环镜像。SDK/Zod链为明确stub，未证明实际请求/响应校验、Drizzle库、React或artifact运行。临时工具首跑finance样例支出导致既有异常门槛、第二次house样例URL被生产Redfin白名单过滤，读真实规则后修正fixture，通过后扩至65；非产品缺陷、未改业务代码。
- F0.4新增响应字段/默认值属A实际数据契约，不能按B表格schema形式豁免。旧blob真实默认解析、owner ingest→回读及最终上线源码映射仍EVID-LIFE-001；house新通道契约待真实调度/回传核验，不捏造平台能力；不把缺证据直接当越权漏洞。结构性owner截图不作例行审批，B形式不阻塞，L0.1批准四入口不重开。
- W1/H-LOAD-D1原10-18、F2-D1父10-19、旧P1周上限10-20、W-UI父10-22均保留；已修源码分项不再排返工。L1旧排程争议保留原裁决请求、不重复提问，其余L1/H0/H1/F0/HH0可执行队列继续。Muse末条把其他app整体顺延的理由仍需补逐ID真实耗时/责任/日期，属排程尾巴，不制造技术或验收依赖。
- 为保留20条流水，移除最老561d1d5旧记录：其923417c换算/缺组及561d1d5独立来源交付事实，后续5a8aa17/a7595f3修复与16项真实handler控制已在顶层H-UNITS/H-SOURCE及批量表保留；H-SOURCE五状态真实handler/schema隔离和H-UNITS来源整周→合法保存回读→双消费点同窗对账仍未完成、归EVID。保留原null/真0/legacy、混单位/缺weight/reps/自重、coverage/超过20条矩阵与部署映射，不因流水清理丢失或重开已修源码。
- 干净main安全fetch/ff后审受影响三app AGENTS及调用链；无本地build/安装/访问app.db，无业务数据或真实个人值输出。仅plans实质修改，临时工具清理；提交前再fetch保护并发，正常push main，不强推/改历史。PM-only Gate/推送最终SHA记automation memory。

## 2026-10-17 15:03 PDT PM 增量复验与产品推进

本节为15:03当时结论，后续以21:00最新表为准；交付SHA/原判据保留。指标截点2026-10-17T22:03:25Z；全部验证fixture明确synthetic，责任方Muse，PM只维护plans。

### 用户可见增量、等待时长与上线事实

- **本轮已交付用户可见行为增量6项**：开始失败可清理重试且不再成功返回初始化空记录；结束等待最终组注册；跨全局20条窗口的建议与预填同源；财务无可读数据时的诚实恢复入口；首条余额差事实卡；七日事实区分LA当日/未来与已结束日。按六项具体行为计，开始接管和余额来源仍有下列问题，不能称六项需求整体验证完毕。PM文档产品增量0。
- **全队列中位等待不可计算**：仍缺本批真实startedAt及部分旧项queuedAt，不能把Git/上线申报时间反推开工。新增完整开工样本0；历史完整样本n=1仍仅W-FINISH，09:51:44Z→10:13Z约21分钟，不是总体中位数。F2.1-D1已有交付，移出完全未开工样本；旧可算完全未开工样本n=0。F0.3/F0.4是既有需求细化，保留原缺失时间，不拿本轮设计时间重置等待。
- 起始origin/main及源游标`bb539fb68a1e61a55155020bb30203e2cedaa05c`。上轮源`5992544`之后先是`bcc0bfa5a8b52c8ab1193fd6f109debee459584b`（PM-only，已在上轮审完），本轮新增逐笔为`fe004d24cd7ede2ec0208d9413533aae1f5b94cf`、`f5917b8bc3ca25c4695e51551ccdc53b79e24683`、`d2df20dad4b542b1b6f42a18973db8b79660fb3d`、`bb539fb68a1e61a55155020bb30203e2cedaa05c`。清洁main安全ff；提交文件和四段Gate全部枚举，无漏审。
- Muse在changes申报space-6、space-3、space-4经build/audit后已上线；Git交付时间分别20:21:35Z、20:21:56Z、20:33:46Z、20:43:24Z，**这些是Git时间，不是独立submit生效时间**。本会话无builder/invoke_action，未独立观察最终版本/源码映射，新增所有者实际打开确认0；PM主状态均记**已交付**，不伪称已上线在用。常规Life直接上线授权保持，无需等PM。

### 全部新增交付事后结案

| ID / SHA | 主状态 | PM已验证分项（源码/受控实际函数） | 问题与去向 |
| --- | --- | --- | --- |
| W-START-001 / W0.4 · fe004d2 | 已交付 | A历史查询失败清理后实际重试恢复；新鲜初始化阻塞时返回明确重试错误，原请求恢复后唯一ready，成功有完整组 | 有问题：超时接管失去删除竞争、两个等待者遇同一残留均能产生双ready，原P0继续；原空返回/历史失败分项关闭 |
| W-FINISH-001 / W0.5 / W-UI-001 · fe004d2 | 已交付 | A真实加组落库，最终dashboard IDs与延迟handle注册屏障使直接结束进入incomplete；注册始终缺失时两结束路径均中止、保留active；确认路径等注册后才能完成 | 上轮pending-add/注册窗口源码返工关闭；原保存/失败恢复/seal检查复用。实际SDK/React调度/owner运行仍EVID补证，不重开P0 |
| W1-CONSISTENCY-001 / W1.1–W1.4 · d2df20d | 已交付 | A同一内存库执行真实getDashboard→review与start：全局第21条卧推两端105lb；候选按routine20条同源，旧服务缺字段回退保留 | 上轮跨窗口源码返工关闭；原额外组/null/跨单位矩阵57/57复用并通过；实际SDK附加响应/线上读回仍EVID |
| F0.2 · f5917b8 | 已交付 | A无值error与有值error诚实区分，B顶部/空态/页脚/恢复入口接线；原typed损坏恢复链未改、复用上轮已验证分项 | 上轮无值却称显示上次数据的源码返工关闭；四态运行及真实schema仍EVID，不因缺截图重开源码 |
| F1.2 / F2.1-D1 · f5917b8 | 已交付 | A正负/真0/null、与既有净资产同公式、连续producer对比；B比较对象日期未留存/非固定间隔/失败保留旧日期文案 | 有问题：来源统计消费全accounts，将收入/固定支出等计为余额账户；沿F2.1-D1 P1修，首卡其余分项保留 |
| H-LOAD-001-D1 · bb539fb | 已交付 | A实际函数LA昨天通过、今天/未来警告保留原值，真0与全局coverage独立；LA午夜/DST脚本通过；无服务端/公式/管道变更 | 上轮日期边界源码返工关闭，非七日readiness历史交付；B owner页面与发布源码映射沿EVID，不作门控 |

### Bug单：一项原P0继续、一项真实P1来源缺陷

- **W-START-001 · P0/A · fe004d2，当前server/actions.ts:881–910（消失分支:900）。** 复现1：实际A已写完组、停在ready UPDATE前，其started_at已超过30秒；B有界轮询耗尽并决定takeover，在B条件DELETE执行前恢复A，使A变ready并经实际updateSet写入synthetic草稿。B的DELETE匹配0行，却无条件break→自身ready；A/B均成功返回16组且最终两条ready active，A草稿保留但dashboard只选B。复现2：同一过期初始化父行，B/C两个真实start都完成自己的组并读到该父；一方删除残留，另一方轮询读到消失，分别进入takeover/proceed-self，最终两个不同可用active。实际违反原“同一可用目标/唯一active”，影响多端或慢初始化后的训练可达性，不声称已删除用户数据。修法：接管/消失后重新参与全体active仲裁，并把“是否可成为唯一ready”作为原子条件或等效串行化；不能以一次条件DELETE或30秒年龄证明拿到唯一资格，也不能无条件补删已可见/已编辑/已完成记录。固定原并发/失败矩阵具体涵盖这两个调度及删除0行、多个竞争者、原请求恢复/完成/放弃对照；每次成功必须可读写且只留下一个usable active，失败可重试。原queuedAt=2026-10-17T13:00:07Z、startedAt缺失、目标10-17、Muse；不重置。历史读取失败/新鲜等待/旧已完成保护等已修分项不重开。每轮有实际修复进展，不新增“两轮无进展”裁决。
- **F2.1-D1（同F1.2首卡）· P1/A来源口径 · f5917b8 finance client/App.tsx:114–120、382；producer server/actions.ts:425–435。** synthetic合法producer输入一个可实时匹配的存款账户，另有收入与固定支出条目；buildDashboard.accounts保留三种类型，净资产只消费account/investment，但balanceSourceSummary全量计数，首卡称“1个实时账户、2个月度账户”。实际全部余额账户均为live；预期余额来源只统计实际净资产组成，不把收入/支出/转账/投入当账户或余额覆盖。影响用户误判数据是否新鲜/哪些余额回退，普通P1而非数据丢失P0。修法：同一净资产组成选择器/显式type过滤驱动来源摘要，保持数值公式；无余额来源写未提供，混合只数真实余额行，成功读取与数据日期分开。缺逐源成功时间时不由live布尔位保证“本周实时”，沿已有asOf说明同步读取/快照回退；真正逐源时钟仍属既有F0.5，不能编造。验证一次列齐：纯余额全live/全fallback/混合、插入任意非余额条目摘要不变、无余额但有收入、空列表、旧数据刷新失败；以真实buildDashboard→首卡调用者运行，而非手工传两个live布尔值。原queuedAt=2026-10-17T19:05:00Z保留，startedAt缺，本缺陷发现22:03:25Z，Muse目标10-18（父切片原10-19不延后）。

### 新需求单与产品推进：细化既有F0.3/F0.4月度事实基础

**产品判断：首条余额事实卡已交，下一步优先让财务月度事实可被信任，再消费到现金覆盖/支出摘要。** 健康D1已诚实展示完整日原值，训练D1继续把唯一训练与结束可靠性放首位；本轮不再扩健康评分或训练分析。财务现有aggregateMonths仍把同月两个日期画作两个月份，真实函数也接受会滚动到下月的非法日；这些是既有F0.3问题的独立确认，不另造bug编号。看房HH0正确性队列继续，新候选仍按所有者决定暂缓。

**F0.3 / F0.4 · 既有P0/A范围细化；F1.1、F2.1其余摘要消费它，不等PM复验。** 原入队日期/缺失queuedAt保持，Muse目标10-18交付可用切片，旧10-20上限不变；这是一组现有财务事实与交互设计，不是新方向/系统。

| 输入事实 | 选择与消费 | 页面表达/交互 |
| --- | --- | --- |
| 同月多个合法日期 | 严格真实日历校验后按自然月分组，每月只取最新有效日期的一份快照；所有月图、latestRaw余额回退、FIRE和摘要消费同一规范化选择，不能各自再排rawMonths | 每月一个点，标“快照截至日期”；展开可看使用哪日及该月替代快照数，无需展示真实账户标识 |
| 非法日期/同日重复 | 无效日不滚动成别日、不成为latestRaw；完全相同快照去重，同日冲突不能静默挑一份或求和，返回明确输入问题并保留上次合法看板 | 更新失败解释日期/冲突类别与可重试路径，不回显原payload；既有合法数据和日期不推进，其他独立工作继续 |
| 当月、已结束月、旧payload | 当月一定partial；已结束不自动证明来源完整，完整状态必须有相应来源/日期覆盖依据；无证明为unknown，不能把“月已结束”当complete。日期/完整性可用附加契约表达，旧payload诚实unknown，不能伪回填 | 月度栏显示“截至… · 部分/完整/完整性未提供”，用户展开看来源覆盖、异常原因；无完整依据的旧值仍能看事实，不假称完整月 |
| 用于支出/FIRE/现金覆盖 | partial/unknown/异常月不进入“完整且有效月”分母；F1.1按原近3个有效完整月平均支出，实际不足时说明缺几月、暂不输出覆盖，不用0顶替；F2现金/支出摘要只在各自真实依赖满足时出现 | 首条余额卡继续可用；缺比较基础时写事实性缺口，禁止以不完整月推算月末支出、FIRE承诺或自动理财建议 |

固定判据沿F0.3/F0.4并具体化：日期乱序/同月多日/跨月、闰日与非法日、同日相同/冲突、latestRaw与图表同源、当月partial/结束但coverage未知/可证明完整、旧payload未知、全无效时保留旧数据；完整性/异常排除后FIRE及F1.1实际分母可核对，0与缺失分开。以合法synthetic输入跑真实ingest→持久化→getDashboard→呈现，说明附加schema/旧blob兼容与保数据回滚；这些是A数据契约，不能以B表格/静态字符串断言关单。B布局仍用build audit＋脚本，未变数据的呈现对账不适用。不增加账户操作、外发或新发布目标。

### PM反馈、期限与次要跟进

- 原W1/H-LOAD-D1 10-18、F2-D1 10-19、旧P1 10-20、W-UI父10-22期限保持；对应已修源码已标验证，实际运行仅EVID分账。原H/W方向两周期方案已给出且D1交付，不重置10-15周期。L1原排期裁决仍保留、不重复同一问询；L1/H0/H1/F0/HH0明确可执行项继续，不能用当前热修整包挤掉而不注明逐ID真实耗时/责任/日期，缺排程说明仍是文档尾巴。
- 本轮8组交付检查退出0：finish98/98、progression57/57、autosave69/69、D1 35/35、rest48/48、facts-card55/55、payload12/12、seven-day52/52；聚合Gate bcc0bfa→bb539fb为11files/4scripts/9implementation，四笔逐段Gate均过，diff检查过。未变hash已过检查复用，不重复旧缺依赖命令。
- PM独立**44项synthetic控制断言**通过，包含成功复现问题，不等于44项验收全过。完整实际workout server模块/真实handler与raw SQL，受控Drizzle形状查询adapter执行原0002+0003迁移在SQLite `:memory:`、FK ON；客户端真实结束函数配可控注册延迟/查询，真实历史producer→页面建议/预填；health真实日期函数；finance真实buildDashboard→来源摘要/差额。SDK/Zod以明确链式stub替代，未运行真实SDK请求/响应校验、Drizzle实现、React scheduler或artifact；不得冒充线上结果。首跑临时harness引用0003文件名不符，按实际文件名更正后完成；仅测试工具修正。
- EVID-LIFE-001保持A真实SDK/action/0003平台迁移/owner保存回读、最终部署引用和源码映射原范围；结构性owner视角不作上线审批，B形式缺口次要跟进。health changes称独立sevenDayBoundary helper，仓库等价逻辑实际在sevenDayFacts内，功能52/52已证；记录非逐字映射尾巴，不重开源码。W1附加optional comparable_history无DB迁移，旧消费者忽略/旧服务回退；不能用附加schema静态兼容假称实际action通过。指定L0.1例外维持且未扩展。
- 为保留20条流水，最老3b26882记录归并到持久条目：L1-RACE-001双路严格>原子保存、同版本同内容duplicate/不同内容conflict、旧值ignored/null不覆盖、拒写无saved/invalidate及读取开始时刻契约源码已关闭，42交付＋84独立控制证据仍保留此摘要和顶层条目。原未完成证据为真实schema/action双路倒序/重复/冲突拒写后保存回读与台账不变、旧格式、实际agent读源前定版本、可复核artifact/发布引用/最终hash及匹配页面；仅隔离synthetic，禁止生产写探针。不能因移除旧流水丢失这些判据或重开已关闭源码。
- 无builder/invoke_action；未本地build/安装依赖/访问app.db或修改业务/schema/changes。仅plans有实质变更；临时控制脚本验证后清理，提交前再次fetch动态核对。PM-only Gate及正常push结果记automation memory，不强推、不改历史。

## 2026-10-17 12:05 PDT PM 增量复验与产品推进

本节为12:05当时结论；后续以15:03最新表为准，交付SHA和原固定判据继续保留。指标截点2026-10-17T19:05:00Z；全部验证输入明确synthetic，责任方Muse，PM仅改plans。

### 用户可见增量、等待时长与上线事实

- **本轮已交付用户可见行为增量7项**：七日原始事实条、开始初始化隔离、结束等待在途加组、按动作回退历史、财务损坏typed错误/合法同步恢复、顶部完成数与保存聚合、动作折叠与Enter移焦。按七个可描述行为计，不按提交/整单关闭数计；其中边界问题见下表，不宣称整项全修。PM文档与计划的用户可见产品增量0。
- **全队列中位等待不可计算**：queuedAt→startedAt为开工等待，尚未开工才用queuedAt→本截点。本批各项缺真实startedAt，不能用上线申报/Git提交反推；旧L1/H/F/HH部分queuedAt也缺失。本轮新增完整开工样本0；历史完整样本n=1仍为W-FINISH（09:51:44Z→10:13Z）约21分钟，不代表总体。H-LOAD-D1已交付，移出“完全未开工”样本，不能继续累计其等待；旧完全未开工可算样本现为0。F2.1-D1本截点新入队、尚无开工时间，与旧样本分列，不拿刚入队的0分钟粉饰积压。
- 起始远端`5992544712cfe5eb5bbdaf224091e949bb083b11`；上轮源`42ef240`之后依次为`60318484bb40efccb903bd79d081075dabdfc1d7`（PM-only）、`0a2780360acd413271eeef77e7b0e380159ccfce`、`4fe7b0b443966f1ffc4e7728cdfb8a9d6e8a6611`、`0852b0d19857c75cf5c5c3a241baf64978756928`（登记）、`b0103590c8b75589471e9a933bd761cbdc091cc9`、`f2f042ed0239dc131bb17ec7a04ee732dd57d078`、`5992544`。清洁main安全快进，逐笔Gate通过；PM和登记提交不计产品增量。
- changes申报space-4七日事实、space-6安全返工及D1、space-3财务已上线，D1给出build引用`e738ffbc`；Git交付时间分别为16:24:46Z、16:27:14Z、18:31:33Z、18:45:16Z，末笔18:51:40Z仅仓库保真补丁、未再动线上。build引用比以往有进展，但不是最终源码字节一致或owner打开证明。本会话没有builder/invoke_action，**PM主状态记已交付，新增所有者使用确认0**，不能写已上线在用；不重复请求普通Life发布批准。

### 全部新增交付事后结案

| ID / SHA | 主状态 | PM已验证分项 | 问题与固定去向 |
| --- | --- | --- | --- |
| H-LOAD-001-D1 · 0a27803 | 已交付 | A原值：四指标/单位、7格日历、真0/缺失、重复冲突、全局coverage诚实；B切换/详情接线 | 有问题：存在当日行不等于完整日，见原ID P1；无单日来源/时间时诚实说明已验证，非七日readiness评分 |
| W-START-001 / W0.4 · 4fe7b0b | 已交付 | A正常结算只有一条ready；初始化行不进入dashboard/写目标；加组初始化失败清理；0003使旧记录默认ready且保留历史 | 有问题：让位可返回尚未ready的空目标，history读取异常可留下永久争用目标；原P0继续，旧可见记录误删/双ready分项不重开 |
| W-FINISH-001 / W0.5 · 4fe7b0b | 已交付 | A实际handleFinish等待加组promise；在途抛错中止；新handle已注册时会显示incomplete确认 | 有问题：query重取结束未证明React已提交并注册新组，原pending-add/注册判据继续P0；单写/失败恢复/稳定seal已修分项保留 |
| W1-CONSISTENCY-001 / W1.1–W1.4 · 4fe7b0b | 已交付 | A同20条输入内，最新push缺卧推时两端现在均回退旧卧推并建议105lb；纯规则/额外未完成组结论复用 | 有问题：服务端同routine20条与页面全局20条不等，原超20边界继续P1 |
| F0.2 · b010359 | 已交付 | A真实getDashboard损坏返回typed error；真实合法ingest覆盖后可回读，坏prior不制造余额差；非owner零DB访问 | P0 JSON崩溃源码子项关闭；有问题：data=null仍显示上次数据/首次同步，普通P1状态文案继续原ID；实际SDK/schema运行补证归EVID |
| W-UI-001-D1 / W-UI-001 · f2f042e、5992544 | 已交付 | A聚合优先级、pending/finishing不假saved；B手选动作保留、hidden不卸载、Enter链/异常入口、取消焦点恢复接线及保真修订 | 无新增源码缺陷；已验证限真实纯函数和接线。owner训练中真实交互未观察，A必要运行缺证EVID，B归档形式次要跟进，不重开源码 |
| plans登记 · 0852b0d | 已交付（文档） | B保留交付与PM结论分账，未代PM勾选 | 无业务/数据变更，对账不适用；不计可见产品增量 |

### Bug单：5个原ID继续（2项P0、3项P1），不另堆重复编号

以下是源码/受控函数反例，非线上事故声明。原要求的明确执行方式一次列齐；不是因缺截图重开已修源码。

- **W-START-001 · P0/A · 4fe7b0b server/actions.ts:575、616–689。** 复现1：A插入initializing=1后停在history查询，B完整执行start，让位删除自己的初始化行后loadWorkout(A)直接返回成功，含0组；真实dashboard此时active=null，complete(A)拒绝。A恢复后才ready。复现2：history读取在:575抛错（尚未进入:616的try），A初始化行残留；下一次正常start让位该残留并返回空训练，dashboard仍无active，重复重试不能恢复。实际为成功响应不可用/恢复卡住；预期原“同一有效可用目标、初始化失败可重试”，不能仅最终id相同。影响用户双击/多端开始及暂时数据库失败后的训练可用性。修法：初始化失败覆盖从父行创建到history/组写入/ready的完整区间；让位必须等可用目标或返回明确可重试态，并允许安全接管失败初始化，不能删可见/编辑/已完成记录。固定验证含A暂停→B返回时的真实组/可读写、A失败→B/重试、组写失败、完成/放弃交错及原并发全矩阵；成功不能返回不可用记录。queuedAt13:00:07Z不变，startedAt缺，Muse，目标10-17。0003保留列只证明结构兼容；若回滚旧代码会忽略flag而暴露残留初始化行，不能只以“旧代码忽略列”宣称行为安全，需builder保数据回滚说明，不自动删除用户记录。 **（实现方返工交付登记 2026-10-17 13:21 PDT：已在 artifact（space-6）上线并回灌本仓，commit fe004d2——初始化全程（history 读取/组写入/冲突复查/ready 翻转）纳入统一失败清理 cleanupOwnInitializing，任一步抛错条件删除自己的 initializing 行后原样抛错；让位改为 resolveYieldDecision 按对方状态决策：对方 ready 才返回对方，仍 initializing 则有界轮询等待其 ready/消失（消失则自己翻转 ready），超时且对方 started_at 超 30 秒视为失败残留、条件删除后接管，超时且仍新鲜则回收自己并抛「另一场训练正在初始化，请稍后重试」可重试错误，成功永不返回未 ready 训练。validate-finish 更新至 98/98 含五类纯决策矩阵。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **W-FINISH-001 · P0/A · 4fe7b0b及5992544 client/App.tsx:1370–1389、1576–1586、1655–1699、1731。** 原反例的promise部分已修；新旧同一注册窗口继续：真实addSet已落库新增incomplete组，重取query已返回但React提交/SetRow effect注册延迟；pending promise结算并注销，settlePendingAdds让出一次宏任务后仍为空；真实handleFinish只见旧全完成handle并调用真实complete，最终history含新未完成组却无确认。PM以可控注册延迟执行此序列；未声称已跑React scheduler。预期按原“最终组集合一致”等待对应数据版本的组ID均注册/核对后才决策，不能把invalidateQueries resolve或setTimeout(0)当挂载确认。影响仍是静默跳过加组后的未完成确认；无数据删除结论。修法沿既有pending-add＋预期组集合屏障，两结束路径保持失败恢复和无晚写；固定矩阵加入的只是原注册延迟场景具体调度，同时保留promise拒绝/新组已注册对照。queuedAt09:51:44Z、startedAt10:13Z不变，Muse，目标10-17。 **（实现方返工交付登记 2026-10-17 13:21 PDT：已在 artifact（space-6）上线并回灌本仓，commit fe004d2——新增导出纯函数 waitForExpectedSetRegistration 轮询 handle 注册表直到 expectedIds 全覆盖（耗尽返回 missing），两条结束路径在 settlePendingAdds 后、flush/seal 前用 fetchQuery 取最新 dashboard 组 id 作 expectedIds 过同一屏障，屏障失败中止结束、不调用 complete、解锁并显示失败、草稿保留。validate-finish 98/98、注册专项 116/116。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **W1-CONSISTENCY-001 · P1/A · 4fe7b0b server/actions.ts:409–448 / getDashboard:479–484 / client:386–436、2026。** synthetic全局第21次是push卧推4组100lb×8全完成；最近20次仅一条push不含卧推，其余pull。真实getDashboard全局20条不含卧推，reviewRecommendation无可比建议；真实start(push)查询同routine20条包含全局第21条并预填105lb。原“最新训练缺动作”在窗口内已修，跨窗口仍分歧；影响下次建议与实际预填不可信。修法统一两端实际历史窗口/动作候选来源与排序，不能只在两个不同输入的数组各slice(20)；明确截断时无建议或同源依据。固定原超20/缺动作/额外组/跨单位/null矩阵不变，以getDashboard→review与实际start同一数据库执行。queuedAt13:00:07Z不变，startedAt缺，Muse，目标10-18。 **（实现方跨窗口返工交付登记 2026-10-17 13:32 PDT：已在 artifact（space-6）上线并回灌本仓——服务端抽出单一原始候选选择 selectComparableHistory（同 routine 最近 20 次逐动作最近可比记录、全部组、来源原值），预填经 selectPreviousSetsByExercise 在其上换算（行为不变），getDashboard 新增可选 comparable_history（三个 routine 同源、来源单位原值），客户端 reviewRecommendation 优先 comparable_history、缺失才回退全局扫描；validate-progression 57/57 含同库同数据双端同结论用例：全局第 21 位才是 push 卧推可比记录时两端同为增至 105lb，旧矩阵（窗口内缺动作/额外未完成组/跨单位/null/窗口外）不回退；其余 validate 回归全过（autosave 69、d1 35、finish 98、rest-timer 48），构建审计 pass。此登记仅表示已交付，PM 结论以评审记录为准。）** **（实现方返工交付登记 2026-10-17 13:33 PDT：已在 artifact（space-6）上线并回灌本仓，commit d2df20d——服务端抽单一原始候选选择 selectComparableHistory（同 routine 20 次内逐动作最近含该动作训练的全部组），start 预填基于它换算；getDashboard 新增可选 comparable_history 逐 routine/动作给出同源候选，客户端 reviewRecommendation 优先用它、同候选同规则，缺失才回退旧扫描。validate-progression 更新至 57/57，含全局第 21 位反例双端同结论（均建议 105lb）。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **H-LOAD-001-D1 · P1/A日期口径 · 0a27803 health App.tsx:678–726，重点721。** 合法日期字符串＋该日有一行被当作boundaryOk=true；给LA当日或未来日期的synthetic row均无日期边界警告。server daily/dataDate schema只校验日期格式，normalize无完整日校验；同步prompt要求最新完整日，不能替代消费边界。预期原“当日未完整明示”涵盖此情形；现在有行并不证明一天已结束。影响将当天partial/错误未来日期表现为完整7日窗口。修法以LA当前日期核对dataDate确实为已结束日，或使用可验证完整日依据；不把全局coverage伪造逐日完整，不新建数据管道。一次列齐固定判据：LA午夜前后/跨DST、今天有行、未来、无效/缺末日、真实昨天、真0及冲突控制；边界不足保留可见原值与警告，不算完整趋势。本轮发现于19:05Z，父queuedAt13:00:07Z不重置，Muse，目标10-18。 **（实现方返工交付登记 2026-10-17 13:21 PDT：已在 artifact（space-4）上线并回灌本仓——sevenDayFacts 新增 todayLa 入参（客户端 Intl 按 America/Los_Angeles 计算、纯函数不读时钟），boundaryOk 仅当 dataDate 有行且严格早于 LA 今天；等于今天给 partial 提示、未来日期给异常提示，非法/无行提示保留，逐日原值仍呈现。validate-seven-day-facts 更新至 52/52（LA 午夜/DST 取值＋删门槛变异），其余回归全过。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **F0.2 · P1/A状态诚实、B文案 · b010359 finance client/App.tsx:463、481–491。** 实际corrupt handler返回data=null/status=error/message损坏可恢复；原UI状态表达式却输出“显示上次数据”，空区按钮“开始首次同步”、页脚“尚未完成首次更新”。实际没有可展示旧值却声称正在显示，损坏与从未同步混淆；影响恢复信任，P0解析崩溃已关闭、不升级文案为P0。修法复用既有typed状态/安全message区分无可读快照、从未同步、有旧值且本轮刷新失败；无数据时“数据暂不可用，重新更新”，不回显payload/余额，不给损坏账户操作建议。固定四态对照（初次空、有值正常、有旧值刷新失败、损坏无值）及失败/恢复入口；真实schema和artifact补证沿EVID。queuedAt旧F0.2缺失如实保留，本轮发现19:05Z，Muse，目标10-18。
 **（实现方返工交付登记 2026-10-17 13:21 PDT：已在 artifact（space-3）上线并回灌本仓，commit f5917b8——状态区/空态/页脚以 typed 状态严格四态：从未同步维持首次文案、有数据正常「数据已同步」、有旧值刷新失败保留「显示上次数据」、data=null 且 error 改「数据暂不可用」＋按钮「重新更新」，不回显 payload/余额；与 F2.1-D1 事实卡同批交付，validate-facts-card 55/55。此登记仅表示已交付，PM 结论以评审记录为准。）**

### 新需求单与具体产品推进：F1.2 / F2.1-D1 首条余额事实卡

**F2.1-D1 · P1 · queuedAt=2026-10-17T19:05:00Z，Muse目标10-19。（实现方交付 2026-10-17：已在 artifact（space-3）上线并回灌本仓——`DashboardView` 顶部新增「本次余额差」事实卡，与净资产区共用 `weeklyDeltaView(live.weeklyDelta, …)` 同一数值/百分比口径；null 差额显示「暂无可比快照」不画 0/0%，旧值刷新失败标注「本次未更新」且不推进 `asOf`，来源行分列 `asOf`/`sourceMonth`/live-fallback 混合（缺失写「未提供」）；同批交付 F0.2 状态诚实 P1 四态文案。新增 `weekly-finance/validate-facts-card.mjs` 55/55、既有 `validate-payload.mjs` 12/12 回归全过，构建审计 pass（非 owner 视角，owner 呈现以所有者打开为准）。F2.1 其余两条摘要（现金覆盖变化、当月支出进度）未在本切片交付，父项 `F2.1` 保持未勾选。此注仅表示已交付，PM 结论以评审记录为准。）** 这是既有F2.1首屏事实摘要与F1.2“本次余额差”的同一交付切片，两个ID共享实现/判据，不另做一套计算。既有健康D1/训练D1已交，财务F0.2恢复打通，产品判断是先让用户一眼知道“这次变化与什么比、数据到哪天”，减少首屏语义歧义。无需等F0.3–F0.5全部复验；不引入新系统、账户操作或新发布目标。

| 状态 | 首条事实卡设计 | 现有事实/验证依据 |
| --- | --- | --- |
| 当前与prior均合法 | 标题“本次余额差”，显示既有live.weeklyDelta及正负/持平文字；不称固定一周、不归因为市场/投入/消费 | 沿既有净资产差公式；当前日期用asOf，上次日期若接口未保留明确“上次成功快照，日期未留存”，不得编造7天窗口 |
| 首次或prior损坏 | “暂无可比快照”；当前合法值仍可展示，差值为null，不用0/0%代替 | F0.2合法恢复后weeklyDelta=null是正确事实，不能画成持平；腐坏原值不进卡片/日志 |
| 有合法旧数据、刷新失败 | 卡片保留旧值/真实asOf并显式“本次未更新”，按钮沿现有重新更新 | 与无可读payload状态分开；不因刷新尝试推进数据日期/假称全源更新 |
| 日期/来源说明 | 卡片下区分当前asOf、月度sourceMonth及live/fallback混合来源；有缺失就写未提供 | 不从sourceMonth猜测Plaid刷新时间；不在此切片新增完整月、现金覆盖或FIRE估算 |

首卡成功判据一次列齐：正/负/真实0/null差额、prior损坏恢复、连续两次合法同步、旧值刷新失败、asOf与sourceMonth不同、来源未齐；值与原净资产明细一致，副标题不再暗示“每周固定间隔”。B布局使用既有手机/桌面build audit＋呈现脚本；A读取/差额/恢复用明确synthetic合法schema保存回读，不靠真实金融数值截图。F2.1其余现金覆盖/当月支出摘要仅在各自真实数据依赖F1.1/F0.3–F0.5满足时消费，独立首卡先交；这是技术依赖，不是等待PM。

健康产品取舍维持：七日原值用于解释已有来源与缺口，先补完整日边界；不为填满七点评分新增历史库/回填readiness。训练产品取舍维持：已有状态条/折叠/移焦优先保证训练持续可用与结束事实，不扩W3分析系统。看房HH0原正确性队列继续，新候选暂缓保持所有者决定，不因财务首卡停其他执行项。

### PM反馈、期限、证据尾巴

- 两个训练P0按10-17热修，三个P1原/新具体子项10-18；F2.1-D1 10-19，F1/F2父队列原10-20周上限与W-UI父10-22不延长。H/W方向提案已于本轮前给出且现已收到D1实现，原10-15方向周期不重置。L1/H0/H1/HH0未有新交付，原L1两轮无进展排期裁决请求保留，不重复索同一批准；其余能执行的继续。各旧项逐ID实际耗时原因/责任方/日期仍由Muse补，证据文档优先级，不以整包“占满”替代真实单项说明。
- 交付脚本实际结果：finish76/76、progression47/47、D1 35/35、autosave69/69、rest-timer48/48、seven-day35/35、finance-payload12/12均通过；聚合Gate6031848→5992544（16files/5scripts/14implementation）与六笔逐段Gate/diff检查均过。未变健康同步/公式/隐私关闭分项复用旧hash检查，不跑缺依赖旧命令。
- PM独立**59项synthetic断言**：当前真实server模块/客户端结束与建议函数、0002+0003在SQLite `:memory:`（FK ON）；Drizzle形状adapter生成受控查询并执行实际handler raw SQL。覆盖初始化暂停/失败/重试、旧记录迁移保留、15项写入口非owner零DB、真实两端历史窗口/原反例、真实加组落库→延迟注册→完成、promise失败/已注册对照、D1聚合/当前动作/焦点；finance真实getDashboard→ingest→回读及6权限控制，但finance safeParse为明确受控schema stub。health日期/零/重复冲突使用实际七日函数。断言通过包含反例成功复现，**不是59项验收通过**；无真实SDK/request-response schema/Drizzle实现/React scheduler/artifact运行成功声明。
- 本轮唯一实际schema变更0003属A，不能按表格格式B类关闭。默认0的结构兼容经内存库控制通过；平台migration应用仅changes摘要，不代PM实测；初始化残留与保数据回滚已转W-START问题。EVID-LIFE-001沿原范围补实际SDK/迁移/action/owner保存回读/最终部署引用及源码映射，缺证不伪装P0。结构性owner截图与B归档不阻塞，也不要求用户例行审批；D1已有build引用保留，不编造version。
- 本会话无builder/invoke_action，未本地build/安装依赖/访问app.db/读真实值或日志。未改业务代码/schema/changes/数据；临时PM合成控制脚本验证后清理。本批每个问题都有已修进展，不满足同一真实问题连续两轮无进展的新增升级条件；已批准L0.1四入口例外不重开。提交前fetch动态核对，PM文档Gate与正常push结果记录memory。

## 2026-10-17 09:03 PDT PM 增量复验与产品推进

本节为09:03当时结论；后续交付以12:05最新表为准，原固定判据保留。指标截点2026-10-17T16:03:27Z，所有复现数据明确synthetic；责任方Muse，PM只维护plans。

### 用户可见增量、等待时长与上线事实

- 起始origin/main及本轮源游标：`42ef240602fb1d9e03e88078a5fd6b35fea9d98e`。旧源游标`3cb7d84`后逐笔枚举`8a472f976455e3190dbfad591bd0c085bcd3f8a4`（PM-only，不算业务交付）和`42ef240`（5文件单批）；清洁main安全快进，未遗漏增量。
- **交付的用户可见行为增量4项**：完成后晚到写被拒绝；冲突回收保护已完成记录；结束时输入锁定与新handle稳定seal；额外未完成组使预填与复盘同为保持。这里计具体已交付行为，不计整单关闭数；三处剩余边界如下，不能用这4项宣称四单全修。PM方案/流程文档增量0。
- **全队列等待中位数不可计算**。本批四项有交付登记而缺真实startedAt，不能以07:22上线登记或14:29:58Z Git提交冒充开工。历史具完整时间的已开工样本仍n=1（W-FINISH-001，09:51:44Z→10:13Z），约21分钟；这是既有样本，本轮新增完整开工样本0。**可计算的完全未开工样本n=1：H-LOAD-001-D1，等待约3小时3分钟**（13:00:07Z→16:03:27Z，3:03:20）；只代表该样本，不能代表全队列。W-UI-D1已有子范围交付，排除于完全未开工样本；旧L1/H/F/HH缺精确queuedAt不混入。
- Muse在plans登记07:22 PDT已上线space-6，Git提交14:29:58Z（07:29:58 PDT）；changes有build/audit及回灌说明，未提供可独立核对的submit引用/最终源码映射。本会话无builder/invoke_action，**PM主状态记已交付，新增所有者实际打开确认0**，不伪称已上线在用。常规Life直接上线授权保持；存档风险优先热修，确需回滚按既有builder授权保数据执行，不自动删用户记录。

### 本批全部范围事后结案（A类；源码结论与运行证据分账）

| ID / 交付SHA | 主状态 | PM已验证分项 | 问题及去向 |
| --- | --- | --- | --- |
| W-ACTIVE-001 / W0.3 / AUDIT-09 · 42ef240 | 已交付 | 实际handler的UPDATE…EXISTS、INSERT…SELECT、条件DELETE在完成抢先时均零写拒绝；正常写/加组及完成后内容保留；声明FK cascade下本体/组整体删除及重复拒绝 | 原三竞态源码返工关闭；真实SDK映射、平台FK生效/失败回读仍EVID-LIFE-001/W0.3，有问题（补证），不把缺证重开成P0 |
| W-START-001 / W0.4 · 42ef240 | 进行中 | 原“B已完成后被让位删除”反例已修，完整记录/组保留 | 有问题：B已编辑但未完成时回收失败返回B，同时A返回A，两个可用active持续存在，沿原ID修 |
| W-FINISH-001 / W-UI-001 / W0.5 · 42ef240 | 进行中 | 直接结束先seal，complete等待中finishing不解锁；throw/ok:false恢复编辑；确认过程中新增handle被下一轮seal后才complete | 有问题：已发出但尚未注册的addSet不在结束边界，沿原ID修；先前单写/失败恢复等已修结论保持 |
| W1-CONSISTENCY-001 / W1.1–W1.4 · 42ef240 | 进行中 | 4组完成＋第5组未完成：真实review保持100lb、真实start预填100lb；全4组完成对照两边105lb | 有问题：最新同routine训练缺动作，预填只看该训练而复盘遍历旧训练，沿原ID修；换算/规则函数未改不重复审 |

所有A类实际schema/action/owner读回/最终部署对应仍按原EVID-LIFE-001固定要求补能取得的证据；结构性缺owner截图不是审批，不重复既有L0/L1身份矩阵或已批准内部只读例外。B位置/截图格式缺口不阻塞。

### Bug单：既有3项继续，无新增独立编号、无新增返工口径

以下均为42ef240真实函数/handler执行，网络、注册表、Drizzle形状adapter受控，原迁移仅用于SQLite `:memory:`并开启声明FK；不是线上事故声明，也不是SDK/React/artifact实测。三项均有修复进展，不触发“两轮同问题无进展”重复裁决。

- **W-START-001 · P0/A · server/actions.ts:495–602，重点570–597**。复现：A/B start均读空；A插入id1后暂停，B插入id2及初始组后暂停最终active查询；真实getDashboard取B，真实updateSet保存B某组合成120lb×9（不complete）；恢复B，条件reclaim发现edited而零删，返回B；恢复A，返回A。实际结算后仍两条active、两个调用返回不同id；预期原固定判据“任一读取时刻至结算后只有一个可用active，两个start返回同一有效目标，且不删可见/编辑/已完成记录”。影响：用户跨页/双设备继续记录到不同训练，健康同步和下次恢复选中对象不稳定。**保住已完成/编辑记录的本次修复已验证，不允许以恢复无条件删除来解决。** 修法沿原范围：原子唯一active或不可见初始化/串行创建契约；若需schema/migration，按A兼容和保数据回滚交接。原完整矩阵（错序、初始化失败重试、start途中读、写/完成/放弃交错）原样保留，本次edited分支是原矩阵的具体执行。queuedAt仍13:00:07Z，startedAt未登记，进行中，Muse，目标10-17。
- **W-FINISH-001 · P0/A · client/App.tsx:1178–1184、1389–1419、1430–1446**。复现：已有注册组均完成/已保存；真实addSet在SQLite成功新增一组completed=false，延迟其返回和query失效/React注册；此时调用真实handleFinish。实际旧handle集合flush稳定后直接complete，真实completeWorkout成功，新增未完成组成为历史，未显示“还有未完成组”确认；addSet响应随后才回来。预期原“覆盖在途addSet、注册变化、一致最新组集合”判据：结束前收敛已发add并刷新/登记，按最终集合决定确认；若add失败，明确失败而非默认成功。影响：用户点加组后直接结束，被静默跳过未完成组确认；本次未证明数据删除，严重度沿既有存档边界P0不升级。修法：共用可等待的pending-add边界，锁住新操作同时join旧请求和对应数据版本，然后稳定flush/seal；仅disabled按钮与检查当前handle稳定均不覆盖已发请求。两条结束路径及原cancel/throw/ok:false/legacy/无晚写矩阵不变；本轮锁定、mid-seal已修部分关闭。queuedAt仍09:51:44Z、原startedAt10:13Z，进行中，Muse，目标10-17。
- **W1-CONSISTENCY-001 · P1/A · server/actions.ts:363–395、508–543 / client/App.tsx:386–419**。复现：较旧已结束push有卧推4组synthetic100lb×8全完成；最新已结束push只含另一动作、无卧推。真实getDashboard的recent_workouts包含两条；reviewRecommendation遍历到旧卧推给“下次105lb”，真实startWorkout只取最新同routine训练，卧推history为空，实际预填weight/reps=null。预期同一历史/目标单位/范围的可见建议与预填选同一可比记录，找不到就两边一致说明；影响为用户仍收到互相矛盾的“下次”信息。修法沿原范围统一调用者选择（按动作取最近合法可比记录或两边一致使用同routine最新，须明确依据日期/范围，不另立算法），不能只改plannedSets。原“最近训练缺该动作/历史超20条/额外组/缺失/null/跨单位”固定矩阵全部保留；当前额外未完成组反例关闭，不反复返工。queuedAt仍13:00:07Z，startedAt缺失，进行中，Muse，目标10-18。

### 新需求单与具体产品推进：推进现有D1，不堆同义需求

**W-UI-001-D1 · P1 · 现有训练交互的实现细化，本轮方案已交付，产品实现仍进行中，Muse目标10-18。** **（实现方交付登记 2026-10-17 11:25 PDT：已在 artifact（space-6，build e738ffbc）上线并回灌本仓——顶部状态条「已完成 x / y 组」与保存聚合分离（aggregateSaveStates 固定优先级 error＞blocked＞dirty＞saving＞finishing＞adding＞saved、仅 error/blocked 带「查看」定位首个异常组）、resolveCurrentExerciseKey 单展开（manual 优先、折叠 hidden 不卸载 SetRow）、buildFocusOrder/nextFocusTarget Enter 焦点链（先 blur 保存、末位回结束按钮）；validate-d1 34/34。此登记仅表示已交付，PM 结论以评审记录为准；审计捕获无进行中训练，训练中页面运行证据归 EVID-LIFE-001。）** 原queuedAt09:51:44Z、父需求10-15及W2.2的10-20周上限不重置。产品判断：训练已有计时/换算/锁定，却仍缺用户能一眼判断的“完成多少、保存怎样、加组是否落地”；继续同一训练页做清楚这三件事，不增加系统或发布目标。以下落在原顶部聚合/焦点/折叠及结束状态范围，作为一次列齐的具体映射，原判据不加码。

| 页面/状态 | 明确交互与文字 | 沿用的状态与边界 |
| --- | --- | --- |
| 顶部完成数 | “已完成 x / y 组”独立于保存提示；已完成但缺次数仍显示需补次数 | 不把勾完成当已保存；新增组仅在服务端确认并进入当前数据版本后进入y，pending-add另示“正在添加一组” |
| 保存聚合 | error优先“有n组保存失败，查看”；其次dirty/blocked“有未保存修改/需补次数”；其次saving“正在保存”；全干净才“全部已保存” | 从现有handle状态/blocked聚合，异常入口定位并展开首个异常动作；pending-add或结束处理中不显示“全部已保存”作可结束承诺 |
| 当前动作与切卡 | 初次默认首个未完成动作；手动选择后保留选择，不因保存回调/计时tick自动跳走；全部完成保留最近动作 | 折叠隐藏但不卸载SetRow、不注销handle；卡头保留完成数及文字异常，计时锚点跟随同一个当前动作 |
| 键盘下一项 | 重量→本组次数→下一组重量，当前动作末组到下一动作首输入并展开；未填写可留空 | Enter先走原blur保存，不自动完成组；最后输入收键盘回到结束入口，已存在的dirty/error仍留文字提醒 |
| 结束/返回 | 结束处理中显示“正在结束…”，不重入；pending-add收敛后再用最终组集合显示直接结束或原确认；取消确认恢复原动作/焦点 | 失败按原runComplete恢复草稿和编辑；焦点/布局B，保存/加组/结束行为A，采用原固定slow/error/collapse/viewport矩阵 |

**H-LOAD-001-D1 · P1 · 七日事实条字段映射细化，本轮方案已交付，产品待办，Muse目标10-18。** 当前健康提供来源/历史但无逐日readiness评分；原始事实能先给用户解释依据，仍不能冒充七日恢复分。映射只用已有合法historyDaily：exerciseMinutes→运动分钟（默认）、steps→步、hrvMs→ms、restingHr→bpm；以合法dataDate结尾的LA完整日历7格，点击日格仅展开该日原值/单位/来源及更新时间。无值画缺口，真0有效；同日重复且不同值先标冲突/不可用，不无依据求和或挑更大的值；相同记录去重，x/7按合法非缺失日计。dataDate若当日未完整或无效，明示日期边界未满足，不悄悄当完整趋势。以上实现原duplicate/partial/LA边界判据，不新增后台数据管道。睡眠只在既有normalize能证明实际core+deep+REM与对应结束日期时开放选项，legacy totalHours口径不清先不开放该选项，其他指标继续。全局coverageIncomplete不能捏造逐日完整，来源缺口提示及单一同步入口沿原方案。原10-15方向周期与10-18版本目标均不变。

财务当前未新增交付，继续F0.2–F0.5的数据可用性/完整月与F1语义修复后再落F2事实摘要；看房HH0筛选/刷新/事务正确性仍在原队列，看房新候选暂缓决定保持。该取舍依据现有产品进度，不替所有者批准新方向，也不以训练返工暂停健康/财务/看房其他可执行工作。

### PM反馈、方向期限及验证边界

- L1/H0/H1/F0/F1/HH0仍无本轮业务交付；此前L1两轮无进展的排期裁决请求及“现授权按P0直接推进”保持，不重复索要同一决定。changes仍未逐ID给这些项真实耗时原因/责任人/日期，本次只补了两个D1与共用责任方；作为证据/排程尾巴记录，Muse补逐项日期，不作为PM前置。10-18 D1/建议目标、10-20旧P1周上限、10-22 W-UI父项上限不自动延长；目前未过周上限。
- 本批交付回归finish45/45、autosave69/69、progression34/34、rest-timer48/48通过；Gate `8a472f9→42ef240`通过（5files/1script/3implementation），diff检查通过。未变的健康函数和计时数学复用前轮检查，不跑无关全仓/已知缺依赖命令。
- PM独立执行**40项synthetic断言**：真实server模块handlers＋当前客户端结束/建议函数；Drizzle形状受控adapter执行真实raw SQL及原0002迁移到SQLite `:memory:`（FK ON），包括三旧竞态/串行已完成拒绝、正常写/加组、complete/discard双向、级联清理失败、15项非owner写入口拒绝、两种并发start、真实两端建议、结束锁定/失败/mid-seal、真实addSet落库后延迟返回再结束。断言通过意为反例或对照被执行，非40项产品验收通过；首次测试桩的同毫秒排序与projection Date转换已修正并独立加断言，最终40项全过。不是实际SDK/request schema/Drizzle SQL生成/React/owner artifact验证，缺口继续EVID-LIFE-001。
- 无生产数据/日志探针、无本地build/依赖安装/app.db访问，PM不改业务源码/schema/changes。原schema/migration本批无变更，raw SQL时间单位与timestamp_ms/boolean显式对应；运行FK/SDK事实仍不可由本地控制替代。changes的回滚说明保留，不能删除现有记录来达成单active。临时PM脚本本轮清理；提交前再fetch核对并发，PM文档Gate通过后正常push main，结果记memory。

## 2026-10-17 06:00 PDT PM 增量复验与产品推进

本节为06:00当时结论；后续交付以09:03最新表为准，原固定判据仍保留。queuedAt截点 `2026-10-17T13:00:07Z`；责任方均为Muse，PM仅改plans，不修改业务代码/数据。

### 用户可见增量、队列等待与发布事实

- 本轮起始远端 `3cb7d84c1dd2e25d4a9d3326381fe068e9ec34c2`；源游标 `309d9a7` 后完整枚举：`24216ff`（上轮PM文档，排除）、`e2137e03d936098bfc59c0ebfde0e1c2138e2142`、`3cb7d84c1dd2e25d4a9d3326381fe068e9ec34c2`。安全快进清洁main，逐笔检查diff/changes/调用链，没有漏审交付。
- **用户可见增量5项（已交付行为，非验收通过数）**：结束失败可恢复且确认结束等待在途写；串行调用拒绝已结束训练目标；预填/复盘采用同一决策函数；跨单位预填及历史换算；本次自动休息计时开关和当前动作卡位置。并发启动尚不满足W0.4，不另计成功增量；下述并发/实际输入缺陷不因计数被隐去。PM文档增量0。
- **等待中位数：有完整时间的已开工样本n=1，约21分钟**。仅W-FINISH-001：queuedAt=09:51:44Z→startedAt=10:13Z（Muse记03:13 PDT，精度到分钟），名义差21分16秒，故不报秒级精度。W1/计时包有startedAt=12:13Z但无原queuedAt，排除；W0.3/W0.4等旧项缺精确queuedAt，不能代替成该包开始时间。**全队列已开工中位数、未开工中位数仍不可计算**：多数旧条目缺queuedAt/startedAt；D1已有共享计时子范围交付，不能把整项混入“完全未开工”。新入队项记录本截点，未开工按queuedAt→当前时点单独统计；不把本轮刚入队的零等待伪称全队列改善。
- Muse报告两包已在space-6上线：03:24 PDT、05:31 PDT登记（对应Git提交03:25/05:30 PDT，后者登记分钟略晚于提交，保留差异，不推断实际submit先后）。本会话无Muse builder/invoke_action，未独立确认submit/最终生效版本；主状态为已交付，**新增所有者实际使用确认0**。没有真实用户数据或生产写探针。常规Life上线授权仍生效，严重存档风险由Muse按既有授权优先热修；若无法及时热修，评估通过builder回滚本次相关行为，保留既有数据，不授权删除记录。

### 本批逐项事后结案

| 需求/交付 | 主状态 | PM标注与结案去向 |
| --- | --- | --- |
| W-FINISH-001 / W-UI-001保存分项 · e2137e0 | 进行中（修复已交付） | A：已验证原确认结束等待已注册在途写、complete抛错/ok:false后解封并可再次保存；新注册组在flush期间被纳入的原反例通过。仍有问题：直接结束未锁写、确认等待期间新增handle漏查，沿W-FINISH-001原判据返工；旧单写/拒绝/回退源码结论保持 |
| W0.3 / AUDIT-09 · e2137e0 | 已交付 | A：串行目标不存在/已完成拒绝及严格owner写入口已验证；有问题：检查/写入非原子，W-ACTIVE-001 |
| W0.4 / AUDIT-09 · e2137e0 | 已交付（应用层让位） | A：有问题：瞬时双active可被读取，已完成的后插入训练仍会被让位删除，W-START-001；不把“数据库唯一约束未做”降为无影响文档尾巴 |
| W0.5 · e2137e0 / 3cb7d84登记 | 已交付 | A：完成/未完成/受阻判定、完成数提示和complete不伪造组数据分项已验证；结束并发缺口归W-FINISH-001，不另造同义bug；实际合法owner保存回读沿EVID-LIFE-001/W-UI |
| W1.1/W1.2 / AUDIT-10 · 3cb7d84 | 已交付 | A：同一输入的双端函数34项分项已验证；有问题：真实调用者喂入不同组集合，新增组反例复现，W1-CONSISTENCY-001；不能以纯函数副本相等关闭整项 |
| W1.3/W1.4 · 3cb7d84 | 已交付 | A：换算常数/0.5舍入、null/自重/完整训练量口径分项已验证；建议调用者一致性同上。转换标记实际页面消费仍归EVID-LIFE-001/W1，不将附加响应字段当持久字段；无DB schema/migration，响应新增可选字段旧客户端兼容 |
| W-TIMER-001/W2.1 · 3cb7d84 | 已交付 | A交互+B位置：原关闭/当前卡位置缺口源码结案，48项通过；关闭不取消正在计时，开启本身不启动。后台/声音实际运行补证沿EVID-LIFE-001/W-TIMER，B视口归档次要跟进；不重开未变化的截止时间数学 |
| W-UI-001-D1 · 3cb7d84局部 | 进行中 | 计时开关/卡内锚点子范围已交付；顶部保存聚合、展开折叠、键盘焦点仍待办，10-18不变；最终当前动作依手动选择优先，切卡不得卸载SetRow |

### Bug单（全部明确可执行，不等待PM复验）

以下仅synthetic值/受控时序；是抽取真实handler/函数执行，DB adapter、网络、注册表受控，未运行真实SDK/schema、React或artifact，不宣称线上已发生数据丢失。整批四个问题均首次获得本次具体反例，有修复进展，不按同一问题连续两轮无进展升级。

- **`W-ACTIVE-001` · P0/A · W0.3/AUDIT-09**：`e2137e0`引入检查、`3cb7d84`现行；server/actions.ts updateSet:560–585、addSet:601–630、discardWorkout:683–695。复现：真实handler读到active，暂停于第一笔update/insert/delete前，另一合法owner调用真实completeWorkout成功，再恢复原handler。实际三者仍成功：改写历史组、向历史加组、或把已结束训练及其组删除；预期完成状态提交后该目标禁止继续写/删。影响为跨页/双设备/晚到请求破坏存档。修法：把active归属判定与修改放进平台支持的同一原子操作/事务；删除必须保护本体和组整体，不是仅给最后一步加条件。首次固定矩阵：上述三时序＋正常active/不存在/已完成/guest/匿名、complete与discard双向交错、返回受影响行数与实际读回一致；无合法更新成功后又被静默删除、失败不得留下半删记录。实际SDK/保存回读按原A类自检。queuedAt=2026-10-17T13:00:07Z，待办，Muse，目标10-17；和下条同类包优先修。**（实现方交付登记 2026-10-17 07:22 PDT：已在 artifact（space-6）上线并回灌本仓——updateSet 改单条 UPDATE…EXISTS 守卫、addSet 改 INSERT…SELECT 守卫、discardWorkout 改先条件 DELETE 本体成功才删组，守卫不通过均零写入；validate-finish 更新至 45/45 含新原子接线断言。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **`W-START-001` · P0/A · W0.4/AUDIT-09**：`e2137e0`，现行server/actions.ts:516–535。复现：A/B start预检查都为空；A先插入id=1后暂停，B插id=2和组后暂停在最终active查询；这时真实getDashboard返回active B和已插入的组，真实updateSet录组并completeWorkout完成B；恢复B，查询只见active A，yield分支无条件删除B及其已保存组。实际返回A且B存档消失；预期任何可被使用/已完成记录不可被“冲突清理”删除、任何读取时刻最多一个可使用active。影响为并发启动造成用户数据丢失。修法：用平台支持的原子唯一active/事务或不可见的安全初始化契约；冲突回收不能删可见/已有用户写入/已完成的训练。首次固定矩阵：双start错序、失败初始化/重试、start途中getDashboard、组写入/完成/放弃与让位交错；验证无双可用active、无已保存/已完成记录丢失，两个start返回同一有效目标。schema/migration若需变更按A类兼容/保数据回滚完整交接。queuedAt=2026-10-17T13:00:07Z，待办，Muse，目标10-17。**（实现方交付登记 2026-10-17 07:22 PDT：已在 artifact（space-6）上线并回灌本仓——让位回收改单语句条件 DELETE（仍活跃、无组被用户改过、组数等于初始插入数；纯函数镜像 canReclaimYieldedWorkout），回收失败零删除并返回该训练本身，已保存/已完成记录不丢；validate-finish 45/45 含回收矩阵四例。此登记仅表示已交付，PM 结论以评审记录为准。）** **（实现方返工交付登记 2026-10-17 09:27 PDT：已在 artifact（space-6）上线并回灌本仓，commit 4fe7b0b——改为不可见初始化契约：新增 initializing 列（migration 0003，默认 0 旧行 ready），initializing 期间 getDashboard/updateSet/addSet/completeWorkout/discardWorkout 全部排除该训练（不可见零写），初始化失败自删重试，置 ready 前复查冲突、更早者优先、单条条件 UPDATE/DELETE 收敛，双 start 返回同一目标；validate-finish 76/76 含双 start 错序模拟。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **`W-FINISH-001` · P0/A · 既有单继续返工**：原三处已修分项如上，不重开。`e2137e0`至`3cb7d84` App.tsx:1352–1375及输入/加组接线：真实handleFinish进入complete等待时没有seal，行输入和加组也未锁；在等待期间编辑，队列仍发update，业务拒绝留下error，但complete可成功并卸载，未提示刚输入丢失。另真实confirmFinishAnyway只捕获一次handles；第一个sealAndSettle等待在途写时注册新dirty组，恢复后complete照常执行，新组未sealed/未检查。预期结束提交有一致的输入/注册表边界，保留或明确弃改所有该边界前输入。修法：两条结束路径共用稳定边界，覆盖在途addSet、注册变化、输入交互；可暂锁录入/加组并显式“正在结束”，结清/确认后complete，失败恢复编辑且草稿不丢。固定判据沿原矩阵，明确复跑这两个原“结束中编辑/flush期间新增组”窗口；仍覆盖cancel、throw/ok:false恢复、legacy受阻、成功后无晚写。queuedAt仍09:51:44Z、startedAt仍10:13Z，本次反馈2026-10-17T13:00:07Z；进行中，Muse，目标10-17，不重置入队等待。**（实现方返工交付登记 2026-10-17 07:22 PDT：已在 artifact（space-6）上线并回灌本仓——直接结束在 gate proceed 后先 seal 同批 handle 再 complete，finishing 锁定录入（SetRow 输入/完成钮/重试与「+ 加一组」disabled、按钮「正在结束…」）至 complete 返回、失败 unseal 解锁草稿保留；确认结束改走新增纯函数 sealAllAndSettleStable 的稳定 seal 循环（flush 期间新注册组也被 seal+settle，不稳定则中止结束、unseal 全部），validate-finish 45/45 含 mid-seal 注册与 never-stable 两例。此登记仅表示已交付，PM 结论以评审记录为准。）** **（实现方返工交付登记 2026-10-17 09:27 PDT：已在 artifact（space-6）上线并回灌本仓，commit 4fe7b0b——ActiveWorkout 层新增共享 pending-add 注册表，ExerciseBlock 加组同步登记 mutateAsync promise（settle 含 dashboard 重取），新增纯函数 settlePendingAdds 循环 join 至空且稳定；handleFinish/confirmFinishAnyway 在 flush/seal 前先 join，add 失败明确中止结束不调用 complete，成功后新组注册再按最终组集合走 gate；validate-finish 76/76 含在途 add 落地判 incomplete、add 失败中止、同 tick 注册被 join。此登记仅表示已交付，PM 结论以评审记录为准。）**
- **`W1-CONSISTENCY-001` · P1/A · W1.1/W1.2/AUDIT-10**：`3cb7d84` server/actions.ts:353–376、479–500与client/App.tsx:386–419。synthetic同一次已结束push训练：卧推4个目标组均100lb×8完成，另加第5组未完成。实际客户端reviewRecommendation把5组作为planned，返回“少完成1组，保持100lb”；真实startWorkout的loadPreviousCompletedSets先滤掉未完成组，再用模板4组，预填105lb。预期“下次建议”与实际预填对同一历史、目标组集合/范围/目标单位一致；影响为用户被两处相反建议误导。修法：统一调用者选择的最近可比训练/目标组集合，保留未完成与缺失状态，不能仅校验函数副本相等。固定矩阵：同输入两完整调用链（含加组未完成/加组完成、模板组缺失/部分完成、null重量/次数、lb↔kg、最近训练缺该动作、历史超20条边界）；逐动作比最终预填和可见建议及依据，不能比较两个手工相同的纯函数入参代替。queuedAt=2026-10-17T13:00:07Z，待办，Muse，目标10-18；为普通数值建议缺陷，非伪造数据丢失P0。**（实现方交付登记 2026-10-17 07:22 PDT：已在 artifact（space-6）上线并回灌本仓——服务端 loadPreviousCompletedSets 取最近一次已完成训练该动作全部组（完成与未完成都保留），startWorkout 的 plannedSets 改用该动作实际组数（无历史才用模板数），与客户端 reviewRecommendation 口径统一，progressionDecision 本身未改；PM 反例（4 组完成＋第 5 组未完成）两端同为「少完成 1 组，保持原重量」口径，validate-progression 34/34、validate-finish 45/45。此登记仅表示已交付，PM 结论以评审记录为准。）** **（实现方返工交付登记 2026-10-17 09:27 PDT：已在 artifact（space-6）上线并回灌本仓，commit 4fe7b0b——服务端 loadPreviousCompletedSets 改经纯函数 selectPreviousSetsByExercise 在该 routine 最近 20 次已完成训练内逐动作取最近可比记录（全部组保留、逐来源换算、converted 按实际用到来源计），预填改读逐动作历史，与客户端逐动作遍历同窗口同口径；validate-progression 47/47 含 PM 反例两端同为 increase 105lb、额外未完成组同为 hold、跨单位与超 20 次边界一致。此登记仅表示已交付，PM 结论以评审记录为准。）**

### 新需求单与产品推进：`H-LOAD-001-D1`（P1，既有七日趋势方向的能力边界方案）

**具体产品判断**：训练已经新增建议/换算/计时，当前最缺的是可安全记录与解释建议，先修上述存档风险；健康当前“一个恢复分＋六个洞”诚实但不能帮助判断七日变化。现有snapshot已有historyDaily（最多35日：steps/exerciseMinutes/hrvMs/restingHr等）、historyWorkouts、historySleeps；没有逐日readiness评分序列。无需新增系统即可交付一版**七日原始事实条**，但它不能冒充用户要求的七日恢复评分；原H-LOAD恢复趋势未交付事实保留。

| 页面位置 | 交互/数据设计 | 固定边界 |
| --- | --- | --- |
| 恢复参考环下第一行 | 显示当前实际恢复参考日期、置信度/缺项；缺历史直写“恢复分仅此日，暂无七日评分” | 不重算历史恢复分、不复制当前值，不改H1公式 |
| 随后七日事实区 | 以snapshot.dataDate结束的7个洛杉矶完整日为固定轴；一次看一个现有指标：运动分钟/步数（默认运动分钟），可展开睡眠实际时长/HRV/RHR原值；选择某日看来源和实际日期 | 从既有合法历史取值，空白断点与真实0区分；没有字段/日期就缺失，不用readiness标签；训练次数与HK分钟分源呈现、不跨源相加 |
| 状态与行动 | 显示有效日数x/7、来源更新时间与已知coverage限制；旧/缺失来源只给一次对应同步入口，不能给“增减强度”结论 | 现有payload只有全局coverageIncomplete，不伪造逐日complete；标“来源完整性未逐日证明”，不作同比/健康等级推断 |

- 编号/范围：H-LOAD-001-D1，仅细化现有H-LOAD/H-UI的事实趋势，不引入新数据仓库/评分系统/API或新发布目标。queuedAt=2026-10-17T13:00:07Z；待办，Muse负责，10-18给已有历史字段映射与可用版本，沿原H-LOAD 10-15周期，不将今天视为重置方向期限。若特定指标缺合法字段就不提供该选项，继续可用指标。 **（实现方交付登记 2026-10-17 09:24 PDT：已在 artifact（space-4）上线并回灌本仓，commit 0a27803——按本节字段映射交付七日事实条 sevenDayFacts/SevenDayFacts：四指标（运动分钟默认/步/HRV ms/静息 bpm）、LA 连续 7 格、缺口/真 0、重复去重、同日冲突标不可用、x/7 计数、点击展开原值/单位/来源说明、dataDate 边界与 coverageIncomplete 提示，睡眠未开放、未包装成评分；validate-seven-day-facts 35/35。此登记仅表示已交付，PM 结论以评审记录为准。）**
- 一次列齐判据：7日齐全/部分/全空/真0/重复日期/旧数据/跨日（LA）synthetic；日期与单位明确，null不变0、不跨日期补值；单指标切换和日期点击不更改任何业务记录；七日恢复评分仍明确未提供。纯布局B用构建审计/脚本，数据映射A用真实函数/来源对账。无数据变更时数据库对账不适用；不要求所有者截图例行审批。
- 与其他方向的取舍：W-UI-001-D1剩余保存聚合/焦点/折叠仍10-18，原P1 10-20/10-22周上限不变；财务F0/F1可信度、看房HH0正确性继续既有队列，新增看房方向继续暂缓，不借本方案扩项。真正七日readiness若必须新增历史计算/存储，先给所有者比较方案和决定；本轮只交现有能力方案，不替所有者批准新系统。

### PM反馈、期限、补证与验证

- 训练两批已有真实推进，不再沿用上轮“W0.3/W0.4多轮无新交付”的排期结论；本轮具体缺陷如上优先修。L1来源单飞/失败台账自10-15仍未新增交付，上轮已带“立即按既定P0修/所有者明确延期ID与日期”的方案请求裁决，尚无答复；继续现有已授权修复，不等待裁决。两批changes把L1/H0/H1/F0/F1/HH0合称“独立大包”顺延，缺逐项真实技术原因、各责任方与日期，须在下次交接分项补齐，不能用每轮重复“大包”无限延期。原10-18目标与10-20周上限不顺延。
- EVID-LIFE-001新增本批W0/W1子范围沿既有A要求：实际合法owner handler/schema保存回读、最终实际部署引用/时间/源码对应（没有平台version号不强求），运行失败/重试如实记录。B三视口/截图形式为次要跟进，不把结构性缺owner视角当阻塞。L0.1已批准内部通道不重开；无builder不能伪称已修复/上线/独立实机通过。
- 本地交付回归：autosave69/69、finish35/35、progression34/34、rest-timer48/48均通过；两笔逐段Handoff Gate均通过（6files/2scripts/4implementation；7/2/5），diff --check通过。PM另抽取真实server模块handler及client结束函数执行**17项synthetic独立控制**：3个W0.3并发反例＋3个串行拒绝对照、1个并发start存档删除、1个真实预填/复盘分歧、2个结束窗口反例、2个真实complete失败恢复、5个非owner写入口拒绝；每个断言通过表示反例或对应对照被执行，不表示产品17项验收通过。mock仅实现受影响Drizzle链/调度，不运行SDK/schema/React，脚本存于临时work并清理，复现调度已完整写在上文；不修改业务或验证脚本。
- 复用未变化的健康保存/来源/公式检查；本轮只为方案读取health dailySchema/history与当前单日readinessTrend，没有重跑全仓/缺依赖命令。当前repo App.tsx blob=`16492005d9de1fa94ca96a60313b77d5f8060570`、server/actions.ts blob=`353c4390e3db7808fa0780af21f40a375b4c6142`，只代表仓库来源，不冒充部署hash。无DB schema/migration改动；响应附加prefill字段兼容，真实保存行为为A。提交前新增plans行的UUID/个人绝对路径/INITIAL/固定device窄扫描均0（非全面隐私认证），diff --check通过；PM文档Gate在提交后、推送前执行，结果记automation memory。

## 2026-10-17 PM 批量结案、产品推进与单一队列

### 本轮交付与度量（02:51 PDT / 09:51 UTC 截点）

- 增量枚举：上轮源游标 `d592513` 后依次是 `681f3f7`（PM 文档，非交付）、`5e348cf`（准则文档）、`309d9a7`（W-UI 保存返工）；本轮起始远端 `309d9a792741e8079c257651c50036654f3a25fd`，不漏审、不把流程同步计进产品。
- **交付的用户可见增量 1**：`309d9a7` 改善保存反馈/结束确认，主状态为“已交付”。Muse 在 changes 的 01:22 PDT 登记申报 space-6 已上线并 cp 对应；提交时间为 01:26 PDT。本会话未独立观察 submit 生效，**本轮新增的所有者实际使用确认 0**，不能写成“已上线在用”。本轮 PM 文档修改贡献的用户可见增量 0。
- **队列中位等待时长：不可计算**。口径固定为 queuedAt→startedAt；未开工项为 queuedAt→本轮截点，两类样本分开。既有条目没有成套 startedAt，部分旧待办也无精确 queuedAt；Git 首次入文/交付时间只能作追溯线索，不能冒充开工时间。W-UI/W-TIMER 首次入文为 `7a63c2e`（10-15 10:52 PDT），不据交付 SHA 反算等待。今后由 Muse 在开始工作时写真实 startedAt，新入队项见下表；不回填推测数字。

### 存量待复验交付逐项结案（固定要求保留，主状态与 PM 标注分账）

表内“已验证”明确限定证据层级；“有问题（补证）”是本轮事后结论，不悬置为等待 PM 的主状态。A 类缺口由 Muse 按原判据补自检证据，B 类截图规格/归档形式只作次要跟进。源码已关闭项不因页面材料缺失重开。同 hash 已过检查复用，不在本轮重复全套旧脚本。以下覆盖 changes 的所有已交业务方向；尚无交付的 F0.2+、F1/F2/F3、HH0/HH1、H1/H3/W1/W3 等保持原待办，未伪称已审实现。

| 需求 / 最新相关交付 SHA | 主状态（范围） | A/B 与 PM 事后标注 | 结案去向 / 固定证据 |
| --- | --- | --- | --- |
| OPS-001 · `ddb105c` / `5e348cf` | 已交付（准则/交接） | B：已验证，Gate 和文档冲突核对 | 本轮修正根 AGENTS 概括性“publication 需所有者批准”的歧义；Life 常规上线已授权。无业务数据变更，对账不适用 |
| F0.1 / AUDIT-01 · `e54adca` / `a317191` | 已交付（财务 owner guard） | A：源码已验证，整体有问题（补证） | 沿用既有静态结论，EVID-LIFE-001/F0.1：owner/已登录非owner/未登录逐 action typed 结果及无越权写；不把摘要当运行矩阵 |
| L0.1 / AUDIT-02 · `79dbd07` / `04bd2a2`；授权 `5e348cf` | 已交付（指定内部通道） | A：已验证当前授权契约的源码边界；整体有问题（补证） | 旧“无身份入口必须撤销”返工关闭；EVID-LIFE-001/L0.1 仅补批准契约内运行矩阵。平台可验证服务身份出现或所有者撤销才重新评估，不每轮重开 |
| L0.4 / AUDIT-03 / L0.5 · `523a4d4` / `be86e01` / `1bcedec` / `205f544` / `34f216b` | 已交付（脱敏/缺基线） | A：已修源码与文档分项已验证；整体有问题（补证） | 原隐私/步数返工结案；EVID-LIFE-001/L0.4：完整 synthetic null/真0/legacy 快照经实际合法保存→回读、首次空库、配置失败保旧值。原 B 视口材料转次要跟进，无用户截图审批 |
| L1.1–L1.5 / H0.4 · `7d848b7` / `04bd2a2` | 已交付（刷新/状态部分） | A：有问题（既有来源单飞/失败台账范围未齐） | L1 原编号继续同队列：worker 内存节流不能证明跨 worker 单飞、手动 allowParallel 会开多任务；自动 spawn catch 返回 null、失败记账依赖页面轮询的旧源码反馈保留。旧快照并发覆盖部分已由 L1-RACE 关闭，不重复立单；六情形验证沿原 L1 判据 |
| L1-RACE-001 / H0.6 · `e3c6848` / `3b26882` | 已交付（原子版本/幂等） | A：源码与42+84受控断言已验证；整体有问题（补证） | 旧两处竞态返工结案；EVID-LIFE-001/L1-RACE：实际 schema/action 倒序、重复/冲突/null 版本保存回读与台账，隔离 synthetic 环境即可，不向生产写探针 |
| H-UNITS-001 · `923417c` / `5a8aa17` / `a7595f3` | 已交付（换算/整周coverage） | A：换算、缺组/legacy与第21条coverage源码返工已验证；整体有问题（补证） | EVID-LIFE-001/H-UNITS：来源整周读取→合法快照保存回读→同窗两期对账/两消费点；复用原16项handler控制及既有脚本，不用样本计数替代来源完整度 |
| H-SOURCE-001 · `561d1d5` | 已交付（双来源读取/UI） | A：有问题（必要 handler/运行证据缺失）；原36项纯函数仅分项已验证 | EVID-LIFE-001/H-SOURCE：仅health/仅strength/都有/都无/单源损坏的实际 handler/schema 通路，损坏一源不得吞另一源；不能由36项字符串/函数断言直接推定页面实测 |
| H-UI-001 · `3767c92` / `8a0c442` / `e207c4d` / `cde0436` / `fbd1d09` | 已交付（Whoop呈现/来源条） | A数据语义+B呈现：原负荷评分降级、损坏/未同步与coverage源码分项已验证；整体有问题（补证） | 源码返工结案；EVID-LIFE-001/H-UI 只补最终实际部署引用/时间与源码差异映射，含已登记 daily.steps/steps.value 差异及已有数据状态/入口实测；B截图归档不阻塞 |
| H-WORKOUTS-001 · `553f944` / `1712e90` / `a60b465` | 已交付（全部列表/两处时间线） | A口径+B呈现：已知时长文案与聚合29项独立控制已验证；整体有问题（补证） | 文案源码返工结案；EVID-LIFE-001/H-WORKOUTS：同30天 sessions 计数对账及最终部署源码映射；正常/空/仅非游泳既有呈现检查按B执行，不要求所有者截图常规审批 |
| H-LOAD-001 · `3767c92` / `07f38f2` / `f50c498` / `ab1b016` | 进行中（已交判定块，完整趋势未交） | A：跨源歧义保留/两期三环比/低置信度降级分项已验证；有问题（范围+补证） | 真实7天序列未交，仍为本ID用户需求；当前单日+六缺口诚实降级保留，不复制今日分数、不新建历史系统凑曲线。EVID-LIFE-001/H-LOAD 保留原同窗双源对账/实际判定证据；需要新历史系统时先给所有者方案 |
| W-UI-001 / W0.1 / W0.2 · `f532cf0` / `309d9a7` | 进行中（保存已交、视觉未交） | A：单写/拒绝/回退/flush与未完成确认分项已验证；有问题（新 W-FINISH-001） | 本轮69项交付回归+PM22项受控函数控制；原已修源码问题结案。结束边界按下文修；视觉按W-UI-001-D1，A运行补证沿EVID-LIFE-001/W-UI，B归档不设闸 |
| W-TIMER-001 / W2.1 · `d592513` | 进行中（截止计时已交、关闭/位置未交） | A交互+B位置：截止/加时/跳过40项函数分项已验证；有问题（原范围缺口） | 同原ID补“本次训练关闭自动计时后下一完成不重启，可主动恢复”及当前动作卡附近位置；owner声音/后台证据诚实列缺口，不重开计时数学、不以PM复验卡队列 |

**EVID-LIFE-001（P2，证据队列，非代码缺陷/P0）**：本轮将以上逐项必要缺证合并管理，每个后缀仍保留原ID、A/B与固定要求。A数据变更须有可复跑的 synthetic 合法输入→身份契约→实际并发/持久化→返回→页面对账证据；不能用类型检查或 PM mock 代替。B只要求构建审计＋对应验证脚本＋数据对账（无数据变更写不适用），结构性缺失的owner截图不阻塞。最终部署可用可打开引用/时间与实际源码hash/diff，无需编造平台version。当前工具无 Muse builder/invoke_action，PM不能完成这部分实测；Muse已有builder上下文负责补能取得的材料，其他项继续。归档/视口文件形式问题不加返工轮次。

### Bug 单：W-FINISH-001（P0 / A，保存与结束状态边界）

- **版本与位置**：`309d9a7`，workout-log/client/src/App.tsx:856–865 的 seal、1126–1129 complete mutation、1136–1162 finish/confirm，1021–1022 的加组按钮及914–947输入/完成控件；关联服务端 updateSet:414–425 / completeWorkout:470–486 的既有 W0.3。来源为本轮真实函数受控反例，不宣称已在线上复现。P0依据是训练存档写入与结束边界，非缺截图/缺证据。
- **复现一 / 实际**（synthetic）：结束确认可见后再次编辑/重试，让单写队列有一个尚未落库的 updateSet；点“仍要结束”。实际 seal 只置 sealedRef 并清 debounce，不等待已发送写；confirm 立即 complete。受控持久化次序确认为 complete-requested→update-persisted，seal无法阻止旧在途写在结束后落库；“不再发新写”不能证明“没有晚到写”。
- **复现二 / 实际**：确认结束调用 seal 后 complete 请求抛错，当前 active 组件继续挂载；再改合成重量10→30并blur/重试。队列永久sealed，flush=false、confirmed仍10，输入显示dirty；源码无解封/错误恢复，也无结束失败文字。正常resolve的业务拒绝同样需要检查，不能只把transport success当完成。
- **复现三 / 实际**：一旧组flush在途时，通过仍可用“+加一组”登记新组；旧批flush成功后，handleFinish只检查进入时拷贝的handles。真实函数控制里新组dirty/blocked且未完成，flush调用0次、complete却1次且无确认。结束期间输入/加组未锁，已捕获批次不代表结束时全部组。
- **用户影响与预期**：已结束记录可能继续变化、结束失败后本次训练再也存不进去、新组被跳过保存/确认。结束必须针对一个一致的最新组集合/草稿版本；发完成请求前没有未决写，结束处理中新增组/编辑应被清晰限制或纳入重新flush。失败/业务拒绝恢复可编辑和可保存，保留全部草稿且明确错误；取消确认不封队列。
- **修法范围**：在既有 W-UI 闭环实现可恢复的结束状态（编辑→收敛保存→确认→提交→成功或恢复编辑），等待真实在途请求结清，不能用清timer替代；加组/编辑与完成提交共用同一结束边界，选择冻结录入或版本变化后重新收集均可。W0.3独立修目标active归属与真实affected-row结果，防止已结束目标继续写；不新增跨端版本系统，不扩大身份例外。
- **一次列齐的验证判据**：真实queue+flush+seal+handleFinish+complete受控集成覆盖：确认后已发旧写晚到；确认后complete抛错/ok=false再编辑重试成功；flush期间加组/改现有组；正常全完成；未完成/缺次数/真0；取消确认继续保存；重复结束与addSet在途；成功后不再写、失败后能写且草稿不丢。除受控时序外，Muse补实际合法owner action保存回读与对应UI流程，不以字符串断言代替。按授权自检后直接上线，PM事后复核。
- **排期/责任**：queuedAt=2026-10-17T09:51:44Z；待办；Muse负责P0优先修复并和W0.3同类打包，目标10-17当日交付，若确实耗时须在changes注明真实startedAt、卡点/责任人与日期；没有PM批准依赖。新结束问题首次入队，原单写返工有实质进展，不按“两轮同问题无进展”升级。
- **实现方交付登记 2026-10-17 03:24 PDT**（startedAt=2026-10-17 03:13 PDT）：已与 W0.3/W0.4 同包交付并在 space-6 上线——队列新增 settle、handle 新增 sealAndSettle/unseal/id，确认结束先结清在途写再 complete，complete 抛错/ok:false 解封并显示结束失败文案、草稿保留，取消确认不封队列，flushAllHandles 稳定批次才喂结束门。仓库 validate-finish.mjs 35/35（PM 三反例受控时序 + 三变异）、autosave 69/69、rest-timer 40/40、health 回归全过，构建审计 pass。owner 实机结束流程证据仍归 EVID-LIFE-001/W-UI。此登记仅表示实现方已交付，PM 结论以其评审记录为准。

### 新需求单及产品推进：W-UI-001-D1（P1，既有W-UI-001交互细化）

**产品判断**：健康看板已具备来源状态/全部运动/同期事实；训练端已经付出保存复杂度，现在应让用户始终知道“当前做哪组、上次依据是什么、刚输入的值存好了没有”。本项完成原W-UI剩余视觉范围，同时让W-TIMER的“当前动作卡下”有明确锚点。财务F0/F1数据可信度仍是既有P0队列，看房新增候选继续尊重暂缓决定；不另开新系统或用流程产出充数。

- **范围/层级**：手机顶部一行训练日+已完成/总组数+时长，下面把“保存：有修改/保存中/失败/全部已保存”与完成进度分开。完成数不能当保存成功数；按现有组状态聚合，不增API/表/健康公式。
- **当前动作**：默认展开第一个未完成动作，全完成则保留最近操作动作；用户手动切换优先。卡内顺序固定“动作名/目标区间→上次同单位可比组（缺失显示暂无可比记录）→本组输入/保存反馈”；其余卡折叠为动作名+完成进度+文字保存异常。折叠只隐藏内容，不能卸载组状态机/注销handle/重建队列，避免正在保存的输入被切卡丢掉。
- **计时与单手操作**：W-TIMER嵌当前动作卡下方，共用当前动作锚点；设置“本次自动休息计时”开关，关闭后完成下一组不自动弹出，开启不重写组完成状态；当前跳过仍仅跳过本次。数字键盘Enter/下一项沿重量→次数→下一组移动焦点，不能顺便勾选完成；结束入口在键盘收起后可达，结束进行中依W-FINISH边界显示状态。
- **验收边界**：390×844/430×932/桌面上长动作名、多组、保存失败/慢响应、切卡与键盘开合；控件至少44px，保存状态有文字。特别复现“保存中折叠动作再展开”不丢草稿且注册集合仍完整；所有原训练/空/错误数据保持诚实。纯呈现按B构建审计+验证脚本；不改业务数据时对账不适用，涉及保存状态的行为断言按A。
- **编号/排期**：W-UI-001-D1承接原W-UI/W2.2，queuedAt=2026-10-17T09:51:44Z，待办，Muse负责；目标10-18可用。父需求首次入队10-15，P1周上限仍为10-22，不由本细化重置；更早W2.2待办的10-20周上限也保留。与其他明确可执行项按队列竞争，不等保存项PM复验；技术上复用同一活动动作/保存注册表即可。

### 全量执行与方向期限

- P0按同类打包并持续处理：W-FINISH-001、W0.3/W0.4目标归属/并发启动；L1.1–L1.5/H0.4状态与单飞；H0.1–H0.6来源/日期/睡眠口径；W1.1–W1.4统一渐进规则/单位；H1.1–H1.8恢复参考数据边界；F0.2–F0.5/F1.1–F1.5财务完整性/语义；HH0.1–HH0.5原看房安全正确性及L0.2/L0.3/L0.5。已交已修分项不重开；这不是要求每次从头全仓重审，也不重新处理已批准身份例外。Muse逐项记录真实开工/卡点；没有“只选一个”上限。
- 用户直提 H-UI/H-WORKOUTS 已有方案和源码交付，缺A证据按补证尾巴排；H-LOAD真实七日序列仍未交付：当前服务仅单日，无可信历史时保留缺口；Muse在10-18提供可复用已有历史事实的范围说明，若必须新增历史系统则给所有者“保留单日参考/另立历史系统方案”具体取舍，未拍板不建新系统。这是原10-15需求的后续，不重置原一周期响应/两周期方案承诺，也不能把六缺口算七日趋势交付。
- 本轮既有方向交互方案W-UI-001-D1已交；W-TIMER已有关闭/位置缺口同队继续，目标10-18，不等W-UI验收。H3/W3及H4/W5/F3已批候选保持原排期责任Muse，P1以最初入队起算周上限；10-13入队的P1上限10-20，目前未超周上限。尚无真实startedAt/确切交付日的项要求Muse补排程，不能把“缺PM截图”写成卡点。单项耗时才注明ID、真实原因、责任方和日期，其他项继续。
- **所有者裁决请求（本轮已异步发出，不阻塞队列）**：L1来源单飞/失败台账、W0.3/W0.4自10-15确认后连续多个周期无新交付，按“两轮同真实问题无进展”升级排期。建议A：Muse按既定P0把同步状态一组、训练归属/并发启动一组立即推进，目标10-18交付；如所有者选择B继续暂缓，需明确具体ID、接受的现状与新截止日。责任Muse；此前单项/验收串行安排已撤销，不再用它作卡点。现有授权足以按A继续，无需为等裁决停其他明确可执行工作。W-FINISH为首次新问题，不与旧单写返工混作两轮失败；不因升级要求撤销L0.1例外或新建身份系统。

## 当前状态

- [x] 完成四个 app 的第一轮 PM、设计和静态代码审计。
- [完成] 建立需求编号、单一队列、自检交付和 PM 并行反馈流程；本标记只表示文档已交付。
- [ ] Muse 按推荐顺序实现 P0。
- [ ] 同类产品调研候选已排入队列：`H4` 5 项、`W5` 3 项、`F3` 5 项（用户 2026-10-13 批准启动）；调研候选 T2/T3 已被 `W3.1/W3.3/W3.5` 覆盖、未重复纳入；看房类候选暂不纳入。
- [ ] 在实际 artifact 对 P0 做首轮运行验收。

- 2026-10-16 02:40 PDT · `07f38f2` · `H-LOAD-001`：**新artifact交付声明已登记；原返工未关闭／运行待验，不勾选。** 清洁main由2698545安全快进到本轮起始远端 `07f38f2702a8bacddfc8e75def3ec124a327f0ff`；先读取游标及远端提交/文件范围，忽略2698545 PM-only，再读根/health AGENTS、需求与changes新增证据。本次只有plans.md与changes.md（:218-225）变化，明确ID、artifact侧App.tsx/weekLoad范围、无schema/migration/服务端改动声明及artifact回滚说明；未收到实际artifact源码差异。仓库App.tsx:388-429与3767c92逐字无差异，仍为此前已审版本，不能据此证明线上未修或重算一次失败。
  - **证据边界。** 新登记声称同窗双源、单位换算/去重、coverage与低readiness门槛、结构化返回已上线，build/audit和11项内容自评通过；只有space-4及非owner拒绝摘要，缺精确artifact/version、可复跑脱敏步骤/typed结果和新增构造例。当前工具无Muse builder/invoke_action，无法独立读取该发布源码或运行，不能将声明当成TL源码审查/owner验收。新字段返回也不能证明页面已消费两期次数/时长/容量及三项环比，或并列了原要求的readiness近7天趋势；changes只称修改weekLoad，这些要求仍须在同一交付中给调用处及页面证据，未据描述另判新源码缺陷。
  - **下一次只补本项交接。** Muse回灌实际发布的weekLoad、相关类型与消费UI，附artifact/version到仓库修订的对应关系及准确命令/结果；使用真实生产函数/handler的synthetic断言验证原记录要求，并实际执行coverage/低分门槛删除变异。双源同窗对账应覆盖同一训练跨源重复及同日两次独立力量训练，证明去重没有把独立场次整日抹掉；这是原“不重复计数”验收用例，当前未见源码，不能宣称其同日去重规则已正确或已失败。结构化数值必须核对可见UI，7天趋势仍按原需求；提供匹配数据三视口前后证据，不能把全部数值/构造例留给PM猜测。无需为补证据向生产库写探针；沿plan→build→audit→submit流程，现有单一来源、readiness公式和权限/后台链边界保留，不新开功能。
  - **检查与收尾。** `node scripts/validate-handoff.mjs 3767c92 07f38f2`与`node scripts/validate-handoff.mjs 2698545 07f38f2`均退出0（2files/0scripts/0implementation），`git diff --check 3767c92..07f38f2`通过；新增文档行UUID/个人路径/INITIAL/固定device窄扫描计数均0，仅窄扫描而非全面脱敏认证。无实现/测试diff，不重复旧函数回归、缺依赖命令或原运行阻塞；未本地build、安装依赖、访问app.db。本轮只更新plans，游标为起始远端、保留最近20条。本次有新交付声明但未见修复源码，非第二轮独立失败/无进展结论，不触发用户决策升级。提交前重新fetch保护并发；后续没有新源码/证据/环境变化即退出，不重复追加本条。

- 2026-10-16 05:45 PDT · `8a0c442`（回灌 `f50c498`）· `H-LOAD-001`：**有实质进展；局部关闭、P1继续返工／整项运行待验，不勾选。** 清洁main从670f4fe安全快进至本轮起始远端 `8a0c442b8751917515c74baf4507acc75dc370d7`；先游标与提交/文件范围，忽略670f4fe PM-only，再读根/health AGENTS、需求/changes新增证据、App与两脚本diff及受影响schema/来源prompt/getDashboard/页面调用。此次仅client及验证脚本/文档，DB schema/migration、owner/无viewer例外、schedule/callback、persist版本幂等均无diff。既有来源→受信保存→独立strength loader合并→snapshot/readiness响应→Dashboard/WhoopHero→weekLoad→verdict/detail链未改，不能从client控制推断保存或权限运行通过。
  - **局部关闭。** App.tsx:450-498使用两个显式LA日期周一至同截止日窗口，每日期恰一daily、力量整周coverage与两个组计数、无未测组、完整周sessions与列表一致后才允许比较；:500-534按力量场次/HK sessions时长与逐场单位计算，:570加入既有score<2低档，低置信度不再给绿。回灌f50c498的App SHA256与changes登记相符；新增validate-week-load的36/36包含真正执行的coverage/低分变异，本地命令退出0。这关闭“无源码/无可复跑断言”及原已检出coverage/低分局部缺口，不代表所有来源映射或线上版本已独立核实。
  - **P1来源去重返工（源码/受控反例）。** App.tsx:503-505只凭type含strength及同日有力量记录，删除该日全部HK力量sessions；HealthKit workoutSchema（health-dashboard/server/src/actions.ts:26-34）只保留id/date/type等，没有跨源关联或起止时刻，无法证明这些都是重复场次。PM在Node stdin复用仅抽取器，以stripTypeScriptTypes执行实际weekLoad，独立16断言通过并确认：synthetic同日训练记录60分钟，HK一条映射同次60分钟、另一条独立90分钟；两条HK均被删，结果仍1次/60分钟、sufficient=true、环比0与green。把独立那条移到次日则变2次/150分钟，证明差异来自整日删除。交付脚本:115后的“同日独立”只保留了训练记录里的两条，未测试HK侧独立力量；不能作为此边界已通过。此为实际client函数受控输入，非合法schema/save/action/artifact端到端证据，不宣称真实用户数据已损失。预期只合并有可核对依据的同次跨源记录；现有字段不能证明时，保留各来源可知事实并显示重复归属未确认/不可比较，不按日期猜测删除或给确定结论。必要的附加字段只能沿已有单一来源/同步链，写明旧快照降级及兼容回滚，不新建第二份来源或同步路径。
  - **P1可见交付仍缺。** :529有sessionsChangePct但:541-553/:635-637只消费detail，未展示次数环比、上期力量容量/单位及明确两期窗口；readiness近7天趋势也不存在，changes已如实承认。PM控制把本周次数变2/上期1，结构化返回+100%，可见detail无次数环比；WhoopHero不读该字段/previous或趋势。原需求已有授权，不需重新让用户决定是否补原范围。下一交付只完成本项：解决上条去重/歧义边界，并把同窗两期三指标及三项环比（零基线无百分比）、沿既有服务端口径的7天readiness参考趋势实际呈现；缺历史依据保留缺口/日期，不能复制今日值或另造算法。提供真实producer/判定函数同日重复+独立HK场次、单位切换、周一/缺失/旧快照/零基线/三档控制及可见UI断言，实际同窗双源脱敏对账与匹配发布版本/源码映射和三视口前后证据。当前只推进本项，H-UI后续不另开第二在制项；本轮有明确进展，不构成两轮同问题无进展。

- 2026-10-16 05:45 PDT · `8a0c442` · `H-UI-001`：**睡眠/活动缺失源码局部返工关闭；原公式降级未完成，整项返工／运行待验，不勾选。** App.tsx:313-328先要求实际睡眠记录再读有component依据的radar，:364-378仅取dataDate活动且三项齐全；:632缺睡眠驱动值显示—。交付validate-whoop-scores19/19及三个实际变异退出0，PM另从实际函数以独立synthetic输入做9断言通过：缺睡眠/默认radar无分、有效component控制、异日不拼接、逐项缺失降级、有效全零不丢失。因此不再重复这些已关闭返工。:380-390仍按8/7/6自定0–21公式输出“负荷适中/过高”，:627以负荷环展示；完整输入本地仍得10.5/适中。修齐输入并未完成上次明确要求的未审定公式隐藏/标注未确认；随后H-UI只按原边界降级该确定等级，补日期/来源层级与可行动入口，不在视觉任务改readiness或批准新健康公式。
  - **发布证据限制与检查。** changes仅声明space-4 build/audit和非owner拒绝，H-LOAD回灌hash只对应f50c498；8a0c442明确承认未逐字核对最终线上源码。仓库当前App hash已因该新修复变化，不能沿用旧hash证明最终发布版本；平台无版本号时允许可复核发布引用/时间及最终源码hash映射，不编造API或版本号。当前工具无Muse artifact builder/invoke_action；两项的owner三视口及H-UI五态仍运行待验，本轮不重复旧阻塞，不声称实际发布成功。Gate `07f38f2→8a0c442`通过（5files/2scripts/3implementation），两次新交付逐段Gate均通过（各4/1/2），diff --check通过；新增55断言与PM25独立控制均属本地函数证据。未本地build、安装依赖、访问app.db或重复既有缺SDK/zod命令。5个受影响blob UUID/INITIAL/固定device命中文件0；个人路径模式仅changes旧行4处、新增行0，不复制旧值，窄扫描不等于全面隐私认证。只改plans、游标记录起始远端、保留最近20条；提交前再次fetch保护并发，P0门槛及其他原待验项保留。

- 2026-10-16 08:46 PDT · `ab1b016` · `H-LOAD-001`：**局部源码返工关闭；诚实七日缺口保留，完整趋势未交付，整项运行待验，不勾选。** 清洁main从030aef2安全快进到本轮起始远端 `ab1b016f35f14cf904455b73225199ccddf4cf7e`；先游标/远端提交文件范围，忽略030aef2 PM-only，再读根/health AGENTS、plans/changes及5文件diff。changes.md:246-254有明确ID、范围、兼容/回滚和证据限制；仅client/App.tsx、theme.css、验证脚本及文档变化，schema/migration、权限/无viewer例外、schedule/callback、刷新/幂等链均无diff。沿现有合法快照→getDashboard合并/单日calculateReadiness→WhoopHero→weekLoad→detail/日期缺口追踪，未把客户端检查当作后台保存/身份运行证据。
  - **已关闭的源码返工。** App.tsx:513-550保留全部窗口内HK记录及训练记录；同日力量跨源归属无法证实时两边事实保留、加入歧义原因，sufficient=false且三项百分比null，不再整日抹掉独立HK场次。:578-607补两期显式日期、次数/时长/容量与三项环比、上期容量单位；readiness缺失仍显示可比事实；WhoopHero:675-677实际消费detail。交付validate-week-load47/47（含coverage/低分/歧义三个执行变异）、相关validate-whoop-scores19/19均退出0。PM另在Node stdin抽取当前真实生产函数，独立24个synthetic断言通过：非零正负三环比及可见文字、恢复缺失时保留比较、score=0低档及趋势零值、当前/基线窗口两侧跨源疑似重复与独立场次均保留并降级、无输入修改、窗口外排除、同日多次训练保留、三项真零基线无百分比、七日单点/缺口。全部为纯函数控制，不是schema/SDK/action/artifact运行。
  - **趋势取舍与未完成边界。** :556-565/:678-686按七个日期显示唯一readiness.score和六个null，不复制当日分数；认可这是上一轮允许的缺历史时诚实降级，不能把它当完整七日趋势或已满足整项。server actions.ts:1031-1035每次从快照和晨检现场calculateReadiness，schema.ts无评分历史表，故页面“服务端只保存最新一天分数”并不准确，应改“当前接口仅返回单日恢复参考，历史未提供”；不能把旧数据重算当曾经保存的真实历史。PM本轮决定暂保留缺口，不为凑七点增设历史库、回填分数或改H1算法；真实逐日序列仍为未交付范围，随可复核历史依据继续验收，不重新要求用户决定原需求是否存在。
  - **下一唯一原子交付。** 转既有H-UI-001的确定等级降级：App.tsx:380-390仍以自定8/7/6权重0–21给“负荷适中/过高”，:685仍说“只换呈现方式”。隐藏这项未经审定的数值及红黄绿训练等级，以中性—/评分未确认呈现，保留同日已知运动时长/活动能量/步数与缺失原因，纠正上述评分/存储说明；保留Whoop视觉，不改变现有readiness与H-LOAD判定、来源/同步/权限/schema。Muse给真实生产函数与消费处的完整/零/缺项/异日synthetic控制，证明完整输入也不再输出旧确定等级；附实际发布源码映射和匹配数据三视口前后证据。日期/来源层级与可行动入口仍属H-UI后续，不扩功能、不再重做已关闭缺失态或H-LOAD去重修复。
  - **交接与运行边界。** Gate `8a0c442..ab1b016`及`030aef2..ab1b016`均通过（5files/1script/3implementation），diff --check通过。5个受影响blob窄扫描UUID/INITIAL/固定device均0；个人路径仅changes旧4行，新增差异0；不是全面个人数值清零证明。changes承认回灌按规格功能等价、未逐字比线上源码；space-4及build/audit/非owner拦截摘要不足以验收owner产品。无Muse builder/invoke_action；精确发布对应（无版本号时可复核部署引用/时间/最终源码映射）、同窗双源脱敏对账及390×844/430×932/桌面仍运行待验，不重复旧阻塞。未本地build/装依赖/访问app.db。实际修复有进展，不构成两轮无进展；仅改plans，游标到起始远端，保留最近20条；提交前重新fetch保护并发。

- 2026-10-16 11:49 PDT · `cde0436`（新交付 `e207c4d` / `cde0436`）· `H-UI-001`：**负荷评分降级源码返工关闭；来源条P1局部返工／整项运行待验，不勾选。** 清洁main从1f545a0安全快进，本轮起始远端/审查游标为 `cde0436923e336254735d0bc0373ef91485f0811`；先游标及远端提交/文件范围，忽略1f545a0 PM-only，再读根/health AGENTS、需求、changes.md:256-273及七文件diff。两笔均明确ID/边界/命令/兼容/回滚；仅客户端、验证脚本及文档，无schema/migration、权限/无viewer例外、schedule/callback、刷新/版本幂等变化。追踪既有加载校验→独立strength合并→buildDataStatus/单日readiness→Dashboard/TodayView→WhoopHero及原mutation/轮询消费，不把客户端控制当受信保存或权限运行验收。
  - **关闭与可保留。** App.tsx:358-380恒返回null/—/slate/评分未确认，完整/真零/缺项/无当日记录均不产旧等级，保留同日事实与缺项原因；:706去掉/21，:630对null无状态标记；:723-724纠正单日接口与未审定公式说明。日期/恢复参考分开、独立两来源与一个主入口的接线存在（:647-694、:896、:1072），复用现有mutations与禁用状态/数据状态锚点，未猜跨app深链。交付whoop22/22、hero12/12、weekLoad47/47及其执行变异均退出0；PM另在Node stdin抽取实际strainScore、heroSourceStatus及服务端freshnessFor/buildDataStatus（effectiveStrength仅用受控空返回桩），31个独立synthetic断言通过，覆盖四类中性输入/事实、日期、unknown/重试和下述反例。全部属函数控制，无schema/SDK/action/artifact运行。
  - **P1首层信息保真返工。** App.tsx:649-656没有消费coverageIncomplete或来源detail。复现：合法健康来源存在，strengthLoad.state=corrupt；实际buildDataStatus（actions.ts:933-934）给detail“训练快照损坏，等待重新同步”、freshness=missing、updatedAt=null；实际hero却输出“还没有 · 尚未同步”，与从未同步的来源完全相同，丢失损坏原因。已有data-status详情保留该原因，首层不应改写成从未同步。另coverageIncomplete=true且更新时间新鲜时，首层仍只有“最近完整日/新鲜”与查看入口，没有覆盖缺口提示；“完整日”可指日历窗口，不能让用户误认为数据已完整。预期复用已有安全detail/状态与coverage标志，明确区分缺失、损坏、覆盖不完整和更新时间；未知仍未知。只修现有客户端来源条及必要消费，不加状态库、接口、同步链或新公式，保留当前缺失/过期重试路径。下一必须交真实producer→hero的损坏/未同步对照、partial+fresh控制、正常/旧数据回归与可见消费断言；不能只加字符串存在检查。本次是新来源条首次独立返工，旧负荷降级有进展，不触发两轮无进展升级。
  - **发布对应与后续。** changes新增明确承认线上strain步数取daily.steps、仓库取steps.value；同规格回灌不能证明最终线上事实/源码一致。下一给可复核发布引用/时间与最终实际源码hash/差异映射，确认沿既有dataDate口径及降级；平台无version号可用上述替代，不要求编造编号。当前工具无Muse artifact builder/invoke_action，owner五态三视口与主入口运行仍待验，不重列其他无新证据旧阻塞。只推动上条原子修复，然后按现有队列推进；P0权限/隐私和H-LOAD历史/对账门槛保留。
  - **检查与交接。** Gate `ab1b016..cde0436`通过（7files/3scripts/5implementation）；两笔逐段Gate通过（5/2/3、5/1/3），diff --check通过。七个受影响blob的UUID/INITIAL/固定device/个人路径及新增差异命中均0，仅窄扫描，不是全面个人数值清零证明。未本地build、安装依赖、访问app.db或重复缺依赖旧命令。本轮只改plans、游标为起始远端；仅保留最近20条，提交前再次fetch保护并发。

- 2026-10-16 14:51 PDT · `fbd1d09` · `H-UI-001`：**来源条两处源码返工关闭；整项运行待验，不勾选，无新源码返工。** 清洁main从459adc6安全快进到本轮起始远端/审查游标 `fbd1d0992dd7e5d62038ec0a29207ad80dae7a80`；先读游标和远端提交/文件范围，忽略459adc6 PM-only，再读根/health AGENTS、plans、changes.md:274-282及五文件diff。交付有准确ID、范围、命令、兼容与回滚，仅客户端/脚本/文档，无schema/migration、权限/无viewer例外、schedule/callback、刷新/保存/幂等变动。
  - **实现与独立验证。** App.tsx:657-669保留missing来源现有安全detail、单独输出coverageIncomplete；:691-705在来源行后/主按钮前实际消费覆盖提示，旧同步优先级/disabled/滚动目标不变。追踪独立加载/校验→effectiveStrength→buildDataStatus→getDashboard→Dashboard/TodayView→WhoopHero；健康无效时走StrengthOnlyView/空态而非hero，未把纯函数健康损坏断言声称为该页面运行。交付脚本抽freshnessFor加指定detail，不是完整buildDataStatus；PM另独立抽当前真实effectiveStrength/freshnessFor/buildDataStatus及hero/格式函数，以合成health/strength加载状态完成24断言（真实producer两来源损坏/从未同步、正常、partial+fresh、stale优先级、legacy、空readiness/未知状态、输入不变、覆盖提示消费位置/按钮接线）。两处上轮反例不再复现；不修改schema/action也未执行React/artifact，不把受控调用当运行成功。
  - **运行边界与下一项。** changes明确同规格回灌未逐字核对线上源码；旧线上daily.steps/仓库steps.value差异尚无最终映射。仍需可打开发布引用/时间+最终实际源码hash/差异对应（无version号允许此替代）、匹配脱敏owner五态三视口前后截图与主行动实测。新增“本上下文getDashboard返回数据”仅为实现方探针摘要，没有身份/版本证明，不能关闭原P0或产品门槛；本轮无可用Muse builder/invoke_action，运行待验保留，不重复旧阻塞。无两轮无进展；下一仅H-WORKOUTS-001历史页全部类型列表，使用现有30天historyWorkouts、保留游泳专区/图；实际消费断言覆盖正常/空/仅非游泳、null与0、跨类型日期排序，再给匹配三视口/同窗来源对账；同ID时间线随后，不新增源/同步/公式或新需求。
  - **检查与交接。** Gate `cde0436..fbd1d09`及`459adc6..fbd1d09`均通过（5files/1script/3implementation），diff --check通过；hero20/20（四项变异实际执行）、whoop22/22、weekLoad47/47通过，PM另24断言通过。五个受影响blob及新增行的UUID/INITIAL/固定device/个人路径命中0，仅窄隐私检查。未本地build、安装依赖、访问app.db或重复旧缺依赖命令。本轮仓库仅改plans，所有需求勾选保持不变，最近20条审查记录；提交前再fetch保护并发。

- 2026-10-16 17:50 PDT · `1712e90`（交付 `553f944` / `1712e90`）· `H-WORKOUTS-001`：**列表/聚合源码局部通过；P1时长文案返工，整项运行待验，不勾选。** 清洁main由4e10251安全快进至本轮起始远端/审查游标 `1712e90ffb1548d004389b5c5255fd4683a167b7`；先读游标/提交文件范围，忽略4e10251 PM-only，再读根/health AGENTS、需求、changes.md:283-302、六文件diff及受影响schema/producer/getDashboard/diagnostics/两处消费者。两笔均有ID、范围、可复跑命令、兼容/回滚与运行限制；实现方只追加交付说明、不代表PM验收。仅响应附加hkWorkouts、客户端/脚本/文档，无DB migration、快照schema、权限/无viewer例外、schedule/callback、刷新/保存幂等改动。沿既有受信保存→独立loader→historyWorkouts→buildUnifiedTimeline→响应→DataStatusPanel/HistoryView追踪；本轮不把纯函数当schema/action/React或artifact运行。
  - 已核对：历史页全部类型按date倒序/同日id稳定序，不改输入；四指标null显示—、真实0保留，旧游泳区/日距离图未变。时间线只读sessions明细，按已有本地date/type聚合，HK独占日期有行；HK力量类型不计训练日志strength计数/volume，单位换算与原14日期上限保留。旧payload缺hkWorkouts客户端降级为空；server新响应始终给数组。无新来源/权限源码缺陷。
  - **P1源码确认，位置 `health-dashboard/server/src/actions.ts:998-1011` 与 `health-dashboard/client/src/App.tsx:998-1006`（两消费点:888、1028）：部分时长缺失被掩盖为完整总时长。** 复现全部为synthetic：同日Swimming两次时长30/null，加Running一次20；实际producer→label得到“运动 3 次 · Running、Swimming · 共 50 分”。把null改为有效0后输出完全相同；前者仅已知小计，无法断言三次运动总共50分。实现只在全未知时隐藏，部分未知仍丢失语义；交付脚本26/26恰好固定了此错误文案，pass不等于产品正确。
  - 下一唯一原子交付：沿用现有响应与已知小计，将两处时间线消费的时长统一明确为“已知时长 X 分”，提供可见说明“仅汇总有记录的时长，缺失不按0”；类型/次数、全未知无时长、真实已知0及列表字段保持。不新增coverage存储/API/DB schema，不改来源、同步或公式。提交真实producer→label的同类型部分缺失、跨类型部分缺失、全未知、真实0、全已知、旧字段降级控制，更新旧错误期望，证明两处消费可见，并附修前/后匹配证据。此为首次新问题返工，前两笔有实质进展，未触发两轮无进展升级；关闭后恢复既有W-UI→W-TIMER队列。
  - 检查：交付all-workouts20/20、unified-hk26/26、相关units25/25、source36/36通过；PM另抽取真实聚合/标签/排序及依赖，24项独立synthetic断言通过（含上述缺陷确认、混单位力量并列、日期上限、输入不变、空/缺失/真实0）。Gate fbd1d09→1712e90、4e10251→553f944、553f944→1712e90均退出0，diff --check通过。六个受影响blob及新增行窄UUID/INITIAL/固定device/个人路径扫描均0，仅属窄扫描。工具清单仍无Muse builder/invoke_action，未运行本地build/安装依赖或接触app.db。新changes仍明确承认未逐字核对线上源码，且artifact额外有未回灌CSS规则；功能等价声明/非owner摘要不足以证明最终发布对应或owner页面。保留既有最终源码映射（可用部署引用/时间+实际源码hash/diff，无需不存在的版本号）、同窗sessions计数对账和owner正常/空/仅非游泳三态390×844/430×932/桌面证据要求，不另追加重复外部阻塞。原H-UI/P0及其他运行门槛不变。修改前fetch确认无并发；本轮仅plans，保留最近20条。


- 2026-10-16 20:50 PDT · `a60b465` · `H-WORKOUTS-001`：**P1时长文案源码返工关闭；整项运行待验，不勾选，无新源码返工。** 清洁main从df9bee3安全快进；本轮起始远端/审查游标 `a60b465ce3125a2ae530ce5592507a8068a68733`。先读游标及远端提交/文件范围，忽略df9bee3 PM-only，再读根/health AGENTS、plans、changes.md:304-311、四文件diff与受影响producer/response/getDashboard/两处消费者；下一项沿用workout AGENTS。交付有准确ID、边界、可复跑命令、兼容/回滚及运行限制；实现方登记不代表验收。仅client文案/验证脚本/文档变化，无服务端、schema/migration、权限/无viewer例外、schedule/callback、刷新/保存幂等改动。
  - 独立核对 `health-dashboard/server/src/actions.ts:968-1026` 的historyWorkouts按本地date/type聚合→getDashboard响应→`health-dashboard/client/src/App.tsx:1002-1011` 标签→DataStatusPanel:882-891与HistoryView:1026-1034消费。已有受信保存/loader路径未改；标签明确已知时长，两处列表前均渲染“仅汇总有记录的时长，缺失不按0”，沿用empty-inline样式无隐藏规则。全未知省略、真实0保留、HK力量类型不混计；本轮未发现新源码缺陷。
  - 验证：`node health-dashboard/validate-unified-hk.mjs` 34/34（含四个已执行变异）、`node health-dashboard/validate-all-workouts.mjs` 20/20；PM另从真实server/client函数及实际依赖抽取后以Node stdin执行29项独立合成断言：同类型/跨类型部分缺失、全未知、真实0、0+未知、全已知、空/旧字段、输入不变与HK/力量隔离；两处消费者说明位置仅作静态核对。首次PM验证脚本因stripTypeScriptTypes拒绝顶层return失败，修正验证封装后通过，未修改仓库脚本。Gate `1712e90..a60b465` 与 `df9bee3..a60b465` 均通过（4 files/1 script/2 implementation），diff --check通过。四个受影响blob窄UUID/INITIAL/固定device命中文件数0；个人路径命中1个既有plans文档，新增行四类均0，不披露内容，不视为全面隐私认证。
  - 新changes明确线上说明样式/标点与回灌不同、未逐字映射最终源码；现有工具无Muse artifact builder/invoke_action。源码局部结论不冒充React/owner/action/schema或已发布运行成功；原最终部署引用/时间+实际源码hash/diff、同窗sessions对账及owner三态三视口门槛保持，不重复追加相同外部阻塞；未运行本地build、安装依赖或接触app.db。整项不勾选；本次有实质进展，不触发两轮无进展升级。
  - 下一唯一原子交付：既有 `W-UI-001` 逐组自动保存与结束前防丢（承接W0.1/W0.2），详见“当前应推动”；交付真实保存/客户端倒序响应、失败保留与重试、已完成组修改后直接结束/切页证据，再补匹配部署/合成数据/三视口。沿用P0权限与数据可信门槛，其他W-UI视觉、W-TIMER及分析公式各自后续推进。修改前fetch无并发；本轮仓库只改plans，保留最近20条。


- 2026-10-16 23:50 PDT · `d592513`（新交付 `f532cf0` / `d592513`）· `W-UI-001` / `W-TIMER-001`：**W-UI保存闭环首次P1返工；计时源码局部通过但范围未齐，两项均运行待验、不勾选。** 清洁main从4a0d557安全快进到本轮起始远端/审查游标 `d5925134889b457b34e19c09da1d1b3df7f209bd`。先读memory/游标/远端提交文件范围，忽略4a0d557 PM-only，再读根及workout AGENTS、plans、changes.md:313-342、六文件diff与受影响actions/schema/消费者。两笔明确ID、范围、命令、兼容/回滚及限制；实现方plans交付登记非PM验收，未自行勾选。仅client/脚本/文档，无server、schema/migration、权限/无viewer例外、schedule/callback、来源/刷新快照、健康/训练分析公式改动；沿输入→SetSaveMachine→requestSave→现有owner-only updateSet/DB更新→invalidate/refetch→adopt→逐组文字/finish追踪，未把静态门禁视为身份运行矩阵。既有W0.3目标归属缺陷保留，不重复新建。
  - **P1 同组“串行”等待会分叉，旧写可覆盖新值。** `workout-log/client/src/App.tsx:713-745` 仅在进入时检查一次inflightRef，多个blur/debounce/finish调用等待同一promise后，恢复时不再检查/锁定队列。独立抽取真实requestSave及全部实际状态函数，用deferred transport和内存值模拟现有updateSet无条件更新（server/actions.ts:414-425）：初始合成10，发A=20；输入30后两个触发器等待A；放行A，B1/B2同时发30；先提交B2，输入并提交C=40，再提交迟到B1，模拟持久化变30而本地draft/confirmed仍40且显示saved。seq仅忽略旧返回，不能撤销旧DB写。预期同组始终只有一个未完成写，合并/排队最新草稿且所有flush等待整个队列排空；不可只补seq单测或用延迟返回冒充乱序落库。下一必须交真实requestSave多等待者+中途再编辑+迟到写的可复跑反例与修复断言，核对最终持久化、UI和finish三者一致；先限本客户端闭环，不扩成跨端版本系统。
  - **P1 拒绝仍被确认保存；在途回退误报干净。** App.tsx:727-735丢弃updateSet响应，server/src/actions.ts:95,402-425允许正常resolve `{ok:false,forbidden:true}`；真实requestSave模拟该合法响应后仍confirmed=新输入/status=saved。必须明确检查业务成功，拒绝/ok=false留输入、呈错误可重试，不能靠catch。另:541-546优先把draft==旧confirmed判saved，即使冲突写仍在途；合成10→发20→回改10时状态saved、inflightDraft=20，:584-586允许refetch采纳其他值覆盖输入，:1004-1012的离开提醒也随saved消失。预期未决写/待恢复输入仍受保护，刷新不得覆盖，失败/回退/补偿保存完成前不标已保存。需真实requestSave+adopt的在途回退、成功/失败、重试、refetch及beforeunload聚合控制，保留null/真实0。
  - **P1 结束门未消费保存结果/未完成状态。** App.tsx:1031-1042丢弃Promise.all中flush的boolean，只看文字状态；初始legacy completed=true/reps=null可为saved且blocked，requestSave/flush返回false却仍调用complete。独立抽实际handleFinish并用flush=false/status=saved句柄确认直接complete、无确认；随后将真实init/requestSave/flushSave/handleFinish串接，completed=true/reps=null合成初态复现零update写入但一次complete、零确认。done/total仅在:1107显示，未完成但已保存的组也无明确结束确认，未满足原W-UI范围。预期任一false/reject/blocked/dirty/error或仍在途不得静默完成；未完成组需明确确认，且以结束时最新句柄/草稿判断，确认弃改时无旧队列在结束后继续写。仅修该数据可信闭环，保留原API和W0.3边界；要求真实flush/finish可执行控制（包括结束过程中编辑、失败重试和已完成组改数后立即结束），再给owner保存回读和匹配页面证据。
  - **计时范围登记，后续处理。** :605-658以截止时间派生剩余，后台时间跳变/+30到期重锚/改档只影响下次/跳过保留配置的源码与函数控制可保留。:971-973每次完成无条件start，RestTimerState与Panel仅静音/跳过，无本次训练关闭自动计时的开关；跳过后下一组仍重新启动。“可选/关闭计时”不能以静音替代。:1086-1103把面板置于所有exercise之后，未按原需求放当前动作卡下，长手机列表无法在当前组附近操作；这是源码范围差异，未声称已实测溢出。先返工上一保存闭环，再按原W-TIMER补本次训练可关闭/重启行为及当前动作位置，不新增持久化/暂停/服务端写。声音是否能在移动端策略下播放、后台恢复和单手操作必须owner实机验证，不能凭WebAudio源码宣称成功。
  - **独立检查与运行边界。** 交付脚本autosave39/39、rest-timer40/40（均含实际执行变异）通过；PM用Node stdin抽取当前真实纯函数、requestSave、flushSave、handleFinish，9项缺陷/时序控制、12项正常/边界控制及1项真实init→requestSave→flushSave→handleFinish整合legacy受阻反例通过（合计22：零/null、clean不写、失败保留/受阻、真实等待分叉/模拟迟到落库、拒绝、在途回退/refetch、结束false、计时截止/后台跳变/静音/加时/skip后重启）。传输、持久化和句柄为合成mock，未运行React/schema/action/artifact，不是线上利用或owner运行证明。Gate `a60b465..d592513`通过6files/2scripts/4implementation，两笔逐段Gate各5/1/3通过；diff --check通过。首次误用Gate --help被当ref拒绝，随后按实际位置参数重跑通过，无仓库脚本修改。六个变化blob窄UUID/INITIAL/固定device均0，个人路径命中1个既有plans；新增行四模式均0，不输出个人内容，不当全面隐私认证。
  - **交接。** 当前无Muse artifact builder/invoke_action；未本地build、装依赖或访问app.db。新timer交付声明cp后线上/回灌逐字一致，是新映射证据进展，但尚无可复核最终部署引用/时间+实际源码hash/diff与owner完整流程/390×844、430×932、桌面证据；不要求不存在的平台version号，原运行门槛保留、不重列旧阻塞。W-UI其余视觉仍未交，计时器提前推进不等于保存基础已通过；下一唯一实现为上列W-UI同一数据可信闭环返工，其他原P0/运行门槛不变。此次为新问题首次独立返工，不触发两轮无进展用户决策。修改前fetch远端仍d592513；本轮只改plans，游标=本轮开始远端，保留20条，提交前再fetch保护并发。

- 2026-10-17 02:51 PDT · `309d9a7`（新增 `5e348cf` / `309d9a7`）· **批量事后结案，W-UI已修分项已验证，新结束边界入W-FINISH-001；产品交互W-UI-001-D1已给出。** 从清洁main681f3f7安全fetch/快进到本轮起始origin/main309d9a792741e8079c257651c50036654f3a25fd，动态枚举全部增量；按CHARTER取消历史验收链，只改plans和根AGENTS。交付69/69、timer40/40；PM实际抽取queue/flush/seal/handleFinish/confirm等函数，22项独立synthetic控制通过并复现3个新结束边界反例（transport/persistence/registry受控，非React/action/artifact实测）。初次抽取遗漏async关键字导致stdin harness解析失败，修正抽取后22项通过，未修改仓库验证脚本。Gate681f3f7→5e348cf、5e348cf→309d9a7、d592513→309d9a7均通过；diff检查通过。新交付无server/schema/migration/权限/来源变更；沿输入→owner-only updateSet→单写队列→确认状态→完成action→UI追踪，W0.3旧边界仍在同队列。批量表保留每个已交ID/SHA/A-B/已验证范围/问题与固定判据，缺A证据合入EVID-LIFE-001，不假称实测、不把缺证当P0；B归档与结构性owner截图不阻塞。不重复未变hash旧检查，无Muse builder/invoke_action，未本地build/装依赖/碰app.db。交付可见增量1、申报上线1、所有者新增确认0，队列中位等待缺startedAt/部分queuedAt不可计算。旧源码关闭不因页面材料重开；新方案承接W-UI原范围，不新建系统；保留原方向/P1期限。提交前再次fetch安全整合，保留最近20条。

- 2026-10-17 06:00 PDT · `3cb7d84`（交付 `e2137e0` / `3cb7d84`）· **两批事后结案；3项P0存档边界及1项P1建议一致性问题已入队，H-LOAD-001-D1事实趋势方案已给出。** 清洁main安全fetch/快进，起始远端与游标见状态，排除PM-only24216ff。已读CHARTER/root/workout及方案相关health AGENTS，逐笔diff/changes与输入→owner门禁→并发→DB→返回→页面调用链。四项交付回归69/35/34/48均过，逐笔Gate/diff检查通过；PM17项独立synthetic控制复现W0.3三竞态、start误删已完成记录、真实调用建议冲突、两结束窗口，并验证串行/失败恢复/owner门禁对照。无SDK/React/artifact运行结论。源码已修分项与计时范围结案，缺A运行证据仍EVID-LIFE-001、B形式不阻塞。5项已交付用户行为，Muse报告space-6两次上线、owner新确认0；可计算已开工等待样本n=1约21分钟，全队列/未开工缺时间戳不可算。新方案原始7日事实不冒充恢复评分，不重置10-18方向/10-20旧P1期限。仅改plans；清理自建临时脚本，不碰业务/schema/changes/app.db；保留20条流水，固定缺陷/判据/排期/发布事实在正文持久保留。提交前再次fetch确认origin/main仍3cb7d84，新增行四项窄隐私扫描均0、ID完整性/20条流水检查及diff --check通过；PM-only Gate提交后推送前执行，结果记录automation memory。

- 2026-10-17 09:03 PDT · `42ef240` · **四范围全部事后结案；W-ACTIVE源码竞态关闭，W-START/W-FINISH/W1-CONSISTENCY原边界继续，D1交互/字段映射方案已交。** 清洁main安全快进，起始远端及游标42ef240602fb1d9e03e88078a5fd6b35fea9d98e，完整增量排除8a472f9 PM-only。逐文件diff/changes/输入→owner→并发→持久化→返回→页面独立追踪；交付45/69/34/48与Gate5/1/3通过，PM真实函数/内存SQLite受控40断言通过，不是SDK/React/artifact运行。三原晚到写拒绝与已完成B保护已验证；持续双active、pending-add未注册时静默结束、最近训练缺动作建议分歧沿原ID/固定矩阵记录，已修分项不重开。4项具体已交付行为，Muse07:22PDT上线申报、独立生效/owner确认无；全队列中位等待缺时间戳，已有开工样本n1约21分钟，完全未开工可算样本H-LOAD-D1 n1约3小时3分，均不冒充总体。W-UI-D1状态/焦点与H-LOAD-D1四字段/缺值日期映射已给出，10-18目标及原方向/P1上限保持。L1原排期裁决不重复发问，其余P0继续，指定L0.1例外不重开；A实际运行缺证仍EVID尾巴、B形式不阻塞。仅改plans；不build/装依赖/碰app.db，临时脚本清理，提交前fetch动态核对并保留20条流水，PM-only Gate和推送结果记memory。

- 2026-10-17 12:05 PDT · `5992544`（六笔新增，源清单见本轮正文）· **七项交付行为全部事后标注；两P0三P1沿原ID继续，F1.2/F2.1-D1首条事实卡入队。** 清洁main从6031848安全fetch/快进，起始origin/main5992544712cfe5eb5bbdaf224091e949bb083b11，排除6031848 PM-only；受影响root/三app AGENTS、changes、逐笔diff及调用链已审。七组交付脚本76/47/35/69/48/35/12全过，聚合16/5/14与六笔逐段Gate/diff过；PM真实函数/内存SQLite受控59断言，非SDK/schema/React/artifact成功声明。正常初始化隔离、窗口内缺动作回退、财务损坏恢复、D1聚合/折叠/焦点源码分项已验证；初始化让位/失败恢复、加组延迟注册、两端20条范围、七日完整日、财务无值状态原ID问题已给全判据。缺运行证据EVID、B形式尾巴不阻塞，L0.1批准例外不重开。交付行为7、owner新确认0，全队列等待缺真实时间戳；历史开工n1约21分钟不冒充总体，H-LOAD-D1移出未开工样本。F2.1-D1既有方向首条余额事实卡10-19，原10-18/10-20/10-22期限不延长；L1旧排期裁决不重复。仅plans实质变更；临时合成脚本清理，未本地build/安装/碰app.db。提交前fetch保护并发，20条流水，PM-only Gate/推送结果记memory。

- 2026-10-17 15:03 PDT · `bb539fb`（四笔源SHA见正文）· **六项交付行为全部事后标注；W-START接管竞态原P0继续，F2.1-D1余额来源P1，F0.3/F0.4月度事实设计已细化。** 清洁main bcc0bfa安全fetch/ff；逐笔四段Gate和聚合11/4/9、八组脚本98/57/69/35/48/55/12/52退出0，PM真实函数＋内存SQLite受控44断言通过（含反例），非SDK/React/artifact成功。W-FINISH注册/W1跨窗口/H-LOAD完整日/F0.2四态源码返工关闭；start历史失败已修，接管删除0行或多个等待者可双ready，F2首卡把非余额条目计作账户，原ID/固定判据排期保留。六项具体交付增量，所有者新增确认0，全队列中位等待缺时间戳不可算，历史开工n1约21分不冒充总体。F0.3/F0.4同月唯一选择＋完整性unknown/partial/complete与消费边界设计10-18，旧10-20上限不重置，健康/训练重点与HH暂缓决定保持；L1原裁决不重复。EVID运行与B形式尾巴不阻塞，L0.1批准例外不重开。仅plans；最老L1记录未完判据迁入最新持久段，保留20条；临时脚本清理，无本地build/依赖安装/app.db，提交前fetch及PM-only Gate/推送结果记memory。

- 2026-10-17 18:07 PDT · `c65bea3`（三笔b65f184/45647b3/c65bea3）· **7项交付行为事后结案；训练/余额来源源码返工关闭，F0.4/HH0.2原P0继续，W4.3-D1完成回执入队。** 干净main136561b安全fetch/ff，起始远端全SHA/增量见正文；受影响三app AGENTS/diff/输入→身份→并发→持久化→返回→页面链已审。七组脚本66/98/57/82/50/12/36过；聚合Gate15/5/12过，训练单笔缺changes失败如实保留、下一笔补齐后合包11/4/8过，后两笔逐段过，diff过。PM实际三app handler/真实条件SQL+隔离SQLite及客户端函数65控制通过（含bug复现），非SDK/Zod/Drizzle库/React/artifact证据。训练两接管竞态收敛一ready且草稿保留、余额来源只计净资产组成已验证；财务日期当覆盖、看房新running接旧/并发重复回调沿原ID完整判据继续，缺平台通道证据仅EVID。已交付行为7，owner新增确认0，全队列中位等待缺真实时间戳不可算，新开工完整样本0、历史n1约21分不冒充总体。新W4.3-D1在既有训练方向推进完成回执/真实回读/同源建议目标10-19；原10-18/10-20/10-22及L1裁决保留，其他可执行项不停。20条流水、最老未完要求迁入正文/持久表，仅plans；未build/装依赖/碰app.db，临时工具清理，提交前fetch保护并发，PM-only Gate/正常push结果记memory。

- 2026-10-17 21:00 PDT · `649b132`（954cfc6登记/649b132交付）· **财务两旧复现已修，原完整性P0余项继续，色弱源码范围已验证；F0.4/F0.5指标依据/缺口设计交付。** 清洁main安全fetch/ff，起始origin/main全SHA及完整增量见21:00正文，排除a4271a1 PM-only。四交付脚本53/16/82/12与两逐段/聚合Gate及diff检查过；PM实际完整finance handler→隔离SQLite保存回读→实际消费者56项synthetic控制过，含余额非空被提升全月完整/缺失投入变0的原单余项复现，非SDK/Zod/Drizzle库/React/artifact证明。F0.4两个旧例关闭，F-UI符号/文字/中性/色板接线已验证；HH0.2旧回调与并发重复无新修复保持原10-18，W4.3-D1未开工目标10-19。已交付可见行为2、owner新确认0；全队列中位等待缺时间戳不可算，已开工新增完整样本0，确认完全未开工子样本W4.3-D1 n1为2小时53分25秒，不冒充总体。原方向/10-18/10-19/10-20/10-22期限、固定判据与L1裁决保留，L0.1例外不重开；A补证/EVID及B形式尾巴不阻塞，仅plans改动，20条流水和最老未完要求持久保留。无build/依赖安装/app.db，临时脚本清理，提交前fetch保护并发，PM-only Gate/正常push结果记memory。

- 2026-10-18 00:08 PDT · `a9a7ca9`（35ae750/544af8f/a9a7ca9）· **三笔事后结案：财务新写入分项/看房校验片已验证，F0.4旧存档与HH0.2原P0继续；训练回执声明待补实际源码。** 清洁main安全fetch/ff，起始远端全SHA/逐笔范围见00:08正文，排除5ec6ca4 PM-only。五交付脚本57/84/12/16/44、三逐段Gate与diff过；PM完整实际新旧finance/house handler＋隔离SQLite/真实客户端函数40项synthetic控制过，含legacy完整标记绕过新依据、旧失败结算新running、CAS输家仍并发重复保存的原问题复现，非SDK/Zod/Drizzle库/React/artifact成功。旧stale/串行/早于起点成功分项及新同步余额-only关闭，不重复立单；HH0.3原子可见性余项/回执原矩阵补证同队继续，B材料不阻塞，L0.1例外不重开。申报交付6具体行为（5源码可复核＋1仅artifact声明）、owner新确认0；全队列等待缺时间戳不可算，新增完整已开工样本0，W4.3-D1已交付移出未开工子样本，不能用Git时间反推开工。产品推进给训练同源建议依据布局、看房旧期可用/整期原子发布备选，既有方向内、不加新系统；原10-18/10-19/10-20/10-22期限及L1裁决保留，有修复进展不升级两轮无进展。仅plans实质修改，最老脱敏记录归并且关闭事实/未完判据持久保留、20条流水；无build/依赖安装/app.db，临时工具清理，提交前fetch动态保护并发，PM-only Gate/正常push结果记memory。

- 2026-10-18 03:10 PDT · `56628f4`（五笔需求/接单文档及一笔看房交付，完整SHA见03:10正文）· **HH两旧复现源码关闭；三真实发布/状态边界沿原P0继续，用户财务批次正式回应及现金试算交互已给。** 清洁main d339b14安全fetch/ff，起始远端56628f4cf38a8bfba45230a8ab29c9085dc261ec，排除d339b14 PM-only；完整增量/changes/受影响AGENTS与输入→身份→代次→SQL保存/发布→返回→页面已审。交付67项过，Bun50项仅Muse申报未独立跑；PM完整真实handler＋受控adapter/原迁移SQLite内存29项synthetic控制过（含预期缺陷复现），非SDK/Zod/Drizzle库/React/artifact证明。旧失败/输家绕过、有旧期候选隔离源码关闭；settled再发布、迟到spawn覆盖、首库半成品沿HH0.2/HH0.3完整判据继续。F0.4旧blob因同app侧聊构建顺延，10-18Muse不变；W4.3源码补证10-19。前三财务间接上线声明缺实际交付证据，四项进行中/勿重复派builder；沿F1.1现金勾选/余额日期与支出依据独立反馈、F2.3搜索固定全仓分母方案已交。可核对交付行为3、owner新确认0，全队列等待缺queuedAt/actualstartedAt不可算、新增完整已开工样本0；Git时间不当生效/开工时间。六逐段/聚合Gate和diff过；旧blob/健康/训练未变检查复用，L0.1例外不重开，原10-18/19/20/21/22期限及L1裁决保留。仅plans实质修改，最老3767c92脱敏/整周关闭事实及未完矩阵归并持久段、20条流水；无build/依赖安装/app.db，临时工具清理，提交前fetch动态保护并发，PM-only Gate/正常push结果记memory。

- 2026-10-18 06:12 PDT · `c5cf74c`（交付6d349b7/c5cf74c，全SHA见最新正文）· **两批8项行为已交付逐项标注；看房三边界及F0.4旧blob源码关闭，财务4原ID余项入队，期间核对卡方案已交。** 清洁main安全fetch/ff、起始远端/游标c5cf74c9a6eb8d8a4482810a6af8304b04ec1116；全量增量排除PM-only d64488b。真实handler/输入→身份→状态→SQL保存→返回→页面独立追踪；原生76/84/12/16、临时提取器适配60/35/45/51/71均过，后者非原TS编译器环境；PM51项synthetic控制含原旧writer→新getter和新bug反例，非SDK/Zod/Drizzle库/React/artifact运行。看房settled/跨代spawn/首库半成品与F0.4旧blob原源码返工关闭；F0.6双端口径、F1.6期初/期间/投资本金、F1.1未核实现金、F2.3冲突现金币种沿原ID/原日程有问题，已修分项不重开。可核对交付行为8、owner新确认0，全队列中位等待缺queuedAt/actualstartedAt不可算、新增完整开工样本0。两app申报上线与实际生效/owner确认分账，08:39PT财务周刷新尚未到；F1.6/F0.5双端来源/期间核对交互已交，健康/训练重点、原方向/10-18/19/20/21/22期限及L1裁决保持。逐笔/聚合Gate5/1/3、13/7/10、16/8/13及diff过，增量四窄隐私扫描0。原A补证仍EVID、B形式非门控、L0.1指定例外不重开。仅plans修改，最老H-LOAD固定矩阵已迁最新正文、20条流水；不build/装依赖/碰app.db，scratch清理，提交前fetch动态核对，PM-only Gate/正常push结果记memory。

- 2026-10-18 09:10 PDT · `e50d938`（一笔交付，全SHA见本轮正文）· **财务5组行为逐项标注；旧反例有效关闭、四原ID余项继续，逐区间/渠道核对方案已交。** 清洁main4029c34安全fetch/ff，起始远端e50d938b42dfce4c2b154270419982a2ff154a80；排除4029c34 PM-only，审全11文件/changes/真实输入→owner→状态→保存→getter→消费者，未变健康/训练/看房复用。原生85/12/16、五提取器适配71/73/55/59/61全过，非原TS AST环境；独立47断言+4观察输出，完整新旧Actions及内存行adapter重现期间错配/旧blob，不是SDK/Zod/Drizzle/SQLite/React/artifact证明。F0.6同月旧端点、F1.6跨来源覆盖与金额错期/缺期间、F1.1旧未核实现金、F2.3旧冲突币种沿原级别/日期继续，已修分项不重开；EVID/B尾巴不设闸、L0.1例外保持。已交付行为5组/owner新增确认0，全队列等待缺queuedAt/actualstartedAt不可算，新完整开工样本0。Muse申报14:26Z构建审计及9文件cmp一致，08:39PT刷新已到但无回执，不造运行成功/失败。沿F0.5/F1.6按实际区间/现金及非银行渠道分别核对与候选金额设计已给，原10-18/19/20/21/22及L1裁决保留。Gate11/6/9与diff过；只plans，最老HUI固定矩阵及后续关闭事实迁入持久段、20条流水；临时工具清理，无本地build/依赖安装/app.db。提交前发现9b78412仅14行PM反馈，安全stash自有plans→ff→无冲突恢复，原生字段/精确日期并入同单且独立补验8项；PM-only Gate/正常push与最终SHA记memory。
