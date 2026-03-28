---
scope: [backend, services]
files: [src/server/services/quality-gate.helpers.ts]
issue: 62
date: 2026-03-24
---
AC5 required skipping narrator comparison when either side "produces no tokens after normalization" — not just when the raw string is null/empty. Checking truthiness of the input string before tokenizing is not sufficient: a whitespace-only string (`"  "`) is truthy but tokenizes to an empty array. After calling `tokenize()`, always check `existingTokens.length > 0 && downloadTokens.length > 0` before doing the comparison. Without this check, a whitespace-only narrator would produce `narratorMatch=false` (a false mismatch hold) instead of `narratorMatch=null` (skipped). Self-review caught this before push.
