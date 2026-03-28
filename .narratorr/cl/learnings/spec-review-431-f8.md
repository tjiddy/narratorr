---
scope: [scope/backend]
files: [src/server/routes/library-scan.ts, src/server/routes/settings.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that getErrorMessage() AC said "used across all routes" but routes use 12 different fallback strings, not just 'Unknown error'. Prevention: grep for the error extraction pattern and catalog all unique fallback strings before defining the utility signature.
