---
scope: [backend]
files: [src/server/services/import-list.service.ts]
issue: 285
source: review
date: 2026-03-11
---
The spec explicitly stated "fetch detail for ASIN if providerId present" but enrichItem() only used inline search result fields. When the spec describes a multi-step data flow (search → detail lookup), implement all steps — don't stop at the first call just because it might have the data inline.
