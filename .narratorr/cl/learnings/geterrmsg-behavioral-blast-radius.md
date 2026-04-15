---
scope: [backend, frontend, core]
files: [src/shared/error-message.ts]
issue: 560
date: 2026-04-15
---
Changing `getErrorMessage()` from returning a fallback to `String(error)` for non-Error values caused 22 test failures across client and server — far beyond the 5 `String(error)` call sites in the spec. Tests asserting 'Unknown error' or context-specific fallbacks ('Scan failed', 'Connection failed') for non-Error throws all broke. When changing a widely-used utility's behavior, grep for ALL test assertions against the old behavior (not just production call sites) before committing.
