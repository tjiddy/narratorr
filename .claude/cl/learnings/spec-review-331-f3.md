---
scope: [scope/backend]
files: [src/server/config.ts]
issue: 331
source: spec-review
date: 2026-03-10
---
Spec hardcoded `/config/recycle/{book_id}` but the app uses runtime-configurable `CONFIG_PATH` (exposed as `config.configPath`). Prevention: never hardcode filesystem paths in specs — always reference them relative to the config/env variable that controls them. Check `config.ts` for the source of truth before specifying paths.
