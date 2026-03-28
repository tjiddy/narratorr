---
skill: respond-to-pr-review
issue: 157
pr: 158
round: 1
date: 2026-03-27
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Escape hatch in wrong settings page
**What was caught:** "Show Welcome Message" button was in GeneralSettingsForm (mounted from SystemSettings.tsx), appearing under Settings->System not Settings->General.
**Why I missed it:** Placed code in a component whose name implied it was on the General page, without tracing the actual mount point.
**Prompt fix:** Add to /plan exploration: "When spec names a navigation path, grep all files that import/render the target component to confirm it is mounted on the correct page before placing code there."

### F2: grid-cols-2 on mobile
**What was caught:** Feature-highlights grid used grid-cols-2 as mobile base, forcing 2 columns instead of stacking.
**Why I missed it:** Inconsistency with the other two grid rows (grid-cols-1) that wasn't caught before commit.
**Prompt fix:** Add to /implement UI: "Always start responsive grids with grid-cols-1 (mobile-first). Only use grid-cols-2+ as mobile base when explicitly required by design."

### F3: No cache-invalidation assertion
**What was caught:** Mutation tests checked payload/toast but not that queryKeys.settings() invalidation triggers a refetch.
**Why I missed it:** Focused on immediate effects, not downstream cache consequence.
**Prompt fix:** Add to testing standards: "For mutations that invalidate a query cache, assert the invalidated query is called >=2 times after mutation success."

### F4: No service test for new field preservation
**What was caught:** welcomeSeen added but no service test verified it survives partial updates of other general fields.
**Why I missed it:** Assumed existing deep-merge tests covered all categories. Did not add category-specific tests for the new field.
**Prompt fix:** Add to /implement backend: "For each new settings field, add a patch/update service test proving it is preserved when other fields in the same category are patched."

### F5: No route test for new field
**What was caught:** Route tests had no coverage for welcomeSeen round-tripping through PUT /api/settings.
**Why I missed it:** Added housekeeping route tests but no parallel block for welcomeSeen.
**Prompt fix:** Add to /implement backend: "For each new settings field, add a route round-trip test: PUT the field, assert 200 + correct body + service called with correct args."
