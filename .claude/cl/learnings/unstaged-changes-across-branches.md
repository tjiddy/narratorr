---
scope: [infra]
files: [scripts/claim.ts]
issue: 353
date: 2026-03-15
---
Unstaged modifications from other branches (e.g., #356 test stubs) carry over when switching branches and can cause lint/test failures on unrelated feature branches. The new lint diff gate in verify.ts catches these as "new violations" since they don't exist on main. Fix: revert unstaged changes from other branches before running verify, or commit them to their proper branch first.
