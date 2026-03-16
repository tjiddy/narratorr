---
skill: respond-to-pr-review
issue: 364
pr: 376
round: 2
date: 2026-03-14
fixed_findings: [F4, F5]
---

### F4: deduplicateKeys helper never wired into render sites
**What was caught:** `deduplicateKeys()` was added in round 1 but never imported/called by SearchTabContent, SearchReleasesModal, or ImportListsSettings. True duplicates still collided.
**Why I missed it:** After fixing the key functions in round 1, I treated adding the helper as sufficient without verifying it was actually used. The self-review checked the helper existed but didn't verify the call sites imported it.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix completeness gate: "After adding a new utility function as part of a fix, grep for its import across all intended consumers. If the function is not imported and called in every file that needs it, the fix is incomplete."

### F5: Tests don't cover duplicate-collision path at render layer
**What was caught:** Tests only covered unique-row rendering but never rendered true duplicates through the components, so React's duplicate-key warning was emitted undetected.
**Why I missed it:** Tested the helper in isolation (stableKeys.test.ts) and assumed component tests would catch issues. But the component tests only used unique data, so the collision path was never exercised.
**Prompt fix:** Add to testing standards: "When testing React key stability, always include a test that renders true duplicate data items and spies on console.error to assert no 'same key' warning is emitted. Helper-level tests are insufficient — the render integration must be verified."
