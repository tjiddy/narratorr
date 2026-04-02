---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.test.ts]
issue: 301
date: 2026-04-02
---
Changing a method's default behavior (reject() no longer blacklists by default) breaks existing tests that assumed the old default. When modifying defaults, grep ALL existing test files for the method name and update every call site. In this case, 9 existing tests needed `{ retry: true }` added to their `orchestrator.reject()` calls because they were testing blacklist/retry behavior that now requires explicit opt-in. Run the full test suite early to catch these — don't wait until quality gates.
