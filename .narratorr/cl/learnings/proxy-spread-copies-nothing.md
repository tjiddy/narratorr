---
scope: [backend]
files: []
date: 2026-04-10
---
Spreading a Proxy into a plain object (`{ ...proxy }`) copies zero properties — Proxy traps don't make properties enumerable on the target. Return the Proxy directly instead. This comes up in test helpers that use Proxy-based mock builders — wrapping `{ ...proxyMock, extraMethod }` silently produces an object with only `extraMethod`.
