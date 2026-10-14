# Collaboration contract

- `plans.md` is the source of truth for requirements, priorities, acceptance and rework. PM owns it; implementers must not edit requirements or mark their own work accepted.
- Muse implements one requirement at a time. Cite its existing ID before work. If the requirement has no ID or acceptance criteria, ask PM to define them first.
- Prefer a `muse/<id>-short-name` branch and a PR for implementation. PM documentation may go directly to `main`. Never force-push or overwrite another contributor's work.
- Every implementation updates `changes.md` with requirement ID, scope, changed files, schema/migration compatibility, exact verification commands/results, sanitized runtime evidence, limitations and rollback. A checkbox or “tested” is not evidence.
- After push, run the Handoff Gate and request immediate PM review through an available user-authorized channel. If no immediate review integration exists, record the handoff in `changes.md`; the three-hour watchdog will catch it. CI success is not PM acceptance.
- PM accepts only against `plans.md`, writes specific rework there and changes acceptance checkboxes. After two unsuccessful attempts on the same issue without new evidence, ask the human to resolve the blocker.
- Read the affected app's nested `AGENTS.md`. Artifact build/audit/submit uses the supplied builder interface; do not run local `bun run build`, edit `.space-build/`, or access `app.db` directly. Missing runtime access means “运行待验”.
- Never commit personal health/fitness/financial records, identifiers, secrets or unsanitized runtime output. Preserve honest missing/partial/stale states.

The GitHub gate performs deterministic handoff checks. It does not replace type checks, formula fixtures, owner/guest/anonymous action tests or artifact runtime review.
