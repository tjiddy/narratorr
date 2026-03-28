---
skill: respond-to-pr-review
issue: 392
pr: 399
round: 2
date: 2026-03-15
fixed_findings: [F3]
---

### F3: retry-search.test.ts still hardcodes quality settings
**What was caught:** `createDeps()` in `retry-search.test.ts` still injected a `SettingsService` with a hardcoded full `quality` category object, bypassing the shared factory.
**Why I missed it:** This is the third consecutive round where the migration sweep missed files. Each round's grep was scoped to a specific mock pattern (wrappers, inline mocks, route-level mocks) but never did a final comprehensive sweep for ALL `settings.get` + `mockResolvedValue({...})` across the entire test suite.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "For migration tasks, after all targeted migrations are complete, run ONE final comprehensive grep for the underlying method pattern (e.g., `mockResolvedValue.*grabFloor|mockResolvedValue.*backupRetention` etc.) across ALL test files. This is the safety net grep — it catches files missed by all prior pattern-specific sweeps. Do not skip this step."
