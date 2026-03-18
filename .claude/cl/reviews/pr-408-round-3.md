---
skill: respond-to-pr-review
issue: 408
pr: 416
round: 3
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4]
---

### F1: Narrator affinity key mismatch
**What was caught:** Resurfaced narrator suggestions looked up `narratorAffinity` using `authorName` instead of `narratorName`.
**Why I missed it:** The `getStrengthForReason` parameter was named `authorName`, so passing `row.authorName` looked correct at a glance. The round 2 fix added `scoreCandidate` integration but didn't audit the affinity key by reason type.
**Prompt fix:** Add to `/implement` step (resurfacing/multi-reason paths): "When a lookup key varies by reason type (e.g., narrator affinity keyed by narrator name, author affinity by author name), verify each reason branch resolves the correct identity field — don't assume `authorName` is universal."

### F2: getSuggestions predicate not actually asserted
**What was caught:** The snooze-filter test only checked `.where()` was called, which passes for any predicate shape.
**Why I missed it:** Treated "test exists" as "test is sufficient." The mock DB returns whatever is seeded regardless of the WHERE clause, so the test was vacuous.
**Prompt fix:** Add to testing.md or CLAUDE.md gotchas: "When testing Drizzle ORM query predicates with mock DB, use `SQLiteSyncDialect.sqlToQuery()` to serialize the predicate and assert the SQL string shape. Bare `.where()` call assertions prove nothing about predicate content."

### F3: Expiry delete predicate not verified
**What was caught:** Same pattern as F2 — the delete predicate assertion only checked `whereArg` was defined.
**Why I missed it:** Same root cause as F2 — the round 2 fix improved the assertion but stopped one step short of structural verification.
**Prompt fix:** Same as F2 — the SQLiteSyncDialect pattern should be the standard for all predicate assertions.

### F4: Narrator resurfacing path untested
**What was caught:** AC6 resurfacing test only exercised the author path, leaving the narrator branch (and its bug) undetected.
**Why I missed it:** Only wrote one test case for the happy path without considering that different reason types exercise different code branches in `getStrengthForReason`.
**Prompt fix:** Add to `/plan` test stub generation: "When a code path branches on an enum/discriminator (e.g., reason type), generate at least one test per variant that exercises the variant-specific logic, not just the most common case."
