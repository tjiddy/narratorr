---
skill: respond-to-spec-review
issue: 367
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Backend API referenced as if it exists on main
**What was caught:** AC items referenced `/api/discover/*` routes that don't exist on `main` because dependency #366 hasn't merged.
**Why I missed it:** The `/elaborate` skill explored the codebase and noted the dependency was open, but didn't enforce that the spec must either gate claiming or pin the exact contract. The spec treated "depends on #366" as a soft note rather than a hard constraint on AC testability.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "If the issue has unmerged dependencies, add a **Dependency Contract** section that pins the exact API surface, response shapes, and schema touchpoints the frontend expects. Add an explicit gate to the summary: 'this issue cannot be claimed until #<dep> is merged.' Each AC that references a dependency artifact must trace to a named field in the contract."

### F2: Settings contract unnamed
**What was caught:** Spec referenced `settings.discovery` without naming the schema file, registry wiring, or UI insertion surface.
**Why I missed it:** The `/elaborate` skill identified that the settings registry has no `discovery` category, but the gap-fill only mentioned settings conceptually rather than naming every touchpoint (schema file path, registry entry, UI component, nav gating logic).
**Prompt fix:** Add to `/elaborate` step 4: "When a spec adds a new settings category, the gap-fill MUST name: (1) schema file path, (2) registry.ts entry, (3) settings UI component name, (4) any conditional rendering that depends on the new setting. Add these to Files to Create/Modify."

### F3: Empty state discriminator missing
**What was caught:** AC required two distinct empty states but no API field existed to distinguish them.
**Why I missed it:** The AC was written as a UI requirement without tracing back to what data drives the branch. The `/elaborate` test plan gap-fill added test cases for both empty states but didn't verify that the API contract included a discriminator.
**Prompt fix:** Add to `/elaborate` test plan gap-fill checklist: "For every conditional UI state (empty variants, error variants, feature-gated visibility), verify that the data source includes a named field that drives the condition. If not, add the field to the Dependency Contract or flag as a gap."

### F4: Hero count ambiguity (total vs filtered)
**What was caught:** "Suggestion count" could mean total from API or filtered visible count — AC and test plan contradicted each other.
**Why I missed it:** Wrote the AC as a vague "count" without specifying source of truth. The test plan said it "updates when filter is applied" which implied filtered, but the AC didn't match.
**Prompt fix:** Add to `/elaborate` AC generation checklist: "Any displayed count must specify its source of truth: API field name (e.g., `stats.totalSuggestions`) or client-side derivation (e.g., `filteredSuggestions.length`). Ambiguous counts are untestable."

### F5: Cross-query cache invalidation missing
**What was caught:** Add-to-library mutation should invalidate `queryKeys.books()` in addition to discover queries.
**Why I missed it:** Focused on the discover-specific cache invalidation without checking existing add-to-library patterns in `SearchBookCard.tsx` for their invalidation scope.
**Prompt fix:** Add to `/elaborate` deep source analysis (step 10): "For mutations that create/modify entities shared across pages (e.g., adding a book affects both Discover and Library), check existing mutation patterns for the same entity type and verify the spec's cache invalidation scope matches."
