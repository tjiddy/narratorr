---
scope: [scope/backend]
files: [src/server/config.ts]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec hardcoded `/config/backups/` as the backup directory without checking that the app uses configurable paths (`CONFIG_PATH` env var → `config.configPath`). Preventable by reading `config.ts` during elaboration and using the config accessor pattern instead of hardcoding paths. Any spec that references file paths should verify them against the runtime config model.
