---
scope: [frontend]
files: [src/client/components/EventHistoryCard.test.tsx]
issue: 455
date: 2026-04-09
---
`vi.mock()` with `importOriginal<typeof import('...')>()` generic causes TS2698 "Spread types may only be created from object types" when the module has mixed exports. Fix: use `await importOriginal() as Record<string, unknown>` and cast sub-objects explicitly (e.g., `(actual as { api: Record<string, unknown> }).api`). This avoids the generic type parameter issue while preserving the spread.
