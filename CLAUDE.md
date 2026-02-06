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
- `scripts/gitea.sh` — Gitea API helper

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

## Project Management (Gitea)

All work is tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Specs live in issue bodies — each issue is self-contained.

```bash
./scripts/gitea.sh issues           # List open issues
./scripts/gitea.sh issue <id>       # Read full spec (do this before starting work)
./scripts/gitea.sh issue-update <id> <field> <value>  # Update issue
./scripts/gitea.sh issue-comment <id> "message"       # Add comment
```

### Workflow

## When implementing a Gitea issue
Before starting work on any issue *YOU MUST* read: `docs/agent_workflow.md` and follow it exactly.

### Labels

Type: `type:feature` / `type:bug` / `type:chore` | Priority: `priority:high` / `medium` / `low` | Status: `status:backlog` / `ready` / `in-progress` / `blocked` | Scope: `scope:backend` / `frontend` / `core` / `db`

### Milestones

v0.1 MVP Foundation (done) → v0.2 Metadata & Library → v0.3 Automation → v0.4 Polish
