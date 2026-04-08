---
scope: [core]
files: [src/core/utils/audio-processor.ts, src/core/utils/cover-art.ts]
issue: 424
source: review
date: 2026-04-08
---
Round 2 reviewer caught that fixing F1 with only an optional callback (`onStderr`) left import and bulk-convert callers silent since they don't pass callbacks. The fix was adding `warnings?: string[]` to `ProcessingResult` so all callers get degradation info through the return value. Lesson: when a shared function surfaces information through an optional callback, verify ALL production callers supply that callback — if any don't, the information must also be available through the return value.
