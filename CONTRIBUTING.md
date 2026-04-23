# Contributing to Narratorr

> **Note:** This guide is a work in progress and will be expanded before the 1.0 release. If something looks thin or missing, please open an issue.

## Getting Started

```bash
git clone https://github.com/tjiddy/narratorr.git
cd narratorr
pnpm install
pnpm dev           # API on :3000, Vite on :5173
```

## Development Workflow

1. Find or open an issue describing what you want to change.
2. Branch off `main`: `git checkout -b feature/<short-slug>`.
3. Make your changes with tests for anything new or modified.
4. Run the quality gates (see below).
5. Open a PR against `main`.

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

## Code Style

- TypeScript strict mode, ESM (`.js` extensions in imports)
- Functional React components
- TanStack Query for server state (no raw `fetch` in components)
- Tailwind CSS (no CSS files)
- `@/` path alias for client imports
- Logger type: `FastifyBaseLogger` from `fastify` (not `BaseLogger` from `pino`)

### Logging guidelines

| Level | When |
|-------|------|
| `error` | Unexpected failures (uncaught exceptions, DB errors, broken APIs) |
| `warn` | Recoverable issues (one indexer failed, missing optional config) |
| `info` | Significant operations (CRUD, downloads, job lifecycle, settings changed) |
| `debug` | Diagnostic detail (API payloads, query params, intermediate state) |

Every catch block must log. Every create/update/delete should log at info. Core adapters (`src/core/`) do NOT log — they throw or return failures.

See `CLAUDE.md` for additional conventions, gotchas, and architectural context.
