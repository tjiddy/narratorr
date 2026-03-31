---
scope: [frontend]
files: [src/client/components/ManualAddForm.tsx]
issue: 246
source: review
date: 2026-03-31
---
When adding `.refine()` for numeric validation on a string field, always `.trim()` first. `Number('   ')` evaluates to `0`, not `NaN`, so whitespace-only input silently passes `!Number.isNaN(Number(v))` and gets coerced to `0` in the submit handler. The Zod `.trim()` method normalizes whitespace before the refine runs.
