---
scope: [scope/backend, scope/db]
files: []
issue: 429
source: spec-review
date: 2026-03-17
---
The spec proposed moving `formatEventMessage()` from core to a registry pattern but didn't specify which module owns the canonical registry. `NotificationEvent` was defined in `src/core/notifiers/types.ts` (runtime) and `src/shared/schemas/notifier.ts` (Zod), but the spec didn't make an explicit choice about post-refactor ownership. Would have been caught by: "when a refactor moves artifacts between layers (core/shared/server), add a Design Decision section with a concrete artifact-to-file mapping table and the allowed import direction."
