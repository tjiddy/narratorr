---
scope: [scope/backend, scope/frontend, scope/services]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that `src/shared/schemas/settings/discovery.ts` and `src/shared/schemas/settings/registry.ts` both hardcode the same reason keys but were omitted from scope. Root cause: I searched for the type name `SuggestionReason` and the literal union, but the settings files use the keys as Zod object property names, not as a type alias — a different surface pattern for the same duplication. Prevention: when auditing fan-out of an enum/union, search for each individual value string (e.g., `'author'`, `'diversity'`) across the full codebase, not just the type name.