---
scope: [scope/backend]
files: [src/server/config.ts, src/server/services/backup.service.ts]
issue: 315
source: spec-review
date: 2026-03-11
---
Spec hardcoded `config/secret.key` as the fallback key file path, but the app already has a configurable config root via `CONFIG_PATH` env var / `config.configPath`. BackupService and server startup both use this configurable path. Lesson: when adding any new persisted file, check how existing persisted artifacts (DB, backups, logs) resolve their paths — follow the same pattern. Grep for `configPath` to find the convention.
