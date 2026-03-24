---
scope: [scope/backend]
files: [src/server/server-utils.test.ts]
issue: 423
source: review
date: 2026-03-17
---
Reviewer caught that nonce presence was tested independently in two places (CSP header in helmet.test.ts, HTML body in server-utils.test.ts) but no test asserted they were the same value. A stale or unrelated nonce would pass both tests while breaking CSP in production.

Root cause: When testing a value that propagates across boundaries (helmet → reply.cspNonce → HTML injection), each boundary was tested in isolation. The integration assertion connecting the two ends was missed.

Prevention: When a value flows through multiple layers, add at least one end-to-end assertion that extracts the value from both ends and asserts equality. The /plan step should flag cross-boundary value propagation as needing integration tests.
