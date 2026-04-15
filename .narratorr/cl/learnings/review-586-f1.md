---
scope: [frontend]
files: [src/client/pages/discover/DiscoverPage.test.tsx]
issue: 586
source: review
date: 2026-04-15
---
When changing a side effect from "does X" to "does nothing," the test must assert the absence of the old behavior (e.g., `expect(warnSpy).not.toHaveBeenCalled()`), not just that the new behavior works. Without the negative assertion, regressing back to the old side effect would still pass the test. This is a general pattern: behavior-removal tests need explicit silence assertions.
