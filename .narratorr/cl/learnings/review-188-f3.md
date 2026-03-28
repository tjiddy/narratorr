---
scope: [core]
files: [src/core/utils/audio-processor.ts]
issue: 188
source: review
date: 2026-03-28
---
Structural property access `(error as { stderr?: string }).stderr` needs the same null/object guard as `code` checks. The `message` line in the same block was already guarded with `instanceof Error`, but `stderr` was overlooked. After an annotation sweep, grep `(error as {` for all remaining structural casts and verify each has an object guard before the cast.
