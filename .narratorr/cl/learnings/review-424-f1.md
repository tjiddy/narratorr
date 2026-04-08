---
scope: [core]
files: [src/core/utils/cover-art.ts, src/core/utils/audio-processor.ts]
issue: 424
source: review
date: 2026-04-08
---
Reviewer caught that cover art degradation (extraction or reattach failure) was completely silent. The spec's system behaviors said "logs a warning and completes successfully" but the implementation only did the second part. Since `src/core/` must not log directly (CLAUDE.md), the fix was adding an `onWarning` callback to `withCoverArtPipeline`, wired to the existing `onStderr` channel from callers. Gap: the `/plan` step should flag spec requirements containing both "warn" and "succeed" as needing explicit observable-warning tests, not just success assertions.
