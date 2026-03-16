# F16: Cache invalidation after settings save untested

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/frontend
- **Resolution**: fixed
- **Files**: src/client/pages/settings/BackupScheduleForm.tsx, src/client/pages/settings/BackupScheduleForm.test.tsx

TanStack Query cache invalidation tests should assert that the query function is called again (refetch) after the mutation's onSuccess runs. Without this, the invalidation wiring in onSuccess could be deleted and tests would still pass.
