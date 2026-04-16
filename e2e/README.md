# E2E Test Harness

Playwright-based browser E2E tests for Narratorr. Hermetic by design — each run
boots Narratorr against three per-run temp directories and `AUTH_BYPASS=true`.

## Quick start

```bash
pnpm build          # E2E runs against the built bundle (dist/)
pnpm test:e2e       # run the smoke suite headlessly
pnpm test:e2e:ui    # interactive debugging (Playwright UI)
```

First-time setup also needs browser binaries:

```bash
pnpm exec playwright install chromium
```

## How the harness is wired

`playwright.config.ts` uses Playwright's `webServer` to launch `node ../dist/server/index.js` with these env vars:

| Var            | Value                                              |
|----------------|----------------------------------------------------|
| `NODE_ENV`     | `production`                                       |
| `PORT`         | `3100` (kept off 3000/5173 to avoid dev clash)     |
| `DATABASE_URL` | per-run temp libSQL file under `os.tmpdir()`       |
| `LIBRARY_PATH` | per-run temp directory                             |
| `CONFIG_PATH`  | per-run temp directory (scopes `secret.key` etc.)  |
| `AUTH_BYPASS`  | `true` — skips login for Phase 1 smoke             |
| `URL_BASE`     | `/`                                                |

The three temp directories are created by `fixtures/temp-dirs.ts` at config-load
time and persisted to `.run-state.json`. `global-teardown.ts` reads that file
after the run and removes all three (including libSQL `-wal`/`-shm` sidecars).

`reuseExistingServer: false` — local `--ui` mode still boots its own hermetic
server. This prevents silent attachment to a `pnpm dev:server` / `pnpm dev:client`
process that would be using the committed `./config`, `./audiobooks`, and DB.

## Folder layout

```
e2e/
├── playwright.config.ts   # Playwright config + webServer wiring
├── tsconfig.json          # extends root tsconfig, scopes to e2e/**
├── global-teardown.ts     # cleans the temp dirs after the run
├── fixtures/
│   └── temp-dirs.ts       # creates per-run DB/library/config temp dirs
├── fakes/                 # (Phase 2+) fake external service servers
├── assets/                # (Phase 2+) test fixtures — audio files, covers
└── tests/
    └── smoke/
        └── library.spec.ts
```

## Debugging a CI failure

1. Open the failed workflow run in GitHub Actions.
2. Download the `playwright-report` artifact from the **Artifacts** section.
3. Extract and run:
   ```bash
   npx playwright show-report path/to/extracted/report
   ```
4. For per-test traces (available on retry-or-failure), download `test-results`
   and use:
   ```bash
   npx playwright show-trace path/to/trace.zip
   ```

## Containment surface (Phase 1)

E2E runs boot with empty settings — no indexers, download clients, or import
lists configured, so user-facing outbound flows are inert. Two unconditional
jobs remain scheduled:

- **`version-check`** — cron `0 2 * * *` (server local time). Hits
  `api.github.com/repos/tjiddy/narratorr/releases/latest` when it fires. Smoke
  runs outside a 2am-local window do not trigger it. Not suppressed in Phase 1.
- **`enrichment`** — cron `*/5 * * * *`. A no-op against an empty book table
  regardless of whether a run overlaps a tick.

If a future phase needs categorical zero-network behavior, we add an E2E-only
env flag to suppress these jobs (e.g. `DISABLE_JOBS=version-check,enrichment`).
Not day one.

## Forms auth bootstrap (deferred)

Phase 1 uses `AUTH_BYPASS=true` — no login flow exercised. The first Phase 2+
issue that needs auth-sensitive testing will add forms-auth bootstrap via
Playwright's `storageState` pattern:

1. Global setup creates a test user via `POST /api/auth/setup`.
2. Flips auth mode to `forms` via `PUT /api/auth/config`.
3. Logs in via `POST /api/auth/login`, captures the cookie.
4. Writes the cookie to `storageState.json`; test projects reuse it.

None of this exists today — adding it prematurely would be scaffolding without
a consumer.

## Phase 1 scope

See issue [#612](https://github.com/tjiddy/narratorr/issues/612) for the full
spec. One smoke test, one chromium project, no fakes, no auth flow. Critical
path tests and additional browsers are Phase 2+ follow-up issues.
