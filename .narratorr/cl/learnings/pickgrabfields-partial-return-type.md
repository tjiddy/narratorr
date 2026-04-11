---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx]
issue: 469
date: 2026-04-11
---
`pickGrabFields` returned `Partial<GrabPayload>` but should have returned `Omit<GrabPayload, 'bookId' | 'replaceExisting'>`. The `Partial` return type forced callers to re-assign required fields (`downloadUrl`, `title`) to satisfy TypeScript, creating the exact redundancy the function was designed to eliminate. When a dynamic picker function's return is already cast from `Record<string, unknown>`, tighten the cast to the actual contract — `Partial` is not more "honest" when the cast is already approximate.
