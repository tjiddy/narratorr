---
skill: respond-to-pr-review
issue: 422
pr: 426
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4]
---

### F1: Missing 500 fallback tests for approve/reject after catch removal
**What was caught:** Routes that had their catch blocks removed in favor of the global error handler plugin lacked tests proving the generic 500 fallback still worked at the route level.
**Why I missed it:** Focused on testing the typed error paths (404, 409) that were the "new" behavior, and assumed the plugin's own unit tests covered the generic fallback. Didn't think about route-level integration gaps for the fallback.
**Prompt fix:** Add to `/plan` test plan generation: "When removing route-local error handling (catch blocks, string matching), add route-level 500 fallback tests for every affected endpoint — the global plugin's unit tests don't prove route-level propagation."

### F2: Missing DOWNLOAD_NOT_FOUND route-level test
**What was caught:** New typed error code had service and plugin tests but no route-level integration test proving the full chain.
**Why I missed it:** The error code was added alongside several others that already had route tests. Treated the existing coverage of sibling codes (NOT_FOUND, UNSUPPORTED_EVENT_TYPE, NO_DOWNLOAD) as sufficient proof that the plugin mapping worked.
**Prompt fix:** Add to `/implement` test phase: "When adding a new typed error code, verify route-level test coverage exists for EVERY code in the service's error enum, not just the ones that existed before your change."

### F3: Missing 500 fallback test for mark-failed route
**What was caught:** Same pattern as F1 — catch block removed, no generic fallback test.
**Why I missed it:** Same root cause as F1. Pattern blindness — applied the typed-error-only test approach uniformly without considering the removed fallback.
**Prompt fix:** Same as F1 — the rule about catch removal → fallback test would catch both.

### F4: Missing slim select column contract test
**What was caught:** The schema-derived slim select had no test asserting the actual columns selected.
**Why I missed it:** Tested that `slim: true` was forwarded from route to service, but didn't test what `slim: true` actually does to the select fields. Confused "option is wired" with "option produces correct output."
**Prompt fix:** Add to `/implement` test checklist: "When a refactor changes HOW data is selected or transformed (not just THAT a flag is forwarded), add a test asserting the output shape — e.g., which columns are included/excluded, which fields are transformed."
