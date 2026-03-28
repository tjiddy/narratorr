---
skill: respond-to-pr-review
issue: 96
pr: 129
round: 1
date: 2026-03-26
fixed_findings: [F1]
---

### F1: Mega-beforeEach preserved after refactor
**What was caught:** The parent `describe('ImportService')` still had a shared `beforeEach` initializing DB, logger, service, and all fs mocks for every nested suite, violating AC2 ("each describe block has its own focused beforeEach setup, no shared mega-setup").

**Why I missed it:** During implementation, I saw that `upgrade flow` and `remote path mapping` already had nested `beforeEach` blocks and interpreted those as the "focused setup" the spec asked for. I treated the parent `beforeEach` as an acceptable shared baseline rather than recognizing that its existence itself was the violation.

**Prompt fix:** Add to `/implement` step 4 (implementation guidance): "For refactor issues where an AC says 'each X has its own Y' (e.g., 'each describe has its own beforeEach'), explicitly verify at the end that NO parent-level Y remains — the AC means ownership, not supplementation. Grep for `beforeEach` at the parent scope and confirm it's gone."
