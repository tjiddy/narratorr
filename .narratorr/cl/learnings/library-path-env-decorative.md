---
scope: [backend, infra]
files: [src/server/config.ts, src/server/services/import.service.ts, src/shared/schemas/settings/registry.ts]
issue: 614
date: 2026-04-16
---
`LIBRARY_PATH` is declared in `src/server/config.ts` and surfaced as `config.libraryPath`, but nothing in runtime code reads `config.libraryPath` — only `settings.library.path` (from the DB) is consulted. That means setting `LIBRARY_PATH` via env at boot does NOTHING; you must seed the `library` settings row. Import blew up with `statfs ENOENT on C:\\audiobooks` (registry default) even though we set `LIBRARY_PATH=<tempdir>`. Either wire `config.libraryPath` into initial-settings provisioning, or delete the env var + transform to stop the false affordance.
