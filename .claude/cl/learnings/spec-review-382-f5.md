---
scope: [scope/backend]
files: [src/server/plugins/auth.ts]
issue: 382
source: spec-review
date: 2026-03-15
---
Test plan had ambiguous outcomes: "empty username → returns 401 (or accepts if not rejected)" and "malformed base64 → returns 401, no crash". The first leaves behavior undefined; the second describes an implementation detail (Node's base64 decoder silently returns garbage) rather than the observable contract (no colon in decoded string → 401). Root cause: hedging on edge case outcomes instead of picking one and being explicit.
