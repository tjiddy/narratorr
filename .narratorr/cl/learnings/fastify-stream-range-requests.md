---
scope: [backend]
files: [src/server/routes/book-preview.ts]
issue: 320
date: 2026-04-03
---
Fastify `reply.send(readableStream)` handles backpressure automatically — no need for `reply.hijack()` or `reply.raw` for file streaming. Use `fs.createReadStream({ start, end })` for Range requests. The `system.ts` backup download endpoint proves this pattern at line 115-120.
