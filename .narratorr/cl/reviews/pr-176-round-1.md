---
skill: respond-to-pr-review
issue: 176
pr: 189
round: 1
date: 2026-03-28
fixed_findings: [F1]
---

### F1: background guard tests missing import_failed event assertion

**What was caught:** The two background-path guard tests (`confirmImport` with source inside library root, copy and move modes) verified `status: 'missing'` and absent filesystem calls but did not assert `mockEventHistoryService.create` was called with `eventType: 'import_failed'`. The spec's System Behaviors section explicitly lists "emits import_failed event" as part of the bulk-import failure contract.

**Why I missed it:** The coverage subagent during handoff scanned for behaviors but was prompted with general coverage categories. It verified the primary observable outcome (status update) without enumerating all sub-outcomes listed in the spec's failure contract. The multi-part contract (status + event + no filesystem ops) was only partially asserted.

**Prompt fix:** Add to the handoff coverage subagent prompt (step 4): "For failure-path tests, cross-check the spec's 'System Behaviors' section for the failure flow. If the spec lists multiple outcomes (e.g., 'marks missing, emits event, performs no filesystem ops'), verify the test has one `expect()` per outcome — not just the first or most obvious one."
