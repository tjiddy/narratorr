---
skill: respond-to-pr-review
issue: 392
pr: 399
round: 1
date: 2026-03-15
fixed_findings: [F1, F2]
---

### F1: Shallow clone in no-override path leaks shared references
**What was caught:** `{ ...DEFAULT_SETTINGS }` only clones the top level — nested category objects are shared references that can be mutated across tests.
**Why I missed it:** The "does not mutate DEFAULT_SETTINGS" test only covered the override path. The no-override path was untested. I didn't consider that `{ ...obj }` is shallow — a well-known JS gotcha I should have caught.
**Prompt fix:** Add to `/implement` step 4 general rules: "When writing factory/helper functions that return copies of shared state, test BOTH the override and no-override paths for isolation. Shallow spread (`{ ...obj }`) is insufficient for nested objects — always deep-clone shared fixtures."

### F2: Incomplete migration sweep — missed route-level settings mocks
**What was caught:** 4 server test files (system.test.ts, books.test.ts, search.test.ts, health-check.service.test.ts) still hardcoded category-level settings literals via `services.settings.get` from the proxy-based `createMockServices()` pattern.
**Why I missed it:** The blast radius inventory from the spec only covered files with `createMockSettingsService()` wrappers and standalone inline mocks. It didn't capture route tests that access settings through the shared `services` object. The grep patterns were too narrow.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "For fixture migration tasks, after migrating all known files, run a final comprehensive grep for the underlying method call (e.g., `settings.get`) across ALL test files, not just the patterns identified in the spec inventory. The spec inventory is a starting point, not the complete list."
