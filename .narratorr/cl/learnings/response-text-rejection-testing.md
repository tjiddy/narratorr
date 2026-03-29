---
scope: [backend, core]
files: [src/core/notifiers/ntfy.test.ts]
issue: 199
date: 2026-03-29
---
To test `.text().catch(() => '')` fallback paths (where `response.text()` rejects), create an MSW handler that returns an `HttpResponse` with a `ReadableStream` body that immediately errors: `new ReadableStream({ start(c) { c.error(new Error('broken')); } })`. This causes `response.text()` to reject while still delivering the correct status code for assertion.
