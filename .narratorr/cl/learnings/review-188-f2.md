---
scope: [backend]
files: [src/server/services/import-list.service.ts]
issue: 188
source: review
date: 2026-03-28
---
Same pattern as F1 but in a service: two catch blocks with `(error as Error).message` in log statements. The logging pattern is easy to overlook because it appears in structured log fields (`error: (error as Error).message`) rather than in response-building code. After an annotation sweep, the blast radius check must include log call arguments, not only response payloads.
