---
scope: [backend]
files: [src/server/routes/activity.ts]
issue: 270
date: 2026-03-08
---
The `@typescript-eslint/return-await` rule requires `return await reply.status(N).send(...)` inside try/catch blocks — even inside switch cases within try blocks. Bare `return reply.status(N).send(...)` triggers the lint error because rejected promises would bypass the catch block.
