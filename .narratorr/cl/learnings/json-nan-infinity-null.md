---
scope: [backend, frontend]
files: []
date: 2026-04-10
---
`JSON.stringify(NaN)` → `null`. `JSON.stringify(Infinity)` → `null`. These values do not survive API boundaries. Any numeric computation that can produce NaN or Infinity must be validated before serialization, and consumers must handle `null` on the receiving end. Common sources: division by zero (→ Infinity), parsing non-numeric strings with `Number()` (→ NaN), `0/0` (→ NaN).
