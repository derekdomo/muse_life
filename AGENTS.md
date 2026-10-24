# Collaboration contract

## Authority and roles

- Read root `CHARTER.md` first. The product owner's 2026-10-17 shared Incubator/Life fast iteration charter overrides conflicting older instructions here, in `plans.md`, and in review history. Implementation never waits for PM acceptance; PM feedback is information, never a gate for subsequent work or release preparation.
- Muse is the implementer and a proposal source. PM is a feedback source, requirement source, and product driver; PM does not implement production code. The product owner approves new directions, new publication targets, and game publication. Routine self-checked Life updates already have direct-go-live authorization.
- Every substantive PM review includes actionable bug findings (explicitly say if none were found), numbered/scoped/prioritized requirements, and at least one substantive product advancement. Do not fabricate bugs or duplicate requirements to fill a quota.

## One queue, continuous implementation

- Priority: P0 (data safety, authorization, pipeline defects, live/save bugs) > direct user requests > PM requirements and ordinary bugs > evidence/documentation tails. Implementation proposals compete by the same rules.
- Handle all clear executable items per run, without an item or package cap. Bundle similar work; defer only individually time-consuming items and record the item, reason, owner, and date. Keep progressing other executable work.
- Existing-direction small increments may be queued and implemented directly, with their source marked as an implementation proposal in `changes.md`; do not wait for PM to allocate work or accept a predecessor. New systems, new games, and direction changes need the owner's decision first.
- Remove all acceptance dependencies, including Z-ART-002 waiting for Z-ART-001 and C-ART waiting for C3. Explain real technical dependencies without substituting a PM signature for them.
- Ambiguous decisions and spending, external sending, data deletion, account changes, or new publication targets require owner authorization; routine self-checked Life updates already have direct-go-live authorization. Surface a concrete decision while unrelated work continues.

## Quality and feedback

- Self-checks remain mandatory and independent of PM review: Handoff Gate and `changes.md` evidence covering IDs, scope, changed files, exact commands/results, reproducible data, limitations, and rollback. Never claim unavailable runtime verification passed.
- A-class gameplay, balance, data/formulas/pipelines, save/authorization safety and data sanitization require full evidence. B-class presentation and evidence formatting use build audits, verification scripts, and reproduction data; formatting gaps are minor follow-ups, never gates. Actual schema/data migrations are A-class. List requirements once; only real newly discovered defects justify new rework requirements.
- PM reads changed code and affected state/callers, traces input, gameplay, saves and visible feedback, and checks meaningful counterexamples. Muse's self-review supports independent feedback but does not replace it.
- Record each item's revision, evidence class, verified/has-issues annotation, and actionable findings in `plans.md`. All problems become queue items; missing evidence is not automatically a P0 or a reproduced code defect. Reuse same-hash passed checks and do not reopen unchanged issues.
- Implementers record delivery in `changes.md` and do not check their own PM acceptance boxes. PM owns feedback and requirements in `plans.md`, and may maintain these collaboration instructions to match `CHARTER.md`.

## Going live, direction, and measurement

- Life changes that pass self-checks go live directly through the permitted builder workflow, without PM approval or another routine publication request. This is the owner's existing authorization; the final product truth is what the owner personally opens. Distinguish delivered, submitted/live, and owner-confirmed facts; never fabricate the owner's observation. Game publication still requires the owner's approval.
- Severe defects in published content become P0 bugs; propose rollback when necessary and execute according to owner authorization.
- Main statuses: 已上线在用 / 已交付 / 进行中 / 待办 / 已下线. `plans.md` [完成] means delivered only; PM conclusions live separately in review records. PM feedback is a separate annotation; 待 PM 验收 is never a blocking status.
- PM responds formally to user direction/feedback issues in one review cycle and delivers direction proposals in two cycles, alongside backlog feedback. Preserve original deadlines; new directions require the owner's decision before implementation.
- Report player-visible increments delivered this run and median queue waiting time with sample/timestamp definitions. Do not count process edits as gameplay progress or invent missing measurements. P1 targets are days, at most one week; document overruns, blockers, and responsible owners in `plans.md`.

## Repository and platform safety

- Preserve concurrent work: inspect branch/worktree first; never overwrite, force-push, or rewrite another contributor's history. Documentation may go directly to main; implementation may use scoped branches/PRs without waiting for PM acceptance.
- Handoff Gate is deterministic self-checking, not semantic acceptance. Record delivery immediately; request feedback only through a user-authorized channel. The three-hour task catches missed feedback; it must not suspend implementation or shipping preparation.
- Read each affected app's nested AGENTS. Use the supplied artifact builder plan/build/audit/submit; never run prohibited local builds, edit .space-build, or access app.db directly. Missing runtime access must be reported accurately, without becoming a PM gate for other work.
- Never print or commit personal health, fitness, financial records, identifiers, secrets, or unsanitized logs. Use explicitly synthetic fixtures. Preserve honest missing/partial/stale states, source/coverage windows, units and formula definitions; these are A-class safety requirements.
- L0.1 owner-approved exception remains in force: anonymous/no-viewer internal invocation of space-4 refresh and its two save callbacks, and space-6 read-only getDashboard, stays as is. The owner knowingly accepts this risk. Human-facing reads retain strict owner checks; do not expand this exception. Reassess migration when verifiable platform service identity becomes available; do not reopen the same accepted risk each run. The owner may revoke it, which stops synchronization and requires an explicit unavailable state in the UI.

- Separately approved 2026-10-24 F-ARCH-001 exception: only space-3 ingestArchNetWorth may use the scoped owner-or-no-viewer internal write channel (plans/49b14b5). This does not expand L0.1 or authorize other writes or reads. Identified non-owners remain denied; human-facing reads stay strictly owner-only. Routine self-checked Life publication and the approved 2026-11-16 W-HOMEB-002 automatic swap do not need repeated approval.
