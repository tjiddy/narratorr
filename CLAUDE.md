# CLAUDE.md

> **Where things live.** Project conventions (code style, logging, architecture, testing) → **CONTRIBUTING.md**. The full security model (auth, SSRF, CSP, credential storage, the v1 API contract) → **SECURITY.md**. Non-obvious *implementation* traps (Zod/Drizzle/React/test patterns) → **`.workflume/learnings.md`**, surfaced to the pipeline by file/tag match. This file holds only what an **interactive** session needs that those don't cover.

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Tech Stack

pnpm | Node.js 24+ | Fastify 5 | Drizzle ORM + libSQL | React 19 + Vite 8 | TanStack Query | Tailwind CSS | Docker

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
pnpm verify        # Lint + test + typecheck + build
pnpm db:generate   # Generate Drizzle migration after schema change
pnpm typecheck     # TypeScript checking
```

## Conventions & architecture

Code style, the service/adapter/route layering, logging conventions, and the test layout live in **CONTRIBUTING.md**. The complete security model is in **SECURITY.md**. ESLint enforces the mechanical rules — `complexity ≤ 15`, `max-lines` (400/file), `max-lines-per-function` (150), `return await` in try/catch, `no-explicit-any`, `consistent-type-imports`, `narratorr/no-raw-error-logging`, `narratorr/no-tautological-expect` (on `*.test.ts(x)`), and the client/server/core/shared/services/jobs layer-import boundaries — see `eslint.config.js`.

## Debugging tools

- **Folder-name parse tester (`POST /api/library/scan-debug`):** body `{ folderName }` → the parsed `{ title, author, series, seriesPosition, asin }`, a per-step `cleanName` trace, the metadata search result, and a library duplicate check. This is the tool for diagnosing import **"No Match"** problems — it shows how a download folder name resolves *before* the metadata lookup, separating a parse failure from a provider miss. The parser is pure functions in `src/server/utils/folder-parsing.ts` (`parseFolderStructure`, `parseFolderStructureRaw`, `cleanNameWithTrace`) with patterns in `folder-parsing-patterns.ts`; to test a name **without auth/HTTP**, import and call them directly via `pnpm exec tsx`.
- **Search → enrich pipeline trace:** the indexer adapters, blacklist gate, language enrichment, multi-part filter, and quality + language filters emit a per-result audit trail at `debug` level, so a single search can be replayed from the logs. Set `LOG_LEVEL=debug` (env var, applied at boot) or the General-settings log level, then grep by `title:` substring (or `guid:` / `infoHash:`) to follow one result through the pipeline.

## Drizzle schema flattening (interactive, pre-1.0)

Todd occasionally uses an interactive session to flatten the Drizzle migrations (the pipeline is unreliable at it). These mechanics stay here — *not* in learnings — because learnings are injected into the pipeline at implementation time, not into an interactive session. (Post-1.0 this stops, and these move to learnings.)

- **Co-required files:** `pnpm db:generate` emits 3 files — the SQL, `drizzle/meta/_journal.json`, and `drizzle/meta/<N>_snapshot.json`. Always `git add drizzle/`; committing only the SQL makes CI skip the migration (the journal doesn't reference it) while local tests pass (the dev DB already has the column).
- **CREATE INDEX top/bottom:** verify every `CREATE INDEX` at the top of a generated migration has a matching one at the bottom after the drop-all phase.
- **Interactive-prompt hang:** `db:generate` is non-interactive only for unambiguous diffs (pure adds/drops/new tables). Renames emit a multi-choice `select` prompt with no auto-answer flag that hangs a non-TTY run. Don't try `yes`, `echo |`, heredoc, `script`+pty, or `/dev/null` redirection. Instead: (a) **split** — stage only the drops in `schema.ts`, generate, commit; then stage the adds and re-run; or (b) **hand-write SQL** via `pnpm exec drizzle-kit generate --custom --name <slug>` with `--> statement-breakpoint` separators (also the path for data migrations).

## Windows test-fixing (interactive, capability-bound)

The pipeline runs on Linux and structurally cannot reproduce Windows-path test failures — fixing those is an interactive task on a Windows machine. `path.join()` produces backslashes on Windows, forward slashes on Linux/CI. Tests asserting on paths must normalize: `.split('\\').join('/')` on the actual value, or `expect.stringContaining()` instead of exact matches. Production code that stores paths (DB, API responses) normalizes to POSIX since the app runs in Docker.

## Settled decisions — don't re-litigate

When triaging findings, these were decided and rejected; don't re-file or re-design them (full rationale in **SECURITY.md**):

- **SSRF address-blocking is scoped to attacker-influenced URLs only.** Operator-configured destinations (indexer apiUrl, download-client host, notifier webhook, import-list source) are intentionally not address-blocked — self-hosted *arr deployments legitimately point at private-IP services. See #769 / #877 / #885.
- **Filesystem browsing is intentionally unrestricted** — single-user self-hosted; the authenticated user is the operator.
- **The connector refresh queue is best-effort and in-memory by design** — no durable/DB-backed queue (over-engineering for a single-process app; downstream media servers reconcile on their own). See #769 / #877 / #885.
- **Never spread `process.env` into spawned child processes** — use the explicit allowlist in `src/core/utils/sanitized-env.ts` so `NARRATORR_SECRET_KEY` and other secrets don't leak into user-configured notifier/post-processing scripts.
