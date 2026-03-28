---
skill: respond-to-pr-review
issue: 17
pr: 20
round: 1
date: 2026-03-20
fixed_findings: [F1]
---

### F1: SecuritySettings wiring test used same value for both bypassActive and envBypass

**What was caught:** The integration test for `SecuritySettings` verified that the Remove Credentials button appeared when `bypassActive: true, envBypass: true` — both fields set to the same boolean. This means the test would pass regardless of whether the production code used `bypassActive` or `envBypass` as the prop for `CredentialsSection`.

**Why I missed it:** When updating an existing test from `bypassActive: true` to also include `envBypass: true`, the natural edit is to add the new field alongside the old one with the same value — the test "looks right" because the behavior is correct. The problem is invisible unless you ask: "would this test catch a regression where we still used the old field?"

**Prompt fix:** Add to `/implement` step 4 (red/green TDD): "When a test verifies which field is wired into a component (prop-rename or prop-split), mock values for the old and new fields must *diverge* — set the old field to the value that hides the behavior, and the new field to the value that shows it. A wiring test with identical values for both fields proves nothing about which field is used."
