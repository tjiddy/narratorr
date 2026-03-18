---
scope: [backend]
files: [src/server/services/discovery.service.ts, src/server/services/settings.service.ts]
issue: 406
date: 2026-03-17
---
When writing nested objects to settings (like `weightMultipliers`), must use `settings.set('category', { ...currentSettings, weightMultipliers })` — NOT `settings.patch()`. The `patch()` method does shallow merge (`{ ...existing, ...partial }`), which would overwrite the entire `weightMultipliers` object if only some keys are provided, or drop it entirely if not included in the partial. Always read current settings first, then set the full merged object.
