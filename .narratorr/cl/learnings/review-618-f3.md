---
scope: [backend]
files: [src/server/routes/index.test.ts]
issue: 618
source: review
date: 2026-04-17
---
When adding a new constructor argument to a service wired in `createServices`, always add a corresponding test in `routes/index.test.ts` asserting the argument is passed. Service-level tests manually construct the service, so they would pass even if the runtime wiring forgot the argument.
