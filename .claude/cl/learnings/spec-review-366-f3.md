---
scope: [scope/backend, scope/services]
files: [src/server/services/metadata.service.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the spec required rate-limit backoff but the metadata methods named in the spec (`searchBooks`/`getAuthorBooks`) swallow rate limits into empty results via `withThrottle()`. Only `search()` returns warnings. Gap: `/elaborate` identified this as a defect vector ("withThrottle returns fallback immediately") but didn't fix the spec to use the correct method. The elaborate step should have traced the data flow from "AC says detect throttle" → "which methods surface throttle state?" → "only search() does" → "spec must use search(), not searchBooks()".
