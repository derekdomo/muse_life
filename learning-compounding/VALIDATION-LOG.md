# VALIDATION-LOG — 校验脚本实跑归档

CMP-LEARN-SAVE-001 证据闭环：本文件归档三个校验脚本的完整实跑输出（各自 passed/failed 计数与退出码），作为 arbitrateConversion 原子仲裁与 revokedAt 墓碑实现的实跑证据。

## 运行口径

- **运行日期**：2026-10-20（America/Los_Angeles）
- **运行环境**：工件源码目录，`bun` 直接执行脚本（入口已登记在 `package.json` scripts：`validate`、`validate:metrics`、`validate:conversion`）
- **数据口径**：全部为 **synthetic（合成）数据 + 一次性内存 libsql 数据库**（schema 由 `drizzle/*.sql` 在内存库中施加），经合成 ctx 调用 `server/src/actions.ts` 的真实 handler。**真实 `app.db` 在任何脚本中从未被打开**，归档输出不含任何用户真实数据。

## 汇总

| 脚本 | 覆盖范围 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `validate-conversion.mjs` | CMP-LEARN-SAVE-001：首次转化原子仲裁（conditional claim + RETURNING + 同批回执）、撤销墓碑（revokedAt 不删行）、丢响应重放/冲突、代际重标、曲线/队列一致性、旧行兼容 | **40 passed, 0 failed** | 0 |
| `validate-acl.mjs` | CMP-LEARN-ACL-001：全部 10 个 action 的严格所有者门（门在任何 ctx.db 访问与 ensureSeeded 之前）、非所有者/匿名零数据库访问零写入、所有者路径读写回环 | **82 passed, 0 failed** | 0 |
| `validate-metrics.mjs` | CMP-LEARN-METRIC-001 +「挑一条去用」：发生时间序列（LA 日界）、首次转化幂等、队列窗口与观察截止、分钟数未知口径、attempt→saveOutput 闭环 | **34 passed, 0 failed** | 0 |

合计：**156 passed, 0 failed**，三个脚本退出码均为 0。

## 完整输出

### validate-conversion.mjs（退出码 0）

```
PASS: source: arbitrateConversion uses a conditional claim (converted_at IS NULL) with RETURNING
PASS: source: claim and receipt insert are one atomic batch
PASS: source: saveOutput routes through arbitrateConversion
PASS: source: markConverted routes through arbitrateConversion (shared path)
PASS: source: unmark tombstones receipts (revokedAt) and never deletes them
PASS: source: payload identity is a SHA-256 hash of (outputType, outputNote)
PASS: race (A,B) diff keys/payloads: exactly one converts, the other alreadyConverted (a=converted b=alreadyConverted)
PASS: race (A,B): loser echoes the winner's convertedAt and output
PASS: race (A,B): stored row is the winner's (output, key, first convertedAt untouched by loser)
PASS: race (B,A) diff keys/payloads: exactly one converts; row matches that winner (a=alreadyConverted b=converted)
PASS: race same key+payload: one converted + one idempotent replay, one receipt (s1=converted s2=alreadyConverted receipts=1)
PASS: race same key diff payloads: one converts, the other conflicts; row holds the converted payload (d1=converted d2=conflict)
PASS: save x mark race: exactly one conversion, counted once (save=converted mark=alreadyConverted)
PASS: lost-response setup: first save converts
PASS: same key + same payload after lost response: idempotent replay of the original result
PASS: same key + different payload: conflict, rejected, stored output untouched
PASS: same key reused for a different input: conflict, that input stays unconverted
PASS: revoke setup: generation 1 converts
PASS: unmark: row unconverted; receipt kept as a tombstone (revokedAt stamped, row not deleted)
PASS: late retry with the revoked key: status revoked, ok false, nothing written (no resurrection)
PASS: late retry via markConverted with the revoked key: also revoked, still unconverted
PASS: fresh requestId re-marks as a new generation with a new conversion instant
PASS: generations coexist: gen-1 tombstone + gen-2 live receipt
PASS: failed conversion write: status error, row stays unconverted, no receipt left behind
PASS: same key succeeds once writes recover (the failed attempt reserved nothing)
PASS: failed unmark: error surfaces and the existing output survives intact
PASS: failed write against a converted input: alreadyConverted echo, output intact
PASS: curve/cohort: conversion lands on today's series point and in the cohort, stamped with the first convertedAt (row=2026-10-20T14:36:59.721Z saved=2026-10-20T14:36:59.721Z)
PASS: curve/cohort: revoked + late old-key retry leaves totals, series and cohort at zero converted
PASS: curve/cohort: new-generation re-mark counts exactly once, on the new first convertedAt
PASS: non-owner: conversion actions refused with status refused
PASS: non-owner: zero database access (dbCalls=0)
PASS: anonymous: conversion actions refused with status refused
PASS: anonymous: zero database access (dbCalls=0)
PASS: guest storm wrote zero rows (inputs and receipts both empty)
PASS: legacy rows read back exactly as stored (converted, original outputs, legacy 0 minutes kept)
PASS: legacy keyless row: a new key only echoes alreadyConverted with the original instant; nothing rewritten, no key fabricated
PASS: legacy keyed row: stored key preserved (not overwritten by the echoing call)
PASS: no receipt was fabricated for either legacy conversion
PASS: legacy row unmarked then re-marked with a fresh key: converts as a new generation

40 passed, 0 failed
```

