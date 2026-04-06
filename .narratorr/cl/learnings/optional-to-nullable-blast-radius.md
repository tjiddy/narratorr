---
scope: [frontend]
files: [src/client/lib/api/activity.ts, src/client/__tests__/factories.ts]
issue: 357
date: 2026-04-06
---
Changing a TypeScript interface field from optional (`foo?: T`) to required-nullable (`foo: T | null`) breaks every inline fixture that doesn't include the field — even if the factory helper has the correct default. Inline `{ ...fields } as Download` objects in sibling test files (SearchReleasesModal, ActivityPage, useActivity) all needed updating. Grep for the type name across `**/*.test.*` before committing type changes to enumerate the full blast radius upfront.
