---
skill: respond-to-pr-review
issue: 214
pr: 218
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3]
---

### F1: restore() leaves recycling entry unretryable after post-move DB failure
**What was caught:** Filesystem move happens before the transaction; if the transaction fails, files are at originalPath but recyclePath is empty → next retry throws "Recycled files not found on disk".
**Why I missed it:** The spec explicitly noted "filesystem move stays outside transaction" and the test plan included "Filesystem move remains outside transaction: file move is irreversible and stays before the transaction boundary." I treated this as a complete solution without considering what happens to retryability when the transaction fails afterward. The self-review also didn't flag it because it focused on checking AC items, not emergent failure modes.
**Prompt fix:** Add to `/implement` step 4 general rules: "When wrapping operations that have irreversible side effects (filesystem, network) before the transaction boundary, verify that a transaction failure leaves the system in a retryable state — if not, add compensating actions."

### F2: tx-propagation test is vacuous due to mock identity
**What was caught:** Using `expect.anything()` for the tx argument when the mock transaction() returns the same db object means the test can't distinguish `syncAuthors(tx, ...)` from `syncAuthors(this.db, ...)`.
**Why I missed it:** I knew the mock transaction passed `db` as tx but didn't think through the implications for the identity assertion. The test "looked right" superficially.
**Prompt fix:** Add to `.claude/docs/testing.md` test quality standards: "When testing parameter forwarding through mock boundaries, ensure the mock provides a distinct object for the forwarded parameter. If the mock returns the same object as the parent context, `expect.anything()` or identity-agnostic assertions are vacuous."

### F3: Rollback tests only assert errors, not post-failure state
**What was caught:** Rollback tests verified error propagation and transaction invocation but didn't assert what the system looks like after the failure — specifically, whether files were restored.
**Why I missed it:** The test plan said "recycling entry preserved for retry" but I only tested that the recycling entry delete wasn't called, not that the filesystem was actually in a retryable state. I stopped at the DB layer assertions without considering the full system state.
**Prompt fix:** Add to `.claude/docs/testing.md` test quality standards: "Rollback tests must assert the full post-failure system state, not just error propagation. When operations have side effects outside the rollback boundary (filesystem, external APIs), verify compensating actions were taken and the system is in a consistent, retryable state."
