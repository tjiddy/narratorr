---
scope: [backend, api]
files: [src/server/routes/settings.ts]
issue: 315
source: review
date: 2026-03-11
---
When adding response masking, any route that compares request values against stored values for change detection will break — masked sentinels always differ from the stored plaintext. The sentinel normalization must happen BEFORE comparison, not after. This is a predictable interaction between masking and any "detect actual changes" logic. Should check for this pattern during self-review.
