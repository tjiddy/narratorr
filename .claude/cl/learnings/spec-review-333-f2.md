---
scope: [scope/backend]
files: [src/shared/schemas/settings/registry.ts, src/shared/schemas/settings/system.ts]
issue: 333
source: spec-review
date: 2026-03-10
---
Spec said "store in settings" without verifying that the settings system is typed-category-based, not a free-form key-value store. The elaboration should have checked the existing settings architecture (registry.ts, SettingsService) and named the exact category and fields. Always verify persistence assumptions against the actual schema/service code during elaboration.
