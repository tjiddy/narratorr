---
skill: respond-to-spec-review
issue: 430
round: 1
date: 2026-03-18
fixed_findings: [F1, F2, F3, F4]
---

### F1: settingsRegistry conflated with settings pages
**What was caught:** Spec said "derive App.tsx routes from settingsRegistry keys" but registry has 12 schema categories while the UI has 8 pages with completely different grouping.
**Why I missed it:** /elaborate's subagent explored the registry shape and nav array separately but never read GeneralSettings.tsx to see that it groups 9 schema categories into one page. The assumption that registry keys = pages was accepted without verification.
**Prompt fix:** Add to /elaborate step 3 subagent prompt: "For any registry-drives-UI claim, verify the mapping by reading the actual page components that consume the registry. Check whether multiple registry entries map to one page, or pages exist that aren't in the registry."

### F2: Stale ImportListsSettings claim
**What was caught:** Spec claimed ImportListsSettings was missing from nav, but it was already present at SettingsLayout.tsx:20.
**Why I missed it:** The subagent reported this as a "CRITICAL BUG" without double-checking the current file. The elaboration accepted the subagent's finding verbatim.
**Prompt fix:** Add to /elaborate step 4: "Before writing any defect claim to the issue body, verify it against current source with a targeted grep. Subagent findings are hypotheses, not facts."

### F3: Heterogeneous route signatures unaddressed
**What was caught:** Route factories have wildly different parameter signatures but spec just said "one array entry."
**Why I missed it:** Elaboration focused on the OCP pattern (growing list) without examining the actual function signatures to see if they could be unified.
**Prompt fix:** Add to /elaborate's subagent prompt deep source analysis: "For registry-pattern proposals, check whether the items being registered share a common signature. If not, note the variance and require the spec to specify how it's resolved (closures, adapters, descriptor objects)."

### F4: Test plan missing specific file names
**What was caught:** Test plan was generic ("exhaustiveness test") without naming where assertions would live.
**Why I missed it:** Test plan was built from categories rather than from existing test file inventory.
**Prompt fix:** Add to /elaborate step 4 test plan gap-fill: "Every test plan bullet should name the specific test file where the assertion will live (existing or new). If a new test file is needed, say so explicitly."
