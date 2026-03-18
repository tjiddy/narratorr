---
scope: [scope/backend]
files: [src/shared/schemas/settings/discovery.ts]
issue: 418
date: 2026-03-17
---
When deriving a Zod `z.object()` schema from a dynamic array (e.g., `Object.fromEntries(REASONS.map(...))`), the `.default()` value on the parent field must ALSO be derived dynamically. Easy to derive the schema shape but forget the default literal is still hardcoded. Self-review caught this — would have been a PR review finding.
