---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.tsx, src/client/pages/manual-import/pathUtils.ts]
issue: 175
date: 2026-03-28
---
startsWith() path ancestry checks can be bypassed by .. traversal because they check the literal string, not the resolved path. /audiobooks/../secret/Book literally starts with /audiobooks/, so startsWith returns true even though the path resolves outside the library. The fix is segment-based comparison after normalizeSegments() resolves .. and . segments — the pattern already established in isPathInsideLibrary. The distinguishing test case: expect secret/Author/Book (3-part fallback), not ../secret/Author/Book (the buggy relative path).