### validate-acl.mjs（退出码 0）

```
PASS: source: isOwner is exactly ctx.viewer?.isOwner === true
PASS: source: no anonymous/no-viewer exception helper exists
PASS: source: getDashboard is gated
PASS: source: getDashboard gate precedes any ctx.db access
PASS: source: getDashboard gate precedes ensureSeeded
PASS: source: addSkill is gated
PASS: source: addSkill gate precedes any ctx.db access
PASS: source: updateSkill is gated
PASS: source: updateSkill gate precedes any ctx.db access
PASS: source: deleteSkill is gated
PASS: source: deleteSkill gate precedes any ctx.db access
PASS: source: recordLearningInput is gated
PASS: source: recordLearningInput gate precedes any ctx.db access
PASS: source: markConverted is gated
PASS: source: markConverted gate precedes any ctx.db access
PASS: source: unmarkConverted is gated
PASS: source: unmarkConverted gate precedes any ctx.db access
PASS: source: deleteInput is gated
PASS: source: deleteInput gate precedes any ctx.db access
PASS: source: startAttempt is gated
PASS: source: startAttempt gate precedes any ctx.db access
PASS: source: saveOutput is gated
PASS: source: saveOutput gate precedes any ctx.db access
PASS: non-owner: getDashboard refused with empty data
PASS: non-owner: addSkill refused (ok:false, no id)
PASS: non-owner: updateSkill refused
PASS: non-owner: deleteSkill refused
PASS: non-owner: recordLearningInput refused honestly (no row, no auto-created skill)
PASS: non-owner: markConverted refused
PASS: non-owner: unmarkConverted refused
PASS: non-owner: deleteInput refused
PASS: non-owner: startAttempt refused
PASS: non-owner: saveOutput refused
PASS: non-owner: zero database access across all 10 actions (dbCalls=0)
PASS: non-owner: zero writes — no seed rows, no skills, no inputs ({"skills":0,"inputs":0})
PASS: anonymous: getDashboard refused with empty data
PASS: anonymous: addSkill refused (ok:false, no id)
PASS: anonymous: updateSkill refused
PASS: anonymous: deleteSkill refused
PASS: anonymous: recordLearningInput refused honestly (no row, no auto-created skill)
PASS: anonymous: markConverted refused
PASS: anonymous: unmarkConverted refused
PASS: anonymous: deleteInput refused
PASS: anonymous: startAttempt refused
PASS: anonymous: saveOutput refused
PASS: anonymous: zero database access across all 10 actions (dbCalls=0)
PASS: anonymous: zero writes — no seed rows, no skills, no inputs ({"skills":0,"inputs":0})
PASS: owner: first getDashboard seeds exactly the two preset skills (skills=单板 Snowboard/AI / 多智能体工作流)
PASS: owner: seeding is idempotent (second read still 2 skills)
PASS: owner: addSkill ok with id
PASS: owner: updateSkill ok
PASS: owner: rename reads back
PASS: owner: recordLearningInput ok with id
PASS: owner: recordLearningInput with new skillName ok
PASS: owner: inputs read back as written
PASS: owner: dashboard aggregates match the writes ({"totalInputs":2,"totalConverted":1,"totalMinutes":65,"unknownMinutesCount":0,"conversionRate":0.5,"cohorts":{"all":{"windowStart":"2026-10-19","windowEnd":"2026-10-20","asOf":"2026-10-20","eligibleInputs":2,"convertedInputs":1,"rate":0.5},"days30":{"windowStart":"2026-09-21","windowEnd":"2026-10-20","asOf":"2026-10-20","eligibleInputs":2,"convertedInputs":1,"rate":0.5}},"streakDays":2,"activeDays":2,"unconvertedCount":1})
PASS: owner: skillName auto-created exactly one skill
PASS: owner: markConverted ok
PASS: owner: conversion reads back
PASS: owner: unmarkConverted ok
PASS: owner: un-conversion reads back
PASS: owner: startAttempt ok, attempt alone does not convert
PASS: owner: saveOutput converts the attempted input
PASS: owner: saveOutput retry with same requestId is idempotent
PASS: owner: unmark after saveOutput ok (cleanup for delete checks)
PASS: owner: deleteInput ok
PASS: owner: deleted input is gone, the other survives
PASS: owner: deleteSkill ok
PASS: owner: skill deleted; its ledger row survives unlinked
PASS: non-owner: populated DB still returns forbidden + zero data (no leak)
PASS: non-owner: populated DB record refused
PASS: non-owner: populated DB deletes refused
PASS: non-owner: populated DB attempt/save refused
PASS: non-owner: populated DB — zero database access (dbCalls=0)
PASS: non-owner: populated DB unchanged by refused calls ({"skills":3,"inputs":1} -> {"skills":3,"inputs":1})
PASS: anonymous: populated DB still returns forbidden + zero data (no leak)
PASS: anonymous: populated DB record refused
PASS: anonymous: populated DB deletes refused
PASS: anonymous: populated DB attempt/save refused
PASS: anonymous: populated DB — zero database access (dbCalls=0)
PASS: anonymous: populated DB unchanged by refused calls ({"skills":3,"inputs":1} -> {"skills":3,"inputs":1})
PASS: owner: data intact after refused calls from other identities (skills=3 inputs=1)

82 passed, 0 failed
```

