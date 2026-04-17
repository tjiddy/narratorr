# E2E Test Harness

Playwright-based browser E2E tests for Narratorr. Hermetic by design — each run
boots Narratorr against four per-run temp directories (DB / library / config /
downloads), fakes for MAM and qBittorrent, and `AUTH_BYPASS=true`.

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

| Var                     | Value                                                       |
|-------------------------|-------------------------------------------------------------|
| `NODE_ENV`              | `production`                                                |
| `PORT`                  | `3100` (kept off 3000/5173 to avoid dev clash)              |
| `DATABASE_URL`          | per-run temp libSQL file under `os.tmpdir()`                |
| `LIBRARY_PATH`          | per-run temp directory                                      |
| `CONFIG_PATH`           | per-run temp directory (scopes `secret.key` etc.)           |
| `AUTH_BYPASS`           | `true` — skips login for Phase 1/2                          |
| `URL_BASE`              | `/`                                                         |
| `MONITOR_INTERVAL_CRON` | `*/2 * * * * *` — override of prod's 30s cadence            |
| `E2E_DOWNLOADS_PATH`    | per-run downloads temp dir (surfaced for spec forensics)    |

### Ownership model

Three files split the harness lifecycle along natural sync/async boundaries:

1. **`playwright.config.ts`** (module load, synchronous): calls
   `createRunTempDirs()` which creates four directories via `mkdtempSync` and
   stores them in module-level state. Paths must exist by the time `webServer.env`
   is evaluated, so this can't move to `globalSetup`.
2. **`global-setup.ts`** (async, before webServer boots): reads
   `getCurrentRun()` for paths, starts the MAM + qBit fakes on their fixed ports,
   runs Drizzle migrations, and seeds the `indexers` / `download_clients` /
   `authors` / `books` rows the spec test depends on. Fake handles are registered
   with `fixtures/run-state.ts` so teardown can reach them.
3. **`global-teardown.ts`** (after tests): closes the registered fake handles,
   then removes all four temp dirs (including libSQL `-wal`/`-shm` sidecars).

No on-disk state file — module state is sufficient because Playwright's global
teardown runs in the same Node process that loaded the config, and it avoids
the concurrent-run footgun a shared state file would create.

`reuseExistingServer: false` — local `--ui` mode still boots its own hermetic
server. This prevents silent attachment to a `pnpm dev:server` / `pnpm dev:client`
process that would be using the committed `./config`, `./audiobooks`, and DB.

## Two test runners, two extensions

This folder intentionally hosts both runners, disambiguated by file extension:

| Extension   | Runner     | Purpose                                              |
|-------------|------------|------------------------------------------------------|
| `*.spec.ts` | Playwright | Browser E2E — invoked by `pnpm test:e2e`             |
| `*.test.ts` | vitest     | Unit tests for harness helpers — invoked by `pnpm test` |

Vitest discovers `e2e/fixtures/**/*.test.ts` and `e2e/*.test.ts` via
`vitest.config.ts`. This keeps cleanup-contract tests (e.g. does
`globalTeardown` remove every temp dir?) under deterministic regression
coverage without requiring a browser.

## Folder layout

```
e2e/
├── playwright.config.ts          # Playwright config + webServer wiring
├── tsconfig.json                 # extends root tsconfig, scopes to e2e/**
├── global-setup.ts               # starts fakes + seeds DB (async, pre-webServer)
├── global-setup.test.ts          # vitest — setup orchestration contract
├── global-teardown.ts            # closes fakes + cleans temp dirs after the run
├── global-teardown.test.ts       # vitest — cleanup contract regression tests
├── fixtures/
│   ├── temp-dirs.ts              # creates per-run DB/library/config/downloads dirs
│   ├── temp-dirs.test.ts         # vitest — temp-dir lifecycle tests
│   ├── run-state.ts              # fake-server handle registry
│   ├── run-state.test.ts         # vitest
│   ├── seed.ts                   # Drizzle seed for indexer/client/author/book rows
│   └── seed.test.ts              # vitest
├── fakes/
│   ├── torrent.ts                # minimal bencode builder + info_hash computer
│   ├── mam.ts                    # MyAnonamouse fake (Fastify, :4100)
│   ├── mam.test.ts               # vitest
│   ├── qbit.ts                   # qBittorrent WebUI fake (Fastify, :4200)
│   └── qbit.test.ts              # vitest
├── assets/
│   └── silent.m4b                # 10-second silent fixture (~4KB, AAC)
└── tests/
    ├── smoke/
    │   └── library.spec.ts       # Playwright — library page smoke
    └── critical-path/
        └── search-grab-import.spec.ts  # Playwright — full pipeline
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

## Writing critical-path tests

Patterns locked in by the Phase 2 spec ([#614](https://github.com/tjiddy/narratorr/issues/614)):

### Fake control pattern

Specs and `global-setup.ts` run in separate processes, so specs can't manipulate
fake state via module imports. Each fake exposes HTTP control endpoints for
spec-side use:

- **MAM** (`http://localhost:4100`):
  - `POST /__control/seed` — `{ query, fixtures }` seeds search results
  - `POST /__control/reset` — clears all seeds
- **qBit** (`http://localhost:4200`):
  - `POST /__control/complete` — `{ hash }` flips state to `uploading` and stages the fixture
  - `POST /__control/complete-latest` — convenience for single-torrent flows
  - `POST /__control/reset` — clears all torrents

**Spec-side URLs must come from an imported helper, not `process.env`.**
Playwright's `globalSetup` runs in the config process; `process.env` mutations
there do NOT propagate to test worker processes. A spec reading
`process.env.E2E_QBIT_URL` at runtime gets `undefined`. Import the
`qbitControlUrl(path)` helper from `global-setup.ts` instead — it resolves to
the fixed default port (4200) when the env is absent, which matches the
static port wired through `playwright.config.ts`. Future MAM helpers should
follow the same pattern. The `E2E_MAM_URL` / `E2E_QBIT_URL` env writes in
`global-setup.ts` are only useful to same-process code (e.g. globalTeardown).

### Async UI wait pattern

The pipeline is async: grab → monitor poll → import → DB write → SSE/query
refetch. Prefer Playwright's auto-retrying web-first assertions against the UI
over internal signals:

```ts
await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 25_000 });
```

25s covers one `MONITOR_INTERVAL_CRON` cycle (2s) + import (sub-second) +
React Query refetch with comfortable headroom. DOM truth is cheaper than
plumbing SSE into the harness. If the UI wait ever becomes too slow to be
practical, fall back to polling `/api/books/:id` — but default to the UI.

### DB seed pattern

Indexers, download clients, authors, and books are seeded pre-boot via
`fixtures/seed.ts`. Narratorr's migrations re-run idempotently at boot (Drizzle
journal handles dedup), so seeding first is safe.

**Do not** add a `savePath` field to the seeded `download_clients.settings` —
`qbittorrentSettingsSchema` is `.strict()` and has no such field. The fake qBit
defaults its `save_path` to the per-run downloads dir instead.

### `MONITOR_INTERVAL_CRON` override

Production defaults to `*/30 * * * * *` (30s poll). The harness sets this to
`*/2 * * * * *` so a grab → completion → import chain finishes in under 10s
instead of under 40s. Env-configurable via `src/server/config.ts`.

## Issue history

- **Phase 1** (#612): harness scaffold + one smoke test.
- **Phase 2 critical path #1** (#614): search → grab → fake download → import → library.
