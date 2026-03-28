---
scope: [backend]
files: [src/server/plugins/error-handler.ts]
issue: 359
date: 2026-03-14
---
Fastify's default validation error response uses `{ statusCode, error, message }` format. A custom `setErrorHandler` that returns `{ error: message }` for validation errors breaks tests expecting `body.message`. The error handler must preserve Fastify's format for validation errors by checking `error.validation` and returning the original shape.
