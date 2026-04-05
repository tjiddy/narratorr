---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 361
date: 2026-04-05
---
When adding indexer-ID-aware detection for masked credentials, the blur and refresh code paths must be treated asymmetrically: blur fires with whatever value is in the input (including the pre-populated sentinel), so it must explicitly exclude sentinel values. Refresh is intentional user action where sentinel + indexerId is a valid combination. Initial implementation missed this — the blur test caught it because `detect()` no longer guarded sentinel when indexerId was present. Fix: add `val !== '********'` guard in the blur handler itself, not just in `detect()`.
