---
scope: [backend]
files: [src/server/routes/search.ts]
issue: 188
date: 2026-03-28
---
A bare type cast `(error as { code?: string }).code` crashes at runtime when `error` is `null` (property access on null). The catch block itself becomes a throw point, and the error escapes to Fastify's global handler returning `{ error: 'Internal Server Error' }` instead of the route's `{ error: 'Unknown error' }`. Fix: sequence the guard as `error !== null && typeof error === 'object' && 'code' in error` before any cast. String and object-without-code cases already fall through safely via undefined comparison.
