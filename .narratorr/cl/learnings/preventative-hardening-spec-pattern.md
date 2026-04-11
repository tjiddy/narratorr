---
scope: [backend]
files: [src/server/utils/folder-parsing.ts]
issue: 467
date: 2026-04-11
---
Preventative hardening issues need structural ACs that are false on `main` and true after implementation — behavioral ACs alone are vacuous because the current code already works. For regex lastIndex hardening specifically, the fix is a separate non-global regex for `.test()` calls (exported for direct test access), not resetting `lastIndex` on the global regex. The export seam must be specified in the spec or the test plan is unimplementable.
