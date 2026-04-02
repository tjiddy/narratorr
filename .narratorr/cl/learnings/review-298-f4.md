---
scope: [scope/core]
files: [src/core/indexers/abb.ts, src/core/indexers/newznab.ts, src/core/indexers/torznab.ts, src/core/indexers/myanonamouse.ts, src/core/indexers/proxy.ts]
issue: 298
source: review
date: 2026-04-02
---
Signal threading through adapters and proxy helpers was implemented but untested. The fetch.test.ts suite proved `fetchWithProxy()` composes signals, but nothing proved the adapters actually forwarded `options.signal` to the helpers. Deleting the signal arguments from any adapter would leave tests green. Future: when threading a new parameter through a call chain, add tests at each call site — not just at the bottom of the stack.
