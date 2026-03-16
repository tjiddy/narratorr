---
scope: [backend]
files: [src/shared/schemas/common.ts, src/server/routes/recycling-bin.ts]
issue: 359
source: review
date: 2026-03-15
---
The shared `idParamSchema` uses `z.string().transform(parseInt)` which only rejects NaN — it allows zero and negative IDs. The old local recycling-bin schema used `z.coerce.number().int().positive()` which rejected both. When swapping to the shared schema, the validation contract changed subtly. Always read the target schema's actual validation rules before claiming behavioral equivalence.
