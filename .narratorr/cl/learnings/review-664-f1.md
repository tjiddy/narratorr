---
scope: [scope/backend]
files: [src/server/server-utils.ts, src/server/server-utils.test.ts]
issue: 664
source: review
date: 2026-04-21
---
Reviewer caught that the "extract a magic number into a named constant" chore
shipped without any assertion that the constant's value (1000ms retry backoff)
was actually preserved. The existing `listenWithRetry` retry test checked
call count and that `warn` fired, but would have kept passing if
`LISTEN_RETRY_DELAY_MS` drifted to 500 or 5000.

The spec's acceptance criterion "No behavior change — delay value stays
1000ms" is a specific, testable contract — not just a prose invariant. A
pure-extraction chore whose whole point is "the value stays the same" has
the number itself as its contract; without an assertion on the exact
value, the test suite doesn't protect it.

What would have caught this in `/implement`: for constant-extraction
chores, when the AC literally pins a value, add a spy-on-setTimeout
(or equivalent) assertion on that value. The `src/core/download-clients/retry.test.ts`
pattern (spy on `globalThis.setTimeout`, capture `ms`, assert exact value)
is the existing convention.
