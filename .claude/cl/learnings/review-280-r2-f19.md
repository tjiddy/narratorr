# F19: Temp directory leak on successful restore

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/backend
- **Resolution**: fixed
- **Files**: src/server/services/backup.service.ts

confirmRestore only deleted the DB file, not its parent extraction directory. Use fs.rm(path.dirname(tempPath), {recursive: true}) to clean up the whole extraction dir and prevent temp directory accumulation over time.
