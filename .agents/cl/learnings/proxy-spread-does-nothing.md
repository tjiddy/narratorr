---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 393
date: 2026-03-15
---
Spreading a Proxy into a plain object (`{ ...proxy }`) copies zero properties because Proxy traps don't make properties enumerable on the target. When migrating from a plain object mock to a Proxy-based one, return the Proxy directly — don't try to spread it into a return object. If you need both Proxy behavior and static API methods, put them all on the Proxy's get trap.
