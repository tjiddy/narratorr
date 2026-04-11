---
scope: [frontend]
files: [src/client/lib/eventReasonHelpers.ts]
issue: 464
date: 2026-04-11
---
`Object.keys(obj).length > 0` is not equivalent to "has meaningful content" when values can be null/undefined. JSON serialization from the server can produce objects like `{ error: null }` that have keys but no useful data. Use `Object.values(obj).some(v => v != null)` to check for actual content.
