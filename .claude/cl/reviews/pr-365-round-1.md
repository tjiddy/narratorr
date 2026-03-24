---
skill: respond-to-pr-review
issue: 365
pr: 395
round: 1
date: 2026-03-15
fixed_findings: [F1, F2]
---

### F1: SearchReleasesModal blacklist success-path test missing
**What was caught:** The test suite covered disabled/error blacklist paths but not the happy path where `reason: 'other'` is sent.
**Why I missed it:** Focused on blast radius at the typecheck level (caught `SearchReleasesModal` needing reason) but didn't think about test coverage for the success path. The coverage review subagent noted this as "UNTESTED" but I dismissed it because TypeScript enforces the field at compile time.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "For caller updates (blast radius fixes), also check that the success-path test exists for each updated caller. TypeScript catching a missing field is not the same as a test asserting the correct value is sent."

### F2: Migration SQL untested
**What was caught:** The backfill migration was never executed against a real database with pre-migration data.
**Why I missed it:** Treated the migration as a static SQL artifact, not testable code. There's no existing pattern for migration tests in this codebase.
**Prompt fix:** Add to `/plan` step 5 (test stubs): "When the plan includes a migration with data transformation (UPDATE, backfill, table rebuild), create a test stub for a migration integration test using in-memory libSQL. Template: create pre-migration schema, seed data, run migration statements, assert post-migration state."
