---
skill: respond-to-pr-review
issue: 143
pr: 151
round: 1
date: 2026-03-26
fixed_findings: [F1, F2]
---

### F1: Missing frozen progress regression test
**What was caught:** Object.freeze(IDLE_PROGRESS) has no test — deleting it leaves all tests green.
**Why I missed it:** Accepted "no observable behavior change = no test needed." The spec review correctly rejected asserting the private symbol directly, but the hook's *return value* IS publicly testable via `Object.isFrozen(result.current.progress)`. The self-review and coverage subagents both reasoned from "defensive coding change" to "no test needed" without checking whether the public surface exposed the freeze invariant.
**Prompt fix:** Add to `/implement` step 4a under "Test depth rule": "For Object.freeze on a shared constant used as initial/reset state in a hook, assert `Object.isFrozen(result.current.<property>)` is true on initial render and after each reset path — the freeze is testable via the hook's public return value even though the constant itself is private."

### F2: Optional prop weakened contract for all callers
**What was caught:** Making `onModeChange` broadly optional allows future callers to render the interactive dropdown without a handler — TypeScript accepts the inert UI silently.
**Why I missed it:** Followed the AC literally ("make prop optional"). Didn't ask "optional for whom?" — only `LibraryImportPage` needs it omitted, and only when `hideMode: true`. The discriminated union pattern was known from CLAUDE.md/prior issues but wasn't triggered by this scenario.
**Prompt fix:** Add to CLAUDE.md Gotchas: "**Conditionally-required props:** When a prop is required in one usage context but should be omitted in another, use a discriminated union keyed by the controlling flag (`hideMode: true; onModeChange?: never` vs `hideMode?: false; onModeChange: required`) rather than making the prop broadly optional. Broad optional weakens the contract for all callers."
