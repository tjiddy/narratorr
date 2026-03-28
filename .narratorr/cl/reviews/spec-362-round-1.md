---
skill: respond-to-spec-review
issue: 362
round: 1
date: 2026-03-13
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Stale finding inventory and missing source artifact
**What was caught:** M-31 `fireEvent.change` inventory was completely stale (0 matches in codebase) and the cited `debt-scan-findings.md` doesn't exist.
**Why I missed it:** `/elaborate` built the spec from a debt scan artifact without running `rg` to verify each pattern still exists. Trusted a secondary source over the current codebase.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent prompt): "For each finding cited from an external artifact (debt scan, prior issue, etc.), `rg` for the exact pattern in the current codebase. If the pattern returns 0 matches, mark the finding as RESOLVED and remove it from the spec. Never include findings that can't be verified against the current code."

### F2: Over-broad AC scope for fireEvent.submit
**What was caught:** AC said "All fireEvent.submit" but only 2 instances were in scope, and there's a valid intentional direct-submit case.
**Why I missed it:** Wrote AC using "All X" language without counting instances or checking for valid uses of the pattern.
**Prompt fix:** Add to `/elaborate` step 4 (gap-fill): "For cleanup/chore issues: AC must reference specific file:line instances, not 'all X' language. Before finalizing AC, `rg` for the pattern and enumerate the exact count. Check for intentional uses of the pattern being cleaned up — these must be explicitly carved out in Scope Boundaries."

### F3: Incorrect submit button behavior description
**What was caught:** Test plan said save button is "not rendered when form is clean" but BackupScheduleForm uses `disabled={!isDirty}` (always rendered).
**Why I missed it:** Assumed all settings forms use the same conditional-render pattern without reading BackupScheduleForm.tsx source.
**Prompt fix:** Add to `/elaborate` step 3 (deep source analysis): "When a test plan item describes component behavior (e.g., button visibility, disabled state), read the actual component source to verify. Different components may implement the same UX concept differently (conditional render vs disabled attribute)."

### F4: Spinner cleanup assumed a queryable contract that doesn't exist
**What was caught:** AC said to use `getByRole('status')` but LoadingSpinner has no role, aria-label, or data-testid.
**Why I missed it:** Specified the test query target without checking whether the production component exposes that surface.
**Prompt fix:** Add to `/elaborate` step 4 (gap-fill): "When AC says 'replace test query X with query Y', verify the production component actually exposes surface Y. If it doesn't, the spec must explicitly include the production component change as an AC item."

### F5: Contradictory scope language between AC and Scope Boundaries
**What was caught:** AC used "All X" for L-30/L-31 while Scope Boundaries said "representative, not exhaustive."
**Why I missed it:** Wrote AC and Scope Boundaries in separate passes without cross-checking for consistency.
**Prompt fix:** Add to `/elaborate` step 4 (gap-fill): "After writing both AC and Scope Boundaries, cross-check: every AC item must be achievable within the stated scope. If Scope Boundaries says 'representative,' AC must reference the specific listed files, not use universal quantifiers."
