---
scope: [backend]
files: [src/server/server-utils.ts, src/server/server-utils.test.ts]
issue: 10
source: review
date: 2026-03-19
---
When a function performs multiple sequential HTML rewrites (here: `<base>` injection + nonce injection in `sendIndexHtml()`), new tests for one rewrite path must also verify the other paths still work in combination. The new `<base>` tests used plain Fastify (no Helmet/nonce), while the existing nonce tests never checked for `<base>`. This left the intersection — Helmet responses that need both — untested. A regression in either path could strip or misplace the other while both individual test suites still passed.

Prevention: when a function has multiple rewrite passes, write at least one combined-assertion test that exercises all rewrites in a single response and asserts every injected artifact is present and correctly ordered.
