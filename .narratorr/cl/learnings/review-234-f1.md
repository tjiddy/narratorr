---
scope: [frontend]
files: [src/client/hooks/useConnectionTest.ts, src/client/hooks/useConnectionTest.test.ts]
issue: 234
source: review
date: 2026-03-31
---
When modifying a shared hook that has multiple code paths (handleTest by-ID and handleFormTest by-config), both paths need regression tests even if the fix is identical. We only tested the form path because it was the more obvious caller, but the saved-card path (handleTest) was also changed and ships without coverage. The /plan step should enumerate all callers of a changed function and map each to a test.
