---
scope: [backend]
files: [src/server/index.ts, src/server/server-utils.ts]
issue: 284
date: 2026-03-09
---
The ESLint complexity rule (max 15) in this project counts ternaries, if/else, try/catch, and loops. Adding URL_BASE conditionals pushed `main()` from 15 to 18. Extracting helpers (`registerStaticAndSpa`, `listenWithRetry`) to a separate module has the dual benefit of reducing complexity AND making the helpers testable (since `index.ts` runs `main()` at module scope, importing it in tests starts the server).
