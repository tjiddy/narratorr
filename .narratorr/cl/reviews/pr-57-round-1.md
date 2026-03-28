---
skill: respond-to-pr-review
issue: 57
pr: 60
round: 1
date: 2026-03-22
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Required indexerName weakened to optional in client DTO
**What was caught:** `indexerName?: string | null` should be `indexerName: string | null` — optional weakens the contract and hides regressions.
**Why I missed it:** During implementation I used `?:` to match the existing pattern for other optional fields on Download (bookId, indexerId, size, etc.). I didn't notice that indexerName differs because the server guarantees it's always present.
**Prompt fix:** Add to CLAUDE.md § Code Style: "When a server type defines a field as required (`field: T`), the client DTO must mirror the same requiredness — do not default to `?:` for new fields on existing interfaces."

### F2-F4: Only null-branch tested for getById/getActive/getActiveByBookId projections
**What was caught:** Three methods had only null-case tests for the new indexerName projection. The positive branch (indexer present) was not verified at the service layer.
**Why I missed it:** I wrote the "happy path" test for getAll (which has both positive and null-case stubs from the spec), then wrote only null-case stubs for the other three methods since the spec test plan emphasized the "deleted indexer" case prominently.
**Prompt fix:** Add to testing.md: "For every new nullable field projection (`r.foo?.bar ?? null`), write two service-level tests: one asserting the actual value when the join row is present, one asserting null when it is absent. A single test is never sufficient for a binary branch."

### F5: Stale typed fixture in sibling file (retry-search.test.ts)
**What was caught:** retry-search.test.ts had `const mockDownload: DownloadWithBook = {...}` without the new required `indexerName` field, which would fail typecheck.
**Why I missed it:** The blast-radius check in handoff looked for files using `DownloadWithBook` but the two orchestrator files used `as DownloadWithBook` casts (safe), while retry-search.test.ts used a plain typed declaration (unsafe). I didn't distinguish between the two forms.
**Prompt fix:** Add to /handoff step 4 coverage subagent prompt: "When a required field is added to a shared type, grep `"TypeName = {"` across all test files and separate results into `as TypeName` casts (type-assertion, safe) vs plain typed declarations (strict, must be updated). Only the latter require fixture updates."
