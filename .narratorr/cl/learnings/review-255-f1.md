---
scope: [scope/core]
files: [packages/core/src/indexers/torznab.ts, packages/core/src/indexers/newznab.ts, packages/core/src/indexers/abb.ts, packages/core/src/indexers/fetch.ts]
issue: 255
source: review
date: 2026-03-03
---
When a shared utility has smart defaults (fetchWithProxy uses 30s direct / 60s proxy), callers should NOT pass explicit timeout values that override those defaults. The adapters were passing `timeoutMs: REQUEST_TIMEOUT_MS` (30000) which defeated the proxy timeout extension. Spec said "60s when proxied" but the implementation passed the old 30s constant. Would have been caught by a test asserting the timeout value passed to fetchWithProxy.
