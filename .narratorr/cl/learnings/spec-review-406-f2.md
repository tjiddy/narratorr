---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec assumed `SettingsService.patch()` would deep-merge nested objects like `weightMultipliers`, but the actual implementation does a shallow spread (`{ ...existing, ...partial }`). The spec writer didn't check the merge semantics of the settings service before specifying the write contract. Prevention: when a spec says "store X in settings", verify the actual merge behavior of the settings service and specify the exact write method (`set` vs `patch`) and whether partial or full records are written.