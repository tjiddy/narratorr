---
scope: [backend]
files: [src/server/routes/recycling-bin.ts, src/shared/schemas/common.ts]
issue: 359
source: review
date: 2026-03-15
---
When consolidating a local schema to use a shared one (L-19), the shared `idParamSchema` only rejects NaN via `parseInt()` while the local one used `z.coerce.number().int().positive()` to also reject 0 and negatives. This weakened the validation contract silently. Must compare both schemas' actual validation rules before swapping — "same name" doesn't mean "same contract." When schemas have different strictness levels, keep the stricter local variant with a comment explaining why.
