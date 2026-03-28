---
scope: [frontend]
files: [src/client/hooks/useAuth.test.ts]
issue: 358
date: 2026-03-13
---
When using `replace_all` for API method renames, be careful about methods like `logout` that exist on both the API module (`api.logout`) and on hook return values (`result.current.logout`). The hook's public API method name stays the same — only the internal `api.X` call is renamed. Blindly replacing all occurrences of `logout` in a test file will break hook assertions. Use targeted edits for ambiguous names.
