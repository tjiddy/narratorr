---
scope: [backend]
files: [src/shared/schemas/event-history.ts]
issue: 260
date: 2026-04-01
---
Zod `.transform()` on query params works seamlessly with Fastify schema validation — the transform runs before the route handler receives the parsed query. This means comma-separated query strings can be validated and converted to typed arrays at the schema level, with routes and services never seeing raw comma strings. Empty segments from double commas or trailing commas naturally fail `safeParse` against the enum, providing rejection for free.
