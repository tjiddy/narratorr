---
skill: respond-to-pr-review
issue: 350
pr: 375
round: 1
date: 2026-03-14
fixed_findings: [F1, F2]
---

### F1: Scanner path assertion missing
**What was caught:** The C-2 regression test didn't assert what path `scanAudioDirectory` received, so the bug could regress silently.
**Why I missed it:** Focused on testing the WHERE clause fix and the shared utility in isolation. Didn't consider that the integration point — where the utility's output feeds into `scanAudioDirectory` — also needed assertion.
**Prompt fix:** Add to /implement step 4d (sibling enumeration): "For bug fixes that change what value is passed to a mocked dependency, add an argument assertion on the mock to prevent silent regression. The mock will accept any input — the test must verify the correct input."

### F2: DB write contract not asserted
**What was caught:** `revertBookStatus` tests only asserted the return value, not the `.set()` payload or `.where()` target.
**Why I missed it:** Thought `expect(db.update).toHaveBeenCalled()` was sufficient. Didn't consider that the DB chain could be called with wrong arguments and still return the right string.
**Prompt fix:** Add to testing standards: "When testing utilities that perform DB writes via mock chains, assert the full persistence contract: `.set()` payload values AND `.where()` predicate targeting the correct row. A return-value-only assertion does not prove the write is correct."
