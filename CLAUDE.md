# CLAUDE.md

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Tech Stack

pnpm | Node.js 20+ | Fastify 5 | Drizzle ORM + libSQL | React 18 + Vite 6 | TanStack Query | Tailwind CSS | Docker

## Project Structure

- `src/server/` — Fastify backend (routes/, services/, jobs/, config.ts, index.ts)
- `src/client/` — React frontend (pages/, components/, lib/api/, App.tsx)
- `src/shared/` — Shared Zod schemas and registries
- `src/core/` — Indexer + download client adapters (indexers/, download-clients/, utils/)
- `src/db/` — Drizzle schema (schema.ts), client, migrations

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
- **Adapters**: Indexers and download clients implement interfaces in `src/core/*/types.ts`.
- **Routes**: Fastify route files export async functions taking app + services. Registered in `routes/index.ts`.
- **Frontend pages**: Components in `pages/`, routes in `App.tsx`, nav in `components/layout/Layout.tsx`.
- **Database**: Edit `src/db/schema.ts` → run `pnpm db:generate` → migrations auto-run on start.

## Code Style

TypeScript strict, ESM (`.js` extensions), functional React components, TanStack Query for server state, Tailwind CSS (no CSS files), `@/` path alias for client imports. Always use `return await` (not bare `return`) for async calls inside try/catch blocks — without `await`, the catch block is dead code for rejected promises.

## Logging

Uses Fastify's built-in Pino logger. Use `FastifyBaseLogger` from `fastify` for logger types — NOT `BaseLogger` from `pino` (transitive dependency, causes TS errors).

**Where to log:**
- Routes: `request.log.info(...)` / `request.log.error(error, '...')`
- Services: `this.log.info(...)` (injected `FastifyBaseLogger`)
- Jobs: `log` instance passed at initialization
- Core adapters (`src/core/`): do NOT log — throw errors or return failures; calling service logs

**Levels:** `error` (unexpected failures) · `warn` (recoverable issues) · `info` (CRUD, job lifecycle, settings) · `debug` (API payloads, intermediate state)

## Security

See `docs/SECURITY.md` for full model. Filesystem browsing is intentionally unrestricted (single-user self-hosted app). All `/api/*` routes require auth except health/status/auth endpoints. Passwords use scrypt with timing-safe comparison.

## Frontend Design Quality

Issues with `scope/frontend` must include a UI/UX design pass. Use the `frontend-design` skill before handoff. Enforced by `/implement` (proactive) and `/review-pr` (blocking finding).

## Project Management (Gitea)

All work tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Gitea CLI: `scripts/gitea.ts`. Gitea connectivity is intermittent — retry up to 3 times on ECONNREFUSED.

## Extended Documentation

Detailed standards and workflow are in `.claude/docs/`. Skills inject only the docs they need via `!`cat`` dynamic context injection — they are NOT loaded globally.

- `.claude/docs/testing.md` — Test conventions, quality standards, coverage gate, test plan completeness
- `.claude/docs/workflow.md` — Issue lifecycle, label model, workflow guardrails, milestones
- `.claude/docs/design-principles.md` — SOLID principles, co-location, extraction patterns
- `.claude/docs/architecture-checks.md` — Greppable OCP/SRP/DRY/LSP/ISP checks for specs and reviews
