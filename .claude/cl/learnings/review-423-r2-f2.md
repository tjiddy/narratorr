---
scope: [scope/backend]
files: [src/server/server-utils.test.ts, src/server/server-utils.ts]
issue: 423
source: review
date: 2026-03-17
---
Reviewer caught that the static asset pass-through behavior (index: false, wildcard: true config change) had no direct test. All 27 server-utils tests only exercised HTML routes — if route precedence regressed, production JS/CSS bundles could 404 or return HTML while all tests stayed green.

Root cause: Test plan focused on the new behavior (explicit HTML entry routes, nonce injection) but didn't cover the preservation of existing behavior (static asset serving) that was affected by the config change.

Prevention: When changing plugin configuration that affects multiple behaviors (here: index:false affects both HTML and static serving), test both the changed and preserved behaviors. The /plan step should ask: "What existing behaviors does this config change affect beyond the target behavior?"
