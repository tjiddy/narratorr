---
scope: [backend]
files: [src/server/services/rename.service.test.ts]
issue: 231
source: review
date: 2026-03-30
---
When a single conditional gates multiple tokens (trackNumber, trackTotal, partName), each token needs its own assertion proving it is omitted (single-file) or included (multi-file). Testing only one token per branch leaves the others unproven — a regression dropping one token would pass the suite. Use templates that reference only the token under test (e.g., `{title}{ of ?trackTotal}` to isolate trackTotal, `{trackNumber} - {partName}` to isolate partName).
