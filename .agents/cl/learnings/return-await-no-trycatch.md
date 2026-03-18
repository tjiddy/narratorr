---
scope: [backend]
files: [src/server/routes/activity.ts, src/server/routes/event-history.ts]
issue: 422
date: 2026-03-17
---
When removing try/catch blocks from route handlers (e.g., to let typed errors propagate to the global error handler), also remove `return await` — the eslint rule `@typescript-eslint/return-await` forbids awaiting in non-try/catch contexts. The CLAUDE.md guidance about `return await` only applies inside try/catch.
