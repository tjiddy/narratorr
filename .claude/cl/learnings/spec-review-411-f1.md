---
scope: [scope/backend, scope/services]
files: []
issue: 411
source: spec-review
date: 2026-03-16
---
Reviewer caught that the spec identified a type mismatch in `SettingsService.update()` but didn't extend the fix to the route layer (`PUT /api/settings` also typed as `Partial<AppSettings>`). The spec only mentioned the service-side fix. Root cause: when writing the spec, I traced the type issue at the service level but didn't follow the call chain upward to the route declaration at `settings.ts:73`. Prevention: when a spec addresses a type contract fix, trace all surfaces that use that type — service signature, route body declaration, and any intermediate validators — and ensure the fix covers each one.
