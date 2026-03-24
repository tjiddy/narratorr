---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 351
date: 2026-03-14
---
When adding a "Missing" status pill to the library page, the regex `/Missing/i` matches both the new pill button AND the existing "Remove Missing" toolbar button. Use anchored regex like `/^Missing\s*\d*$/i` to match only the status pill (which contains the label + count). Same pattern applies to any status name that overlaps with existing button labels.