> 注：上方 `owner: dashboard aggregates match the writes` 一行中的聚合 JSON 为本次实跑的原始输出逐字归档（含 cohorts 窗口字段），不做任何改写。

### validate-metrics.mjs（退出码 0）

```
PASS: today is the LA day of now (2026-10-20)
PASS: empty sample: no series, cohort rates null （无法计算）, zero totals
PASS: minutes: omitted duration reads back null (unknown)
PASS: minutes: legacy explicit 0 stays 0 （来源不明）, not rewritten to null
PASS: minutes: known sum excludes unknowns; unknown count kept apart (known=75 unknown=2)
PASS: minutes: per-skill known sum + unknown count
PASS: series: input day carries the input (cumulative: the 40-day-old one + this), no output yet (hist={"date":"2026-10-01","inputs":2,"converted":0,"minutes":30})
PASS: series: converting a historical input today does NOT rewrite its input day (hist={"date":"2026-10-01","inputs":2,"converted":0,"minutes":30})
PASS: series: today's point gains the output instead (today={"date":"2026-10-20","inputs":5,"converted":1,"minutes":75})
PASS: backfill: converting an old input grants no streak day (streak=0 activeDays=3)
PASS: conversion instant recorded
PASS: idempotent mark: first convertedAt unchanged, output unchanged, still counted once
PASS: unmark: input returns to unconverted, today's output count falls back
PASS: re-mark after unmark: new conversion time (>= the revoked one), counted once, on today
PASS: cohort (all): every input eligible, converted counted by distinct input ({"windowStart":"2026-09-10","windowEnd":"2026-10-20","asOf":"2026-10-20","eligibleInputs":5,"convertedInputs":1,"rate":0.2})
PASS: cohort (30d): window excludes only the 40-day-old input; the 19-day-old converted input is in-window ({"windowStart":"2026-09-21","windowEnd":"2026-10-20","asOf":"2026-10-20","eligibleInputs":4,"convertedInputs":1,"rate":0.25})
PASS: cohort: per-skill batch excludes other skills and unlinked inputs ({"windowStart":"2026-09-10","windowEnd":"2026-10-20","asOf":"2026-10-20","eligibleInputs":3,"convertedInputs":1,"rate":0.3333333333333333})
PASS: cohort: skill B all-window has its one unconverted input
PASS: cohort: empty skill/window -> eligible 0 and rate null （无法计算）
PASS: boundary helper: midnight-1ms is the previous LA day, midnight+1ms is day X
PASS: boundary: 23:59:59.999 LA conversion counts on the previous day only (prev={"date":"2026-10-16","inputs":2,"converted":1,"minutes":20})
PASS: boundary: 00:00:00.001 LA conversion counts on day X; input days untouched (dayX={"date":"2026-10-17","inputs":2,"converted":2,"minutes":20})
PASS: boundary: cohort observation cutoff excludes a conversion after asOf
PASS: attempt: target starts unconverted with no attempt
PASS: attempt: startAttempt ok with a start instant
PASS: attempt: re-starting keeps the first attempt instant
PASS: attempt: attempting is NOT a conversion (counts and series unchanged)
PASS: save: saveOutput converts exactly once, stamped now
PASS: save: conversion visible — totals +1, output on today (input day unchanged)
PASS: save: same-requestId retry is an idempotent no-op
PASS: save: a second output for the same input counts nothing new (dedupe by input)
PASS: save: converted input can no longer be attempted
PASS: save: unknown input id fails honestly
PASS: unlinked input converts in totals but in no skill cohort

34 passed, 0 failed
```

## 追加归档：CMP-LEARN-SAVE-001 P0 余项修复（2026-10-20 复跑）

