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
- **Title-variant matcher tester (`POST /api/series/title-variants-debug`):** body `{ title }` → `{ input, full, variants }` — the FULL normalized form plus every tagged variant (`prefix(k)`/`suffix(k)`/`first+last`, paren-stripped axis) the series member matcher derives. The series-side counterpart to scan-debug: diagnoses a wrong **'+Add'** / missing **In Library** badge on a series card by showing what a member or book title reduces to before pairing. Caveat: the matcher's acceptance rule also consults `degenerateFull`/`lossless`, which the response does not yet expose (#2110 adds them) — for non-Latin/degenerate titles the endpoint alone can predict MATCH where production refuses. The generator is a pure function (`titleVariants` in `src/core/utils/title-variants.ts`); to test **without auth/HTTP**, call it via `pnpm exec tsx` with a small script file — the inline `tsx -e` form cannot resolve the `@core` alias on Windows.
- **Search → enrich pipeline trace:** the indexer adapters, blacklist gate, language enrichment, multi-part filter, and quality + language filters emit a per-result audit trail at `debug` level, so a single search can be replayed from the logs. Set `LOG_LEVEL=debug` (env var, applied at boot) or the General-settings log level, then grep by `title:` substring (or `guid:` / `infoHash:`) to follow one result through the pipeline. **Exception:** multi-part Usenet rejections (`reason: 'multi-part-detected'`) log at `info` — a false-positive silently makes a wanted book unobtainable on all four paths, so that one event stays visible without enabling debug.

## Drizzle schema flattening (interactive, pre-1.0)

Todd occasionally uses an interactive session to flatten the Drizzle migrations (the pipeline is unreliable at it). These mechanics stay here — *not* in learnings — because learnings are injected into the pipeline at implementation time, not into an interactive session. (Post-1.0 this stops, and these move to learnings.)

- **Co-required files:** `pnpm db:generate` emits 3 files — the SQL, `drizzle/meta/_journal.json`, and `drizzle/meta/<N>_snapshot.json`. Always `git add drizzle/`; committing only the SQL makes CI skip the migration (the journal doesn't reference it) while local tests pass (the dev DB already has the column).
- **CREATE INDEX top/bottom:** verify every `CREATE INDEX` at the top of a generated migration has a matching one at the bottom after the drop-all phase.
- **Interactive-prompt hang:** `db:generate` is non-interactive only for unambiguous diffs (pure adds/drops/new tables). Renames emit a multi-choice `select` prompt with no auto-answer flag that hangs a non-TTY run. Don't try `yes`, `echo |`, heredoc, `script`+pty, or `/dev/null` redirection. Instead: (a) **split** — stage only the drops in `schema.ts`, generate, commit; then stage the adds and re-run; or (b) **hand-write SQL** via `pnpm exec drizzle-kit generate --custom --name <slug>` with `--> statement-breakpoint` separators (also the path for data migrations).
- **The flatten recipe (done 2026-07-22 and again 2026-07-29):** delete `drizzle/*.sql` and `drizzle/meta/*_snapshot.json`, then **write an empty journal back before generating** — `{"version":"7","dialect":"sqlite","entries":[]}`. drizzle-kit does NOT create `_journal.json`; with the file absent it dies `ENOENT ... drizzle\meta\_journal.json` from `prepareOutFolder` before it reads the schema. Then `pnpm exec drizzle-kit generate --name baseline`. **Verify by named inventory, never by eyeball:** extract and `diff` the table names, index names, `CONSTRAINT "…"` names, and the `ON DELETE`/`ON UPDATE` action counts from the old files vs the new one — all four must be identical (currently 25 / 49 / 8 / 8-cascade+11-set-null). Also assert `grep -c '?' drizzle/0000_baseline.sql` is **0**: a `${}` interpolation inside a `check()` predicate compiles to a bound parameter, which is invalid in DDL. `pnpm exec vitest run src/db/` is the real proof — those suites migrate from scratch.
- **Don't cite a migration index in a comment or a learning.** The index is not stable pre-1.0 — the flatten renumbers everything, and both times it has left behind comments confidently pointing at a file that no longer exists. Name the guarantee ("the staged-import FK delete actions survive migrate-from-scratch") or the constraint (`ck_companion_ebooks_status_domain`), not `0001`.

## Windows test-fixing (interactive, capability-bound)

The pipeline runs on Linux and structurally cannot reproduce Windows-path test failures — fixing those is an interactive task on a Windows machine. `path.join()` produces backslashes on Windows, forward slashes on Linux/CI. Tests asserting on paths must normalize: `.split('\\').join('/')` on the actual value, or `expect.stringContaining()` instead of exact matches. Production code that stores paths (DB, API responses) normalizes to POSIX since the app runs in Docker.

## Settled decisions — don't re-litigate

When triaging findings, these were decided and rejected; don't re-file or re-design them (full rationale in **SECURITY.md**):

- **SSRF address-blocking is scoped to attacker-influenced URLs only.** Operator-configured destinations (indexer apiUrl, download-client host, notifier webhook, import-list source) are intentionally not address-blocked — self-hosted *arr deployments legitimately point at private-IP services. See #769 / #877 / #885.
- **Filesystem browsing is intentionally unrestricted** — single-user self-hosted; the authenticated user is the operator.
- **The connector refresh queue is best-effort and in-memory by design** — no durable/DB-backed queue (over-engineering for a single-process app; downstream media servers reconcile on their own). See #769 / #877 / #885.
- **Never spread `process.env` into spawned child processes** — use the explicit allowlist in `src/core/utils/sanitized-env.ts` so `NARRATORR_SECRET_KEY` and other secrets don't leak into user-configured notifier/post-processing scripts.
