---
skill: respond-to-pr-review
issue: 367
pr: 415
round: 2
date: 2026-03-17
fixed_findings: [F9]
---

### F9: Settings cache invalidation unasserted in save-success test
**What was caught:** The save-success test proved toast and dirty-state reset but didn't assert `queryClient.invalidateQueries({ queryKey: queryKeys.settings() })`, meaning the invalidation could be deleted without failing any test.
**Why I missed it:** In round 1, I added the save-success test focusing on the user-visible consequences (toast, button disappearing) and considered that sufficient. I didn't think about the non-visible side effect (cache invalidation) that other consumers depend on. The round 1 review flagged the broader "save consequences" gap (F8), and I partially addressed it but missed this specific sub-effect.
**Prompt fix:** Add to `/implement` testing checklist or CLAUDE.md testing standards: "For mutation `onSuccess`/`onError` callbacks with multiple side effects (toast, cache invalidation, state reset), each side effect requires its own assertion. Cache invalidation specifically must be asserted via a spy on `invalidateQueries` with the exact queryKey — UI-only assertions don't prove cache coherency."
