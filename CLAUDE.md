# CLAUDE.md

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Tech Stack

Monorepo (Turborepo + pnpm) | Node.js 20+ | Fastify 5 | Drizzle ORM + libSQL | React 18 + Vite 6 | TanStack Query | Tailwind CSS | Docker

## Project Structure

- `apps/narratorr/src/server/` — Fastify backend (routes/, services/, jobs/, config.ts, index.ts)
- `apps/narratorr/src/client/` — React frontend (pages/, components/, lib/api/, App.tsx)
- `apps/narratorr/src/shared/schemas.ts` — Shared Zod schemas
- `packages/core/src/` — Indexer + download client adapters (indexers/, download-clients/, utils/)
- `packages/db/src/` — Drizzle schema (schema.ts), client, migrations
- `packages/ui/` — Shared UI utilities (cn())

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

## Design Principles

- **Single responsibility.** Each file, component, and service should have one reason to change. If modifying indexer settings requires editing the same file as download client settings, that's an SRP violation — split them. A long file that does one thing well is fine; a short file that mixes concerns is not.
- **Don't repeat yourself.** If three CRUD sections share identical mutation/query/toast patterns, extract a shared hook or component. Duplication is a stronger signal than file length.
- **Open for extension, closed for modification.** Adding a new feature (adapter, settings section, notifier type) should mean creating new files, not modifying a growing list in existing ones. If wiring a feature requires touching 4+ existing files, the architecture needs a registry/plugin pattern.
- **Co-locate what changes together.** Types live alongside their API methods. Components live with their hooks. Tests live next to their source. Barrel `index.ts` at module boundaries, direct imports within.
- **Extract components and hooks, not just functions.** When a component grows a second concern, extract it to its own file — don't just extract a helper function within the same file. React components and hooks are the unit of reuse.

## Frontend Design Quality

All issues with `scope/frontend` must include a UI/UX design pass during implementation. New or significantly changed UI components should be refined using the `frontend-design` skill before handoff. The goal is production-grade polish — not just functional markup. This is enforced at two points:
- `/implement` runs the design pass proactively after quality gates pass
- `/review` checks that frontend components meet the app's design standard and flags unpolished UI as a blocking finding

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

All work is tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Specs live in issue bodies — each issue is self-contained. The Gitea CLI is provided by the `gitea-workflow` plugin — use `/gitea-workflow:issue <id>`, `/gitea-workflow:issues`, etc.

### Workflow Skills

Claude Code skills automate the agent workflow — use these instead of manual steps:

- `/implement <id>` — Full lifecycle: elaborate → claim → implement → handoff (preferred for end-to-end work)
- `/claim <id>` — Validate spec (via subagent) + claim issue (use when implementing manually)
- `/handoff <id>` — Verify, push, create PR, post handoff comment, update context cache
- `/block <id>` — Post blocked comment, set blocked label, stop
- `/elaborate <id>` — Groom/triage an issue without claiming (read-only, structured verdict)
- `/verify` — Run quality gates (lint, test, typecheck, build) with structured summary
- `/review <pr>` — Review a PR against its linked issue's acceptance criteria; auto-merges on approve, stops on needs-work
- `/respond-to-review <pr>` — Address review findings: fix, accept, defer, or dispute each finding, push fixes, post structured response
- `/merge <pr>` — Merge an approved PR (checks verdict, quality gates, updates issue labels, cleans up branch)
- `/triage` — Rank and categorize all open issues (read-only)
- `/resume <id>` — Resume a blocked issue (restore branch, update labels)
- `/changelog [since]` — Generate categorized changelog from git history

## ⚠ Issue Workflow — MANDATORY

**Every task referencing a Gitea issue (#N) MUST follow this lifecycle — no exceptions.**
A detailed plan, pre-made spec, or explicit implementation instructions do NOT bypass these steps.

**Full auto (preferred):**
1. `/implement <id>` — validates, claims, implements, and hands off in one pass

**Manual control:**
1. **Before writing any code** → `/claim <id>` (validates spec, explores codebase, claims if ready)
2. **Implement** — follow the plan from the claim phase
3. **After tests/typecheck/build pass** → `/handoff <id>` (pushes, creates PR, comments, updates labels, appends workflow log)

**PR review cycle:**
1. `/review <pr>` — reviewer posts structured findings with verdict
2. `/respond-to-review <pr>` — author addresses each finding (fix/accept/defer/dispute), pushes, posts response
3. `/review <pr>` — re-review after fixes (repeat until approved)
4. `/merge <pr>` — squash merge once verdict is `approve`

**Standalone tools:**
- `/elaborate <id>` — groom/triage without claiming (no side effects)
- `/block <id>` — mark blocked and stop (at any point)

Skipping `/claim` means no validation, no branch, no tracking, no audit trail.
Skipping `/handoff` means no PR, no label update, no workflow log entry.

### Labels (2-axis model)

Labels use `/` separators. Two exclusive groups track workflow state:

- **Status** (lifecycle — exactly one): `status/backlog` · `status/ready` · `status/in-progress` · `status/blocked` · `status/done`
- **Stage** (pipeline — exactly one when in-progress): `stage/dev` · `stage/review` · `stage/qa`

Other labels: Type: `type/feature` · `type/bug` · `type/chore` | Priority: `priority/high` · `priority/medium` · `priority/low` | Scope: `scope/backend` · `scope/frontend` · `scope/core` · `scope/db`

### Milestones

v0.1 MVP Foundation (done) → v0.2 Metadata & Library → v0.3 Automation → v0.4 Polish
