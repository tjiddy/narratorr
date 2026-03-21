---
scope: [core]
files: [src/core/utils/audio-scanner.ts, src/core/utils/audio-scanner.test.ts]
issue: 47
date: 2026-03-21
---
When adding a new call to a mocked module function (e.g., `stat()`) in a code path that previously didn't call it, ALL existing tests that mock that function must be updated to return objects matching the NEW callers' interface — not just the existing callers'. In this case, existing `mockStat.mockResolvedValue({ size: X })` mocks had to gain `isFile: () => false, isDirectory: () => true` because `collectAudioFiles()` now calls `stat(dirPath).isFile()` before `readdir()`. Calling `undefined()` on a missing method is caught by the try/catch, which silently returns `[]` and breaks tests expecting successful scans. The fix is to ensure mock return shapes satisfy ALL callers of the mocked function, not just the ones you're currently writing tests for.
