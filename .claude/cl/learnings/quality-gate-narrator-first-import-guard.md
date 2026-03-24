---
scope: [backend, services]
files: [src/server/services/quality-gate.helpers.ts, src/server/services/quality-gate.service.test.ts]
issue: 62
date: 2026-03-24
---
In `buildQualityAssessment`, the `duration_delta` and `no_quality_data` checks have `book.path !== null` guards but the narrator comparison block did not — first imports with narrator metadata were incorrectly held. When adding new quality checks to this function, always verify the guard pattern matches the `duration_delta` guard at line 59: `book && book.path !== null`. The service decision tree checks `holdReasons.length > 0` BEFORE the first-import auto-import bypass, so any unguarded hold reason in the helpers will trump the bypass.
