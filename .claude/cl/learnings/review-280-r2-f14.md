# F14: Restore upload error-status mapping untested

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/backend, scope/api
- **Resolution**: fixed
- **Files**: src/server/routes/system.ts, src/server/routes/system.test.ts

Each HTTP status branch (400 for missing file/invalid zip/validation failure, 500 for unexpected errors) needs its own route test to prevent regression. Without per-branch coverage, status codes can drift without anyone noticing.
