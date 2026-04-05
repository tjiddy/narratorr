---
scope: [backend, frontend]
files: [src/shared/schemas/blacklist.ts, src/shared/notification-events.ts]
issue: 321
date: 2026-04-05
---
Use `satisfies Record<EnumType, string>` (not `: Record<EnumType, string>`) for label maps co-located with as-const tuples. The `satisfies` pattern preserves the `Record<string, string>` declared type for downstream consumers that don't import the enum type, while still enforcing exhaustiveness at compile time. This matches the established `notification-events.ts` pattern and avoids forcing all consumers to import the enum type just to read a label.
