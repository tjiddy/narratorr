---
scope: [backend]
files: [apps/narratorr/src/shared/schemas.ts]
issue: 127
source: review
date: 2026-02-23
---
The client form schema had superRefine validation for enabled+empty ffmpegPath, but the server-side updateSettingsSchema didn't. Direct API calls could bypass the client and save invalid config. When adding cross-field validation, always add it to BOTH the client form schema AND the server update schema. The server schema is the trust boundary.
