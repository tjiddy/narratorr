---
skill: respond-to-pr-review
issue: 216
pr: 221
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3, F4]
---

### F1: Page-level settings conversions lack regression assertions
**What was caught:** Converted selects pass existing value/save tests even if they revert to raw `<select>`, because no test asserts the shared component contract (appearance-none + chevron).
**Why I missed it:** During implementation, I assumed that the shared component's own test suite + existing consumer tests passing was sufficient. I didn't consider that consumer tests only verify values/behavior, not the rendering contract that IS the change.
**Prompt fix:** Add to `/implement` step 4 general rules: "When extracting a shared component and converting consumers, add at least one regression assertion per consumer proving the shared contract is active (e.g., styling class, wrapper element, icon presence). Existing pass-through tests are insufficient — they verify behavior, not the conversion itself."

### F2: Import list conversions missing coverage including ABS fetch branch
**What was caught:** Same as F1 but for import list selects, plus the ABS Library select path (libraries.length > 0) was never exercised.
**Why I missed it:** I assumed the parent integration test (ImportListsSettingsSection.test.tsx, 26 tests) covered everything. I didn't verify that the specific select branch (libraries fetched → select renders instead of input) was exercised.
**Prompt fix:** Add to `/implement` step 4d (blast radius check): "For conditional rendering branches introduced by the change (e.g., select replaces input when data is fetched), verify the test exercises BOTH branches — not just the default/fallback."

### F3: BlackholeFields protocol error wiring untested
**What was caught:** New `error={!!errors.settings?.protocol}` prop wiring had no test injecting a protocol error.
**Why I missed it:** The error prop is a new branch introduced by the PR (it didn't exist before since the raw select used a ternary on className). I treated it as mechanical, but it IS a new code path.
**Prompt fix:** Add to testing standards: "When wiring a new prop (especially error/state props) from a parent to a shared component, test the prop in context — not just in the shared component's own tests. The wiring is the new code path."

### F4: NotifierFields method select not directly tested
**What was caught:** Webhook method select conversion not tested beyond field presence.
**Why I missed it:** Same pattern as F1 — existing test checks field presence but doesn't verify the shared contract.
**Prompt fix:** Covered by F1's prompt fix (regression assertion per consumer).
