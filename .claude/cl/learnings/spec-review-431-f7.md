---
scope: [scope/core]
files: [src/core/indexers/fetch.ts, src/core/indexers/proxy.ts, src/core/download-clients/transmission.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that fetchWithTimeout() was specified too broadly -- indexer fetch helpers have specialized contracts (FlareSolverr errors, ProxyError wrapping) that are NOT simple timeout wrappers. Prevention: read full source of each call site to identify specialized contracts before proposing a shared utility.
