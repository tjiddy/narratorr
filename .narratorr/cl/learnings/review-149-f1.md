---
scope: [backend, services]
files: [src/server/services/download.service.ts, src/server/services/download.service.test.ts]
issue: 149
source: review
date: 2026-03-26
---
The `DownloadError` tests verified `instanceof` and `code` but not `e.name`. The issue spec explicitly required `this.name = 'DownloadError'` as part of the constructor contract — deleting that line would not have failed any test. When adding a typed error class, always add a dedicated constructor contract test that asserts `name`, `code`, `message`, and `instanceof Error` together. The `name` field is the primary discriminator in logging and error serialization.
