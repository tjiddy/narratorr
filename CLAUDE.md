# CLAUDE.md

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Tech Stack

Monorepo (Turborepo + pnpm) | Node.js 20+ | Fastify 5 | Drizzle ORM + libSQL | React 18 + Vite 6 | TanStack Query | Tailwind CSS | Docker

## Project Structure

- `apps/narratorr/src/server/` — Fastify backend (routes/, services/, jobs/, config.ts, index.ts)
- `apps/narratorr/src/client/` — React frontend (pages/, components/, lib/api.ts, App.tsx)
- `apps/narratorr/src/shared/schemas.ts` — Shared Zod schemas
- `packages/core/src/` — Indexer + download client adapters (indexers/, download-clients/, utils/)
- `packages/db/src/` — Drizzle schema (schema.ts), client, migrations
- `packages/ui/` — Shared UI utilities (cn())
- `scripts/gitea.ts` — Gitea API client (TypeScript CLI)

## Commands

```bash
pnpm install       # Install deps
pnpm dev           # Dev servers (API :3000, Vite :5173)
pnpm build         # Build all
pnpm db:generate   # Generate Drizzle migration after schema change
pnpm typecheck     # TypeScript checking
```

## Architecture

- **Services**: Business logic classes in `services/`, instantiated in `routes/index.ts`. See existing services for pattern.
- **Adapters**: Indexers and download clients implement interfaces in `packages/core/src/*/types.ts`.
- **Routes**: Fastify route files export async functions taking app + services. Registered in `routes/index.ts`.
- **Frontend pages**: Components in `pages/`, routes in `App.tsx`, nav in `components/layout/Layout.tsx`.
- **Database**: Edit `packages/db/src/schema.ts` → run `pnpm db:generate` → migrations auto-run on start.

## Code Style

TypeScript strict, ESM (`.js` extensions), functional React components, TanStack Query for server state, Tailwind CSS (no CSS files), `@/` path alias for client imports.

## Logging

Uses Fastify's built-in Pino logger. Log level is configurable at Settings > General.

**Level guidelines:**
- `error` — Unexpected failures needing attention (uncaught exceptions, DB errors, broken external APIs)
- `warn` — Recoverable issues (one indexer failed, missing optional config, silent fallbacks)
- `info` — Significant operations (CRUD, downloads started/completed, job lifecycle, settings changed)
- `debug` — Diagnostic detail (API payloads, query params, intermediate state)

**Where to log:**
- Routes: use `request.log.info(...)` / `request.log.error(error, '...')`
- Services: use `this.log.info(...)` (injected `FastifyBaseLogger` via constructor)
- Jobs: use the `log` instance passed at initialization
- Core adapters (`packages/core/`): do NOT use a logger — throw errors or return failures; the calling service logs

**Important:** Use `FastifyBaseLogger` from `fastify` for logger types — NOT `BaseLogger` from `pino`. Pino is a transitive dependency (not directly installed), so importing from it causes TypeScript errors.

**When adding new code:** Always add appropriate log statements. Every catch block must log. Every create/update/delete should log at info. External API call failures should log at warn or error.

## Testing

All new/changed code must include tests. Run `pnpm test` (Vitest via Turborepo) to execute all suites.

**Conventions:**
- Co-located test files: `foo.ts` → `foo.test.ts` (or `.test.tsx` for JSX)
- Backend services: mock DB, test business logic (`services/*.test.ts`)
- API routes: Fastify `inject()` integration tests (`routes/*.test.ts`)
- Core adapters: MSW for HTTP mocking (`packages/core/**/*.test.ts`)
- Frontend components: Testing Library render tests (`*.test.tsx`)
- Frontend hooks: `renderHook` from Testing Library (`*.test.ts(x)`)
- Global setup (client): `src/client/__tests__/setup.ts` (matchMedia mock, auto-cleanup)
- Test helpers: `src/client/__tests__/helpers.tsx` (`renderWithProviders`)

**Required before PR:** `pnpm lint`, `pnpm test` (zero failures), `pnpm typecheck`, `pnpm build`.

## Project Management (Gitea)

All work is tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Specs live in issue bodies — each issue is self-contained.

```bash
pnpm gitea issues                   # List open issues
pnpm gitea issue <id>               # Read full spec
pnpm gitea issue-update <id> <field> <value>  # Update issue (state/labels/milestone/title/body)
pnpm gitea issue-comment <id> "message"       # Add comment
pnpm gitea prs                      # List open PRs
pnpm gitea pr-create <title> <body> <head> [base]  # Create PR
```

### Workflow Skills

Claude Code skills automate the agent workflow — use these instead of manual steps:

- `/claim <id>` — Read issue, verify ready, post claim comment, set in-progress, create branch
- `/handoff <id>` — Build, push, create PR, post handoff comment
- `/block <id>` — Post blocked comment, set blocked label, stop

## ⚠ Issue Workflow — MANDATORY

**Every task referencing a Gitea issue (#N) MUST follow this lifecycle — no exceptions.**
A detailed plan, pre-made spec, or explicit implementation instructions do NOT bypass these steps.

1. **Before writing any code** → `/claim <id>` (reads issue, verifies ready, comments, sets labels, creates branch)
2. **After tests/typecheck/build pass** → `/handoff <id>` (pushes, creates PR, comments, updates labels, appends workflow log)
3. **If blocked or unable to complete** → `/block <id>` (comments, sets blocked label, stops)

Skipping `/claim` means no branch, no tracking, no audit trail.
Skipping `/handoff` means no PR, no label update, no workflow log entry.

### Labels (2-axis model)

Labels use `/` separators. Two exclusive groups track workflow state:

- **Status** (lifecycle — exactly one): `status/backlog` · `status/ready` · `status/in-progress` · `status/blocked` · `status/done`
- **Stage** (pipeline — exactly one when in-progress): `stage/dev` · `stage/review` · `stage/qa`

Other labels: Type: `type/feature` · `type/bug` · `type/chore` | Priority: `priority/high` · `priority/medium` · `priority/low` | Scope: `scope/backend` · `scope/frontend` · `scope/core` · `scope/db`

### Milestones

v0.1 MVP Foundation (done) → v0.2 Metadata & Library → v0.3 Automation → v0.4 Polish
