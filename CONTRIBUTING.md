# Contributing to Narratorr

> If something here looks thin or out of date, please open an issue or PR.

## Getting Started

```bash
git clone https://github.com/tjiddy/narratorr.git
cd narratorr
pnpm install
pnpm dev           # API on :3000, Vite on :5173
```

## Development Workflow

1. Find or open an issue describing what you want to change.
2. Branch off `develop`: `git checkout -b feature/<short-slug>`.
3. Make your changes with tests for anything new or modified.
4. Run the quality gates (see below).
5. Open a PR against `develop`.

PRs target `develop` (the integration branch); `main` is release-only.

## Quality Gates

Before opening a PR, all of these must pass:

```bash
pnpm lint        # ESLint
pnpm test        # Vitest
pnpm typecheck   # TypeScript strict
pnpm build       # Full build
```

Or run them all at once:

```bash
pnpm verify
```

## Architecture Overview

```
src/
  server/
    routes/       — Fastify route handlers (export async function, take app + services)
    services/     — Business logic classes (constructor: db + logger)
    jobs/         — Background tasks
  client/
    pages/        — React page components
    components/   — Shared UI components
    lib/          — API client, utilities
  shared/         — Zod schemas and registries shared between client and server
  core/
    indexers/     — Search adapter implementations (IndexerAdapter interface)
    download-clients/  — Download client implementations (DownloadClientAdapter interface)
    metadata/     — Metadata provider implementations (MetadataProvider interface)
    utils/        — Shared utilities (parsing, naming, magnets)
  db/
    schema.ts     — Drizzle ORM schema (SQLite)
```

### Key patterns

**Services** use constructor injection with `(db: Db, log: FastifyBaseLogger)`. Some take additional service deps. All instantiated in `routes/index.ts:createServices()`.

**Adapters** (indexers, download clients, metadata) implement interfaces from `src/core/*/types.ts`. They do NOT use a logger — throw errors or return failures; the calling service logs.

**Routes** are registered in `routes/index.ts:registerRoutes()`. Each route file exports an async function taking `(app, ...services)`.

**Frontend** uses React Router (routes in `App.tsx`), nav items in `Layout.tsx`, TanStack Query for server state, Tailwind for styling.

**Database** changes go through Drizzle: edit `db/schema.ts`, run `pnpm db:generate`, and commit the whole `drizzle/` folder — the generated SQL file plus the `meta/` journal and snapshot are co-required (committing only the SQL silently skips the migration in CI). For a column/table **rename**, `db:generate` shows an interactive disambiguation prompt — answer it, or split the change into a drops-only generate then an adds-only generate so each diff is unambiguous.

## Testing

All new/changed code must include tests.

| Layer | Location | Pattern | Example |
|-------|----------|---------|---------|
| Service (mock DB) | `services/*.test.ts` | Mock db + logger, test business logic | `book.service.test.ts` |
| Route (integration) | `routes/*.test.ts` | Fastify `inject()`, mock services | `search.test.ts` |
| Core adapter (HTTP mock) | `src/core/**/*.test.ts` | MSW `setupServer()` | `abb.test.ts` |
| Frontend component | `**/*.test.tsx` | `renderWithProviders` helper | `SearchPage.test.tsx` |
| Frontend hook | `hooks/*.test.tsx` | `renderHook` + wrapper | `useLibrary.test.tsx` |

Global test setup: `src/client/__tests__/setup.ts`
Test helpers: `src/client/__tests__/helpers.tsx` (`renderWithProviders`)

### End-to-end tests

| Kind | Location | Runner | Command |
|------|----------|--------|---------|
| Server integration (real Fastify + DB) | `src/server/__tests__/*.e2e.test.ts` | Vitest | `pnpm test` |
| Browser end-to-end | `e2e/` (critical-path + smoke specs) | Playwright | `pnpm test:e2e` (`pnpm test:e2e:ui` for the UI runner) |

See [e2e/README.md](e2e/README.md) for the Playwright harness, fakes, and fixtures.

## Code Style

- TypeScript strict mode, ESM (`.js` extensions in imports)
- Functional React components
- TanStack Query for server state (no raw `fetch` in components)
- Tailwind CSS (no CSS files)
- `@/` path alias for client imports
- Logger type: `FastifyBaseLogger` from `fastify` (not `BaseLogger` from `pino`)
- Non-submit `<button>` inside a `<form>` must have `type="button"` — the browser default is `type="submit"`, so an unmarked button submits the form on click
- API client methods in `src/client/lib/api/` use domain-prefixed names (`getSystemStatus`, not `getStatus`) — the barrel export spreads them, so an unprefixed name silently overwrites another module's method

ESLint also fails the build on: hollow/tautological test assertions (`narratorr/no-tautological-expect`, on `*.test.ts(x)`), files over 400 lines (`max-lines`), and functions over 150 lines (`max-lines-per-function`).

### Logging guidelines

| Level | When |
|-------|------|
| `error` | Unexpected failures (uncaught exceptions, DB errors, broken APIs) |
| `warn` | Recoverable issues (one indexer failed, missing optional config) |
| `info` | Significant operations (CRUD, downloads, job lifecycle, settings changed) |
| `debug` | Diagnostic detail (API payloads, query params, intermediate state) |

Every catch block must log. Every create/update/delete should log at info. Core adapters (`src/core/`) do NOT log — they throw or return failures.

Wrap `unknown` catch values with `serializeError()` (from `src/server/utils/serialize-error.js`) before passing them to the logger — a raw `unknown` serializes to `{}` in JSON logs. The `narratorr/no-raw-error-logging` ESLint rule enforces this on server code; use the `error:` key.

## Debugging

- **Folder-name parse tester (`POST /api/library/scan-debug`):** body `{ folderName }` → the parsed `{ title, author, series, seriesPosition, asin }`, a per-step `cleanName` trace, the metadata search result, and a library duplicate check. The tool for diagnosing import **"No Match"** problems — it shows how a download folder name resolves *before* the metadata lookup, so you can tell a parse failure from a provider miss. The parser is pure functions in `src/server/utils/folder-parsing.ts`; you can call them directly via `pnpm exec tsx` to test a name without auth/HTTP.
- **Search → enrich pipeline trace:** the indexer adapters, blacklist gate, language enrichment, multi-part filter, and quality/language filters emit a per-result audit trail at `debug` level, so a single search can be replayed from the logs. Set `LOG_LEVEL=debug` (env var, at boot) or the General-settings log level, then grep by `title:` substring (or `guid:` / `infoHash:`) to follow one result through the pipeline.

See `SECURITY.md` for the full security model.
