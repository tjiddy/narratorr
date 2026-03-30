---
skill: respond-to-pr-review
issue: 228
pr: 232
round: 2
date: 2026-03-30
fixed_findings: [F1]
---

### F1: Multi-file preview row lacks separator/case regression test
**What was caught:** The multi-file preview row's options argument was never directly asserted after changing separator/case controls.
**Why I missed it:** The round-1 F3 fix focused on token-map assertions (which tokens are passed) but didn't extend to options assertions (which separator/case settings are forwarded). The existing separator/case tests asserted broadly "some preview text changed" rather than targeting the new row.
**Prompt fix:** Add to testing.md under "Test quality standards": "When a new consumer is added for existing reactive state (e.g., a new preview row consuming `namingOptions`), the test must verify the new consumer updates independently — broad 'something on the page changed' assertions are insufficient because they're satisfied by sibling consumers."
