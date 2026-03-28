---
scope: [backend]
files: [src/server/plugins/csp-nonce-strip.ts, src/server/server-utils.ts]
issue: 21
date: 2026-03-20
---
Fastify's onSend hook runs after the route handler but before the response is serialized and sent. This means: (1) reply decorators set during request handling (like `reply.cspNonce.script`) are already consumed before the hook mutates headers — no conflict; (2) `reply.getHeader()` in onSend returns the pre-mutation value set by earlier plugins; (3) `reply.header()` inside onSend updates the actual outgoing header. The hook must return the payload unchanged (`return payload`) — returning nothing (undefined) sends an empty body.
