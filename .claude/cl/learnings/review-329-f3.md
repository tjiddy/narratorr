---
scope: [infra]
files: [package.json]
issue: 329
source: review
date: 2026-03-11
---
The issue spec explicitly said to remove `@types/node-cron` if node-cron 4 ships bundled types. I confirmed during spec review that node-cron 4 doesn't ship types (based on the version at spec time), but the actual installed node-cron@4.2.1 does ship them via its `exports` field. Should have re-verified the types situation after installation rather than relying on the spec's original assessment.
