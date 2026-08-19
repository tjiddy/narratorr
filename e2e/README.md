# E2E Test Harness

Playwright-based browser E2E tests for Narratorr. Hermetic by design — each run
boots Narratorr against per-run temp directories (DB / library / config /
downloads / source) and fakes for MAM and qBittorrent. The root and subpath
servers run with `AUTH_BYPASS=true`; the forms server runs with auth enforced.

Three servers boot in a single run, each with its own isolated temp-dir set and
seeded DB (#1556, #1555):

- the **root** server (`URL_BASE=/`, port `3100`) — runs the critical-path and
  smoke specs under the `chromium` project;
- the **subpath** server (`URL_BASE=/narratorr`, port `3101`) — assembled
  reverse-proxy coverage, runs only `tests/subpath/**` under the
  `chromium-subpath` project. Its `baseURL` carries a trailing slash
  (`http://localhost:3101/narratorr/`) so relative navigation
  (`page.goto('library')`) resolves under the prefix; a leading-slash path is
  origin-rooted and strips the prefix — reserved for the deliberate
  non-prefixed 404 check. The prefix/port/base is defined once in
  `fixtures/subpath.ts`.
- the **forms** server (`URL_BASE=/`, port `3102`) — booted **without**
  `AUTH_BYPASS` so the real login/session/redirect loop is exercised. Runs only
  `tests/auth/**` under the `chromium-forms` project, which depends on the
  `auth-setup` project. The port/baseURL/credentials/storageState path are
  defined once in `fixtures/auth.ts`.

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

`playwright.config.ts` uses Playwright's `webServer` (an array of three entries —
root + subpath + forms) to launch `node --import tsx ./fixtures/seed-and-serve.ts`
per server. That wrapper — **not** the bundle directly — is the entry point:
Playwright starts `webServer` entries *before* `globalSetup`, and that is not
configurable, so seeding anywhere else lets the health probe reach a server that
booted against an empty DB (#2452). In one process the wrapper (a) seeds its own
run's DB from its own env, (b) proves the marker rows are readable through a
**fresh** connection, then (c) `import`s `../../dist/server/index.js`. Any failure
in (a) or (b) exits non-zero with a diagnostic naming the db path and never starts
the server. `--import tsx` registers the loader in-process, so Playwright still
manages exactly one PID per server and its existing kill path keeps working.

These are the env vars (the root server's values shown; the subpath/forms servers
differ in `PORT`, `URL_BASE`, `AUTH_BYPASS`, and their isolated temp-dir paths). The
shared env builder lives in `fixtures/server-env.ts`, which takes an `authBypass`
flag (the forms server passes `false`, omitting `AUTH_BYPASS` entirely):

| Var                     | Value                                                       |
|-------------------------|-------------------------------------------------------------|
| `NODE_ENV`              | `production`                                                |
| `PORT`                  | `3100` root / `3101` subpath / `3102` forms (off 3000/5173 to avoid dev clash) |
| `DATABASE_URL`          | per-run temp libSQL file under `os.tmpdir()`                |
| `CONFIG_PATH`           | per-run temp directory (scopes `secret.key` etc.)           |
| `AUTH_BYPASS`           | `true` on root/subpath — skips login; **omitted** on forms so auth is enforced |
| `URL_BASE`              | `/` root / `/narratorr` subpath / `/` forms                 |
| `MONITOR_INTERVAL_CRON` | `*/2 * * * * *` — override of prod's 30s cadence            |
| `E2E_DOWNLOADS_PATH`    | per-run downloads temp dir (surfaced for spec forensics)    |
| `E2E_SEED_LIBRARY_DIR`  | per-run library temp dir — read by the **seed wrapper**, ignored by the server |

Note the library key is deliberately not spelled `LIBRARY_PATH`: the server
ignores that variable (`settings.library.path` is what it reads), and
`global-setup.test.ts` pins its absence from `playwright.config.ts`.

### Ownership model

Four files split the harness lifecycle:

1. **`playwright.config.ts`** (module load, synchronous): calls
   `resolveRunTempDirs([root, subpath, forms])`. The **first** config load of an
   invocation allocates five `mkdtempSync` directories per run (15 total),
   publishes a **run manifest** recording every path, and exports its location on
   `process.env.E2E_RUN_MANIFEST`; every later config load in the same invocation
   — worker processes, tooling — adopts that manifest and allocates nothing. An
   unconditional allocation here is what previously leaked ~15 directories per
   config load. Paths must exist by the time `webServer.env` is evaluated, so this
   can't move to `globalSetup`. The `E2E_RUN_STATE_DIR` handoff stays pointed at
   the **root** run's config path.
2. **`fixtures/seed-and-serve.ts`** (per server, before the server exists): seeds
   that server's DB, verifies the seed through a fresh connection, then boots the
   bundle. This is where the seed-before-boot guarantee lives — structurally, in
   one process, not by assumption about setup ordering.
3. **`global-setup.ts`** (async, after webServer boots): starts the MAM + qBit +
   Audible fakes on their fixed ports, pre-seeds MAM with the search fixture,
   stages the manual-import tree under `sourcePath`, publishes the `E2E_*` env
   handoff, and writes `.run-paths.json`. It does **no** DB seeding — anything
   seeded here would land after the servers have already booted.
4. **`global-teardown.ts`** (after tests): three independently guarded stages, in
   order — close the registered fake handles; remove every path the manifest
   records (plus anything this process allocated itself), including libSQL
   `-wal`/`-shm` sidecars; then sweep stale `narratorr-e2e-*` directories in
   `os.tmpdir()`. A failure in one stage never skips a later one, and teardown
   never rejects: a Windows `EPERM` on a directory that held a libSQL database is
   expected, not an error.

**Confinement.** The manifest is durable state on disk and `removeTreeSync` does
no validation of its own, so one lexical predicate — `isHarnessTempRoot` in
`fixtures/temp-dirs.ts`, built on the repo's `canonicalPath` — gates both cleanup
consumers. A manifest that is missing, unreadable, malformed, or names any path
outside `os.tmpdir()/narratorr-e2e-*` yields **zero** manifest-owned removals
rather than an error. The sweep's floor is strictly exclusive (`mtime < now -
SWEEP_MAX_AGE_MS`, 24h) so a concurrent invocation's directories are never
touched, and it runs even when no manifest is found — it is the second line for
batches allocated by tooling processes that never run teardown.

Allocation is all-or-nothing: if any `mkdtempSync` or the manifest publication
fails, every directory recorded so far is removed, the env var stays unpublished,
and the original error is rethrown. The manifest itself is written to a temporary
sibling and `renameSync`d into place, so no reader can observe a torn file.

(The other on-disk state is the per-run `.run-paths.json` inside each run's
`configPath`, written by `global-setup.ts` so manual-import workers can resolve
the source path. Both files live in the root run's `configPath`, so removing that
directory removes them.)

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
├── global-setup.ts               # starts fakes + stages fixtures (async, runs AFTER webServer boots)
├── global-setup.test.ts          # vitest — setup orchestration + webServer wiring sentinels
├── global-teardown.ts            # closes fakes, removes manifest-owned dirs, sweeps stale strays
├── global-teardown.test.ts       # vitest — cleanup contract regression tests
├── fixtures/
│   ├── temp-dirs.ts              # allocate-once run manifest, per-run dirs, and the confinement predicate
│   ├── temp-dirs.test.ts         # vitest — allocation, manifest validation, and rollback tests
│   ├── seed-and-serve.ts         # the webServer entry: seed → verify through a fresh conn → boot the bundle
│   ├── seed-and-serve.test.ts    # vitest — ordering, fail-closed, port resolution, CLI adapter
│   ├── ports.ts                  # fake-service default ports + resolvePort, shared by setup and the wrapper
│   ├── run-state.ts              # fake-server handle registry
│   ├── run-state.test.ts         # vitest
│   ├── subpath.ts                # single source of truth for the subpath topology (port/prefix/baseURL)
│   ├── auth.ts                   # single source of truth for the forms-auth topology (port/baseURL/creds/authFile)
│   ├── server-env.ts            # builds each server's env (authBypass flag)
│   ├── server-env.test.ts       # vitest — env builder contract (forms omits AUTH_BYPASS)
│   ├── seed.ts                   # Drizzle seed for indexer/client/author/book rows
│   └── seed.test.ts              # vitest
├── fakes/
│   ├── torrent.ts                # minimal bencode builder + info_hash computer
│   ├── torrent.test.ts           # vitest
│   ├── mam.ts                    # MyAnonamouse fake (Fastify, :4100)
│   ├── mam.test.ts               # vitest
│   ├── qbit.ts                   # qBittorrent WebUI fake (Fastify, :4200)
│   ├── qbit.test.ts              # vitest
│   ├── audible.ts                # Audible catalog fake (Fastify, :4300)
│   └── audible.test.ts           # vitest
├── assets/
│   └── silent.m4b                # 10-second silent fixture (~4KB, AAC)
└── tests/
    ├── smoke/
    │   └── library.spec.ts       # Playwright — library page smoke (root project)
    ├── critical-path/
    │   ├── search-grab-import.spec.ts  # Playwright — search → grab → import (root project)
    │   └── manual-import.spec.ts       # Playwright — manual import flow (root project)
    ├── subpath/
    │   └── subpath-smoke.spec.ts       # Playwright — reverse-proxy subpath smoke (chromium-subpath project)
    └── auth/
        ├── auth.setup.ts              # Playwright — forms-auth bootstrap (auth-setup project, writes storageState)
        └── forms-auth.spec.ts         # Playwright — login/redirect/logout (chromium-forms project)
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

## Forms auth bootstrap (#1555)

The root and subpath servers run with `AUTH_BYPASS=true` — no login flow. The
**forms** server (port `3102`) instead boots **without** `AUTH_BYPASS` so the
real login/session/redirect loop is covered, using Playwright's `storageState`
pattern. Two projects drive it:

- **`auth-setup`** (`tests/auth/auth.setup.ts`) runs first (the forms project
  `dependsOn` it) and bootstraps auth in a load-bearing order — `AuthService`
  rejects flipping to a non-`none` mode while zero users exist:
  1. `POST /api/auth/setup` — create the user (public while mode is `none`);
  2. `PUT /api/auth/config` `{ mode: 'forms' }` — flip the mode;
  3. `POST /api/auth/login` — establish the `narratorr_session` cookie;
  4. `page.context().storageState({ path })` — persist the authenticated state.

  All three HTTP calls go through **`page.request`** (the page's browser-context
  request), NOT the standalone `{ request }` fixture — only the browser-context
  request shares its cookie jar with the page, so the login `Set-Cookie` lands in
  the jar that `storageState()` then captures. The isolated fixture would save an
  unauthenticated state (login still returns 200, but the forms project would
  start logged out).

- **`chromium-forms`** (`tests/auth/forms-auth.spec.ts`) reuses that
  `storageState` and asserts: unauthenticated navigation redirects to `/login`
  (this spec overrides to an empty context, which is also the live guard against
  an accidental bypass), the authenticated context reaches `/library` with
  `GET /api/auth/status` → `{ mode: 'forms', authenticated: true }`, and logout
  clears the session.

  **Logout is exercised via the `POST /api/auth/logout` API** (through
  `page.request`, sharing the page's cookie jar), not a UI click — the client
  exposes `logout()` but no rendered control calls it, and this harness work is
  scoped to no production code changes. Adding a logout control is a separate
  (production) issue.

The persisted state is written to `e2e/.auth/forms-user.json` (gitignored — it
holds a live session cookie). The topology (port, baseURL, credentials, auth-file
path) is defined once in `fixtures/auth.ts`.

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

Indexers, download clients, authors, and books are seeded via `fixtures/seed.ts`,
called by the **seed wrapper** (`fixtures/seed-and-serve.ts`) inside each server's
own launch process — not by `global-setup.ts`, which Playwright runs *after* the
servers boot. The wrapper will not start the server until it has re-read the
`settings.general` and `books` marker rows through a connection that did not write
them, so a boot-time reader (log level, job recovery, welcome gate) can never
observe a pre-seed world. Narratorr's migrations re-run idempotently at boot
(Drizzle journal handles dedup), so seeding first is safe.

The seed's inserts are not upserts, so seeding the same DB twice fails on a
duplicate row and the transaction rolls back — deliberate, so a retried server
start has defined behaviour rather than silently double-seeding.

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
