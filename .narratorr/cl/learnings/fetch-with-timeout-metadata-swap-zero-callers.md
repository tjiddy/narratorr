---
scope: [core]
files: [src/core/metadata/audible.ts, src/core/metadata/audnexus.ts, src/core/utils/fetch-with-timeout.ts]
issue: 174
date: 2026-03-28
---
When a metadata provider wraps its entire request helper in try/catch and re-throws as TransientError, swapping fetch() for fetchWithTimeout() requires zero caller-side changes. The redirect Error thrown by fetchWithTimeout() is caught by the existing catch block and wrapped as TransientError — the entire error propagation chain is already in place. The only change needed is the import + 1-line substitution per file.
