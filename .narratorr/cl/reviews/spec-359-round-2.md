---
skill: respond-to-spec-review
issue: 359
round: 2
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: Event-history error strings wrong in M-11 contract
**What was caught:** The error-mapping contract said `'not in a retriable state'` → 400 for event-history, but the actual route checks `'does not support'` / `'no associated'` / `'no info hash'`.
**Why I missed it:** When building the error-mapping contract in round 1, I read activity.ts carefully but paraphrased event-history.ts from the subagent's summary instead of reading the actual route file.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes before writing): "For error-mapping contracts, read the actual route handler source for every row in the table. Copy exact string match patterns — do not paraphrase."

### F2: M-6 file list missing test files with vi.mock
**What was caught:** Two test files use `vi.mock('../../../core/utils/index.js', ...)` which also need updating when the path alias changes.
**Why I missed it:** Grep only searched for `from` import statements, not `vi.mock()` calls.
**Prompt fix:** Add to `/elaborate` step 10: "When inventorying import paths for alias migration, grep for the module path as a plain string (not just `from` imports) to catch vi.mock(), jest.mock(), and dynamic import() patterns."

### F3: L-23 verification targeted wrong import surface
**What was caught:** L-23 test plan said "grep for deep relative `core/` imports" which is M-6's surface, not L-23's shared schema sub-path concern.
**Why I missed it:** Copy-pasted M-6's grep check when adding L-23 test plan entries, didn't adjust the target pattern.
**Prompt fix:** Add to `/respond-to-spec-review` step 5: "After drafting fixes, cross-check each test plan entry against its AC — the grep/build pattern must verify the AC's specific claim, not a sibling AC's surface."
