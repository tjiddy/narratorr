---
skill: respond-to-spec-review
issue: 429
round: 3
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Notification-event ownership introduces runtime cycle
**What was caught:** The Design Decision proposed `notifier-registry.ts` as canonical owner, but `schemas/notifier.ts` already has a runtime import from `notifier-registry.ts`. Adding the reverse edge (registry imports schema for event derivation) creates a cycle.
**Why I missed it:** The round 1 response verified import directions for `notifier.service.ts` (server → core) but didn't check the existing shared-layer imports between the two files being rewired. I checked that core → shared was safe but not that shared → shared was already occupied.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification: "When a Design Decision proposes new import edges between modules, grep BOTH files for existing imports of each other (`grep 'from.*<module>' <file>`) to detect cycle creation before updating the spec."
