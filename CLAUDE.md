# CLAUDE.md

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Tech Stack

pnpm | Node.js 22+ | Fastify 5 | Drizzle ORM + libSQL | React 18 + Vite 6 | TanStack Query | Tailwind CSS | Docker

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

TypeScript strict, ESM (`.js` extensions), functional React components, TanStack Query for server state, Tailwind CSS (no CSS files), `@/` path alias for client imports. Always use `return await` (not bare `return`) for async calls inside try/catch blocks — without `await`, the catch block is dead code for rejected promises. Non-submit `<button>` elements inside `<form>` must have `type="button"` — without it, the browser default is `type="submit"`, which triggers form submission on click. API client methods in `src/client/lib/api/` must use domain-prefixed names (e.g., `getSystemStatus` not `getStatus`) to prevent silent overwrites in the barrel export spread.

## Logging

Uses Fastify's built-in Pino logger. Use `FastifyBaseLogger` from `fastify` for logger types — NOT `BaseLogger` from `pino` (transitive dependency, causes TS errors).

**Where to log:**
- Routes: `request.log.info(...)` / `request.log.error(error, '...')`
- Services: `this.log.info(...)` (injected `FastifyBaseLogger`)
- Jobs: `log` instance passed at initialization
- Core adapters (`src/core/`): do NOT log — throw errors or return failures; calling service logs

**Levels:** `error` (unexpected failures) · `warn` (recoverable issues) · `info` (CRUD, job lifecycle, settings) · `debug` (API payloads, intermediate state)

## Security

See `docs/SECURITY.md` for full model. Filesystem browsing is intentionally unrestricted (single-user self-hosted app). All `/api/*` routes require auth except health/status/auth endpoints. Passwords use scrypt with timing-safe comparison. Never use `startsWith()` for path ancestry checks — use `path.relative()` and verify the result doesn't start with `..`. Redact credentials from proxy URLs before logging. Normalize sentinel values *before* comparison, not after. Allow sentinel passthrough at schema level for validated secret fields.

## Gotchas

Graduated learnings from the CL system — non-obvious patterns that have caused bugs:

- **SQLite NULL uniqueness:** NULL ≠ NULL in unique indexes — nullable columns don't prevent duplicates. Ensure populated before insert.
- **SQLite 999 bind limit:** Account for ALL bound params in WHERE when chunking `IN(...)` queries, not just the list.
- **Drizzle migrations:** Verify every CREATE INDEX at the top has a matching one at the bottom after the drop-all phase.
- **Drizzle `$inferSelect` widens enums:** Use actual Zod enum schemas, not `z.string()`, at Drizzle-to-Zod boundaries.
- **`rename()` is atomic:** Don't `unlink()` before `rename()` — creates a data-loss window. Just rename over the target.
- **`mkdir` for moves:** Use `mkdir(dirname(toPath))` not `mkdir(toPath)` for directory moves.
- **Shallow clone trap:** `{ ...obj }` shares nested refs. Use `JSON.parse(JSON.stringify(...))` for full isolation in factories.
- **Zod `.default()` ignores empty strings:** Use `.transform(v => v || default)` to coalesce empty strings.
- **`lte` vs `lt` for retention:** "Older than N days" means `lt` (strictly less-than), not `lte`.
- **SSE high-frequency updates:** Use `setQueryData()` to patch rows in-place, not `invalidateQueries()`.
- **Module-level mutable state:** Use `useSyncExternalStore` with subscribe/notify, not bare `let` variables.
- **Derived state over copied state:** `override ?? queryDefault ?? fallback` eliminates race conditions vs copying async query data into useState.
- **SPA fallback scope:** Reject requests whose path doesn't start with URL_BASE before serving index.html.
- **Git executable bit on Windows:** Use `git update-index --chmod=+x` for shell scripts.
- **Variable-length parsing:** Check most specific format first (6-part cron before 5-part).
- **Stable keys:** Use field-based keys only; append index suffixes only at collision points via a dedup helper.
- **FK restoration:** When restoring records, find-or-create related FK records, not just primary scalars.
- **DB update timing:** Update the database immediately after the first irreversible filesystem step, not at end.
- **Streaming parser errors:** Map to 4xx by checking error messages for format/validation failures, not blanket 500.
- **Case-insensitive filters:** Deduplicate dropdown options case-insensitively (Map keyed by lowercase).

## Frontend Design Quality

Issues with `scope/frontend` must include a UI/UX design pass. Use the `frontend-design` skill before handoff. Enforced by `/implement` (proactive) and `/review-pr` (blocking finding).

## Workflow Scripts

Mechanical workflow steps live in `scripts/` as deterministic Node scripts (not LLM-powered). Skills call these directly:

| Script | What it does | Output |
|--------|-------------|--------|
| `scripts/verify.ts` | lint → test+coverage → typecheck → build | `VERIFY: pass/fail` |
| `scripts/claim.ts <id>` | Validate status, create branch, update labels | `CLAIMED:/ERROR:` |
| `scripts/merge.ts <pr>` | Validate approval, CI, squash merge, close issue | `MERGED:/ERROR:` |
| `scripts/block.ts <id> "<reason>"` | Post blocker comment, update labels | `BLOCKED:` |
| `scripts/resume.ts <id>` | Restore branch, collect context | Branch + context |
| `scripts/changelog.ts [since]` | Categorized changelog from git + Gitea | Markdown |
| `scripts/lib.ts` | Shared helpers (gitea, git, label parsing) | — |

## Project Management (Gitea)

All work tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Gitea CLI: `scripts/gitea.ts`. Gitea connectivity is intermittent — retry up to 3 times on ECONNREFUSED.

## Codebase Knowledge Graph (MCP)

Project is indexed via `codebase-memory-mcp` with auto-sync (graph stays fresh as files change). Prefer graph tools over Explore subagents for structural queries — use grep/glob for text pattern matching.

- **`trace_call_path`** — "what calls X?" / "what does X call?" (blast radius, dependency chains)
- **`detect_changes`** — map git diff to affected symbols with risk classification (`scope='branch'` for PR review)
- **`search_graph`** — find functions/classes/modules by name with degree filtering (dead code, fan-out)

## Extended Documentation

Detailed standards and workflow are in `.claude/docs/`. Skills inject only the docs they need via `!`cat`` dynamic context injection — they are NOT loaded globally.

- `.claude/docs/testing.md` — Test conventions, quality standards, coverage gate, test plan completeness
- `.claude/docs/workflow.md` — Issue lifecycle, label model, workflow guardrails, milestones
- `.claude/docs/design-principles.md` — SOLID principles, co-location, extraction patterns
- `.claude/docs/architecture-checks.md` — Greppable OCP/SRP/DRY/LSP/ISP checks for specs and reviews
