---
scope: [scope/frontend]
files: [src/client/hooks/useMatchJob.ts, src/client/hooks/useMatchJob.test.ts]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that useMatchJob's poll error handler non-Error fallback had no test. The existing test proved error='Job expired' for Error rejections but not the 'Unknown error' fallback or the stopPolling() side effect for non-Error rejections.

Why we missed it: Identical root cause to F7. Two independent catch blocks in the same file, both needing non-Error tests.

What would have prevented it: Same as F7 — a full-diff scan for instanceof-Error ternaries would have caught both F7 and F8 together.
