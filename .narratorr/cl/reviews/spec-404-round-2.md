---
skill: respond-to-spec-review
issue: 404
round: 2
date: 2026-03-17
fixed_findings: [F1, F2]
---

### F1: AC5 overstates completed-series detection
**What was caught:** The spec claimed "completed series (no suggestions)" and "single-book series (no suggestions)" were already implemented, but `computeSeriesGaps()` always appends `maxOwned + 1` — there's no total-series-length tracking.
**Why I missed it:** The auto-generated implementation note inferred behavior from the presence of `computeSeriesGaps()` and the null-position guard without tracing the actual algorithm. The original AC5 wording was copied from the parent issue (#368) without verifying it against the shipped implementation.
**Prompt fix:** Add to `/spec` AC verification checklist: "For ACs referencing 'already implemented' code, trace the exact algorithm path and confirm the claimed behavior is mechanically produced — do not infer from function names or guard clauses alone. Specifically check for missing data dependencies (e.g., if an AC claims 'detects completion,' verify the code has access to a total/count field)."

### F2: Missing explicit AC3/AC4 test assertions
**What was caught:** Test plan described behavioral expectations but didn't include spy-level assertions for AC3's query string or direct scoring comparison for AC4.
**Why I missed it:** The auto-generated test plan focused on input/output scenarios rather than interface contract verification. For "already implemented" issues where the code exists, the highest-value tests are exact contract assertions, not behavioral descriptions.
**Prompt fix:** Add to `/spec` test plan generation: "For ACs that describe a specific API call or scoring rule, include at least one spy/mock assertion verifying the exact call signature or scoring comparison, not just the downstream behavioral effect."
