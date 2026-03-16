# F17: Backup list invalidation after create untested

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/frontend
- **Resolution**: fixed
- **Files**: src/client/pages/settings/SystemSettings.tsx, src/client/pages/settings/SystemSettings.test.tsx

Same pattern as F16 — assert that getBackups is called at least twice (initial load + refetch after mutation). This ensures the backup list actually refreshes after a new backup is created.
