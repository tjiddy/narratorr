---
scope: [frontend, backend]
files: [src/client/pages/discover/DiscoverPage.test.tsx, src/server/jobs/index.test.ts]
issue: 547
source: review
date: 2026-04-14
---
Three test-quality findings from review:
- F1: `not.toHaveBeenCalledWith(specific args)` is weaker than `not.toHaveBeenCalled()` for proving no warning was emitted. Use the broader assertion when proving absence.
- F2: Fire-and-forget error tests must assert the user-visible consequence (optimistic state preserved), not just the logging side effect. The catch handler's purpose is preserving UI state — test that.
- F3: When adding new error-path branches (try/catch with log.warn), happy-path tests must assert silence (`log.warn not called`) to catch regressions where warnings fire on success.
Root cause: Tests were written to prove the new code works (warn on error) but not to prove existing behavior survives (no warn on success, UI state on rejection).
