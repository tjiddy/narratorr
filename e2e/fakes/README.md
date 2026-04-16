# e2e/fakes

Reserved for Phase 2+ fake external service implementations (MAM, SAB, qBit,
Audible, etc.). Fakes will `import type` from `src/core/indexers/types.ts` /
`src/core/download-clients/types.ts` so type-level contract drift fails the
E2E typecheck.

Empty in Phase 1 by design — see issue #612.
