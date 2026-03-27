---
skill: respond-to-pr-review
issue: 157
pr: 158
round: 2
date: 2026-03-27
fixed_findings: [F1]
---

### F1: Reset-flow test stops at refetch proxy, not modal visibility
**What was caught:** The GeneralSettings.test.tsx test proved getSettings was called >=2 times but never rendered Layout, so it would pass even if Layout's modal observer was broken.
**Why I missed it:** Treating "getSettings called again" as a sufficient proxy for "modal reopens." The two assertions are logically connected but not identical — the observer wiring could be broken independently.
**Prompt fix:** Add to respond-to-pr-review or implement testing checklist: "For cache-invalidation flows where action in Component A must produce visible output in Component B: render both in the same QueryClientProvider + MemoryRouter tree and assert the consumer's visible state change, not just that a network call happened."
