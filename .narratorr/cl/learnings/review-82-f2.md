---
scope: [scope/backend, scope/services]
files: [src/server/services/auth.service.test.ts]
issue: 82
source: review
date: 2026-03-25
---
`isEncrypted(value)` only proves a value was encrypted — it does not prove that the value is the same as the original. When testing that a service method "preserves" a field, the assertion must decrypt and compare to the original value. An implementation that regenerates a secret and encrypts the new one would pass an `isEncrypted` check but fail a decrypt-and-compare check.

**Why I missed it:** I thought "encrypted = preserved" but encryption only proves format, not identity. The distinction matters whenever fields could be regenerated vs passed through.

**What would have prevented it:** When testing field preservation (especially secrets via encryptFields/decryptFields), always use `decryptFields` to recover the original value and assert equality to the input.
