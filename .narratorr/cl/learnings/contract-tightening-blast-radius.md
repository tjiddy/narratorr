---
scope: [backend, frontend]
files: [src/shared/schemas/blacklist.ts, src/client/lib/api/blacklist.ts, src/client/components/SearchReleasesModal.tsx]
issue: 365
date: 2026-03-15
---
Making a previously-optional field required in a shared schema (Zod + TypeScript type) creates a blast radius across all callers. The typecheck catches it, but run typecheck early — don't wait for `verify.ts` at the end. In this case, `SearchReleasesModal.tsx` and `api-contracts.test.ts` both called `addToBlacklist` without `reason` and needed updating. Always grep for all callers of a function whose signature changes.
