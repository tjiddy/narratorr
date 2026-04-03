---
scope: [frontend]
files: [src/client/pages/library/NoMatchState.tsx]
issue: 322
date: 2026-04-03
---
`new URLSearchParams({ q: value }).toString()` is the correct way to build query strings in this codebase — it handles all URL encoding (spaces as `+`, `&`, `'`, etc.) automatically. Trim the input before passing to URLSearchParams and skip the param entirely when trimmed value is empty, per AC3. This pattern matches the existing `src/client/lib/api/search.ts` usage.