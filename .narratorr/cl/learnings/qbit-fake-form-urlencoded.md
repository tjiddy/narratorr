---
scope: [infra]
files: [e2e/fakes/qbit.ts]
issue: 614
date: 2026-04-16
---
Fastify 5 has no built-in parser for `application/x-www-form-urlencoded` — requests arrive with `body` unparsed and handlers get 415 Unsupported Media Type. qBittorrent's `/api/v2/auth/login` uses exactly this content type. Fix: `server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body))`, then parse with `new URLSearchParams(body)` in the handler. Don't reach for `@fastify/formbody` — it pulls in a qs dependency we don't need for a test fake.