**缺陷**：升级到 0004 之前已转化、输入行上存有真实请求键（`conversion_request_id`）但没有 0004 回执的旧记录，`unmarkConverted` 撤销时只清行、不留任何墓碑；之后同一 key+payload 的迟到 `saveOutput` / `markConverted` 重试会找到「无回执、无转化」状态而重新转化、重新计入曲线与 cohort（复活）。

**修复**（`server/src/actions.ts` 的 `unmarkConverted`，`server/src/schema.ts` 同步注明口径）：撤销时先读行，若行上存有真实请求键且该键尚无回执，则在**同一原子 batch** 内先以行自身存储的事实（键、`conversionPayloadHash(outputType, outputNote)` 指纹、首次转化时刻、产出）写入一条已盖 `revokedAt` 的回执（`onConflictDoNothing` 兜底读后竞态），再清行并墓碑化既有存活回执。行上无请求键的旧档不写任何回执，保持「未知」语义。撤销后新 `requestId` 重标、同键同载荷幂等重放、异载荷冲突等既有契约不变；事件分桶/时间口径未动。

**复跑口径**：与上文相同——synthetic 数据 + 一次性内存 libsql 库，真实 `app.db` 从未被打开。运行日期 2026-10-20（America/Los_Angeles）。

| 脚本 | 结果 | 退出码 |
| --- | --- | --- |
| `validate-conversion.mjs` | **53 passed, 0 failed**（原 40 项全过 + 新增 13 项） | 0 |
| `validate-acl.mjs` | **82 passed, 0 failed**（无回归） | 0 |
| `validate-metrics.mjs` | **34 passed, 0 failed**（无回归） | 0 |

合计：**169 passed, 0 failed**。`validate-conversion.mjs` 新增 13 项如下（完整输出以脚本实跑为准，此处摘录新增项）：

```
PASS: source: unmark materializes a revoked receipt for a stored legacy key (payload fingerprint from the row itself)
PASS: legacy keyed: unmark materializes ONE revoked receipt for the stored key (key, payload, original instant all from the row) (receipts=1)
PASS: legacy keyed: late saveOutput with the old key + same payload is rejected as revoked; the fact does not resurrect
PASS: legacy keyed: late markConverted with the old key is also rejected as revoked
PASS: legacy keyed: after unmark + late retries, curve and cohort count zero converted for the input
PASS: legacy keyed: fresh requestId re-marks as a new generation; the materialized tombstone coexists
PASS: legacy keyed: the old key stays revoked even after the new generation converted
PASS: legacy keyless: unmark fabricates no key and no receipt ('unknown' semantics preserved)
PASS: legacy keyless: after unmark, an arbitrary key is just a fresh conversion (no phantom tombstone blocks or revives)
PASS: legacy keyed: failing unmark batch preserves the conversion, the stored key AND writes no tombstone
PASS: legacy keyed: after a healed unmark, the tombstone exists and a failing late retry still cannot resurrect
PASS: legacy keyed: failing new-generation write after revocation applies nothing (row unconverted, tombstone untouched)
PASS: legacy keyed: the new-generation key converts once writes recover
```

## 未验证局限声明（明确未覆盖项）

以下事项**不在**上述三个脚本的验证范围内，归档不构成对其正确性的证明：

1. **竞败者回执 inert 的后续重放行为**：竞态中落败一方的回执按设计为 inert（不参与计数）。脚本验证了竞态当下恰好一次转化、落败方回显胜者结果、以及撤销后旧键迟到重试返回 `revoked` 且零写入；但「inert 回执在更晚时点、跨代际、或与其他新请求交错重放时的行为」未被系统性穷举验证，仅覆盖了脚本中列明的迟到重试场景。
2. **审计环境无法以所有者身份实测真实并发**：脚本中的「竞态」是同一进程内对真实 handler 的顺序/交错调用 + 原子 batch 断言，并非多连接、多进程对同一数据库的真实并发压测；审计（audit）探针通道同样无法以所有者身份发起写操作，因此真实并发下的锁争用、WAL 行为与跨请求交错未在生产等价条件下实测。
3. **合成内存库与真实 app.db 的差异**：脚本使用一次性内存 libsql 库（schema 由 `drizzle/*.sql` 施加），与真实 `app.db` 在数据规模、存量行形态、连接方式（文件/WAL）、迁移历史累积状态等方面存在差异；内存库通过不等于真实库在存量数据上必然无异常，真实库从未被脚本打开或写入。
4. **旧行无回执不补键口径**：回执机制上线前已转化的旧行没有回执，此为既定口径——**不回补、不伪造**（脚本已验证：旧行按原样读回、新键仅回显 `alreadyConverted`、不生成回执、不改写存储键）。其后果是旧行的转化无法用回执做事后对账或重放判定，只能以行本身的 `converted_at` 与存储键为准；该口径未被「修复」，后续如需变更须另行立项。
