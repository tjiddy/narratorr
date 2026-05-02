# CLAUDE.md

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

## Architecture

- **Services**: Business logic classes in `services/`, instantiated in `routes/index.ts`. See existing services for pattern.
- **Adapters**: Indexers and download clients implement interfaces in `src/core/*/types.ts`.
- **Routes**: Fastify route files export async functions taking app + services. Registered in `routes/index.ts`.
- **Frontend pages**: Components in `pages/`, routes in `App.tsx`, nav in `components/layout/Layout.tsx`.
- **Database**: Edit `src/db/schema.ts` → run `pnpm db:generate` → migrations auto-run on start.

## Code Style

TypeScript strict, ESM (`.js` extensions), functional React components, TanStack Query for server state, Tailwind CSS (no CSS files), `@/` path alias for client imports. ESLint enforces cyclomatic complexity ≤ 15 — extract helpers or use lookup maps to stay under. Always use `return await` (not bare `return`) for async calls inside try/catch blocks — without `await`, the catch block is dead code for rejected promises. Non-submit `<button>` elements inside `<form>` must have `type="button"` — without it, the browser default is `type="submit"`, which triggers form submission on click. API client methods in `src/client/lib/api/` must use domain-prefixed names (e.g., `getSystemStatus` not `getStatus`) to prevent silent overwrites in the barrel export spread.

## Logging

Uses Fastify's built-in Pino logger. Use `FastifyBaseLogger` from `fastify` for logger types — NOT `BaseLogger` from `pino` (transitive dependency, causes TS errors).

**Where to log:**
- Routes: `request.log.info(...)` / `request.log.error(error, '...')`
- Services: `this.log.info(...)` (injected `FastifyBaseLogger`)
- Jobs: `log` instance passed at initialization
- Core adapters (`src/core/`): do NOT log — throw errors or return failures; calling service logs

**Levels:** `error` (unexpected failures) · `warn` (recoverable issues) · `info` (CRUD, job lifecycle, settings) · `debug` (API payloads, intermediate state)

**Logging errors:** Always wrap `unknown` catch values with `serializeError()` from `src/server/utils/serialize-error.js` before passing to Pino — raw `unknown` values serialize to `{}` in JSON logs. The `narratorr/no-raw-error-logging` ESLint rule enforces this.

## Security

See `SECURITY.md` for full model. Filesystem browsing is intentionally unrestricted (single-user self-hosted app). All `/api/*` routes require auth except health/status/auth endpoints. Passwords use scrypt with timing-safe comparison; API-key validation hashes both sides and uses fixed-length `timingSafeEqual` (no early length-mismatch return — that would leak length via timing). Never use `startsWith()` for path ancestry checks — use `path.relative()` and verify the result doesn't start with `..`. Redact credentials from proxy URLs before logging. Normalize sentinel values *before* comparison, not after. Allow sentinel passthrough at schema level for validated secret fields. Outbound fetches to attacker-influenced URLs (cover art, indexer-supplied links) must go through the SSRF helpers in `src/core/utils/network-service.ts` — see `cover-download.ts` for the dual-resolution + Undici-lookup pattern that prevents SSRF and DNS rebinding. Whenever a fetch attaches a `dispatcher`, use `undiciFetch` from the same module (Node 24 + undici 8 reject mismatched Dispatcher class identities with `UND_ERR_INVALID_ARG`). **SSRF address-blocking is intentionally scoped to attacker-influenced URLs only** — operator-configured fetch destinations (indexer apiUrl, download-client host, notifier webhook, import-list source) are not address-blocked by design, because self-hosted *arr deployments legitimately point at private-IP services (Prowlarr in Docker compose, qBittorrent on LAN, self-hosted Apprise). Do not file findings to "extend SSRF blocking to all outbound fetches" — that decision was made and rejected, see #769/#877/#885. Never spread `process.env` into spawned child processes — use the explicit allowlist in `src/core/utils/sanitized-env.ts` so `NARRATORR_SECRET_KEY` and other secrets don't leak into user-configured scripts.

## Gotchas

Non-obvious patterns that have caused bugs:

- **SQLite NULL uniqueness:** NULL ≠ NULL in unique indexes — nullable columns don't prevent duplicates. Ensure populated before insert.
- **SQLite 999 bind limit:** Account for ALL bound params in WHERE when chunking `IN(...)` queries, not just the list.
- **Drizzle migrations:** Verify every CREATE INDEX at the top has a matching one at the bottom after the drop-all phase.
- **Drizzle migration commits:** `pnpm db:generate` produces 3 co-required files: the SQL file, `drizzle/meta/_journal.json`, and `drizzle/meta/<N>_snapshot.json`. Always `git add drizzle/` — committing only the SQL file causes CI to skip the migration (journal doesn't reference it), while local tests pass because the DB already has the column.
- **Drizzle `$inferSelect` widens enums:** Use actual Zod enum schemas, not `z.string()`, at Drizzle-to-Zod boundaries. For the `books` row shape specifically, import the canonical narrowed `BookRow` from `src/server/services/types.ts` — do NOT redeclare `type BookRow = typeof books.$inferSelect` per-file (the bare alias re-widens `status` / `enrichmentStatus` to `string`).
- **`rename()` is atomic:** Don't `unlink()` before `rename()` — creates a data-loss window. Just rename over the target.
- **`mkdir` for moves:** Use `mkdir(dirname(toPath))` not `mkdir(toPath)` for directory moves.
- **Shallow clone trap:** `{ ...obj }` shares nested refs. Use `JSON.parse(JSON.stringify(...))` for full isolation in factories.
- **Zod `.default()` ignores empty strings:** Use `.transform(v => v || default)` to coalesce empty strings.
- **`lte` vs `lt` for retention:** "Older than N days" means `lt` (strictly less-than), not `lte`.
- **SSE high-frequency updates:** Use `setQueryData()` to patch rows in-place, not `invalidateQueries()`.
- **Module-level mutable state:** Use `useSyncExternalStore` with subscribe/notify, not bare `let` variables.
- **Derived state over copied state:** `override ?? queryDefault ?? fallback` eliminates race conditions vs copying async query data into useState.
- **SPA fallback scope:** Reject requests whose path doesn't start with URL_BASE before serving index.html.
- **Windows path separators in tests:** `path.join()` produces backslashes on Windows but forward slashes on Linux (CI). Tests asserting on paths must normalize: use `.split('\\').join('/')` on actual values, or use `expect.stringContaining()` instead of exact path matches. Production code that stores paths (DB, API responses) should normalize to POSIX separators since the app runs in Docker.
- **Git executable bit on Windows:** Use `git update-index --chmod=+x` for shell scripts.
- **Variable-length parsing:** Check most specific format first (6-part cron before 5-part).
- **Stable keys:** Use field-based keys only; append index suffixes only at collision points via a dedup helper.
- **FK restoration:** When restoring records, find-or-create related FK records, not just primary scalars.
- **DB update timing:** Update the database immediately after the first irreversible filesystem step, not at end.
- **Streaming parser errors:** Map to 4xx by checking error messages for format/validation failures, not blanket 500.
- **Case-insensitive filters:** Deduplicate dropdown options case-insensitively (Map keyed by lowercase).
- **CSP nonce kills unsafe-inline:** Never combine `'nonce-'` and `'unsafe-inline'` in the same CSP directive — per CSP Level 2, a nonce's presence silently disables `unsafe-inline`. Use a Fastify `onSend` hook to strip the nonce from `style-src` after helmet injects it, preserving the nonce only in `script-src`.
- **`backdrop-filter` creates stacking context:** Elements with `backdrop-filter` (e.g., glass-card containers) trap z-index of descendants. Portals for dropdowns/modals must attach to `<body>`, not the nearest parent.
- **Zod `.min(1)` allows whitespace:** Use `.trim().min(1)` for user-facing text fields — bare `.min(1)` accepts `'   '` (spaces-only).
- **`vi.useFakeTimers()` breaks TanStack Query:** Full `useFakeTimers()` deadlocks Query's internal `setTimeout`. Use `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` and explicit `vi.advanceTimersByTime()` in tests that mix polling hooks with Query.
- **TanStack Query optimistic updates:** Call `cancelQueries` before `setQueryData` — without cancel, a pending refetch can overwrite the optimistic data. For paginated queries, use `placeholderData: (prev) => prev` to prevent flicker during page transitions.
- **Fire-and-forget pre-flight:** When a service method creates a background job (`.start()`), pre-flight checks MUST happen before job creation — not inside the async work function. Throws inside async work are unreachable by the caller (route already returned 202). Make the method `async` and validate synchronously before creating the job.
- **Bitrate unit boundary (bps vs kbps):** `music-metadata` returns bitrate in bps (128000), settings/schemas use kbps (128), DB stores bps. Always convert at the call site with `Math.floor(bps / 1000)` — never compare raw values across boundaries.
- **Drizzle enum type derivation:** Drizzle inline `text('col', { enum: [...] })` produces narrow literal unions in `$inferInsert`. Derive shared types from the schema (`NonNullable<typeof table.$inferInsert['col']>`) instead of using bare `string`.
- **Zod + zodResolver type divergence:** `z.preprocess()`, `z.transform()`, and `z.default()` create ZodEffects where input ≠ output type. `zodResolver` requires aligned types. Fix: omit `.default()` in form schemas (forms always have explicit `defaultValues`), use `setValueAs` in `register()` for coercion instead of `z.preprocess()`. See `stripDefaults()` for removing defaults from server schemas before form use.
- **Settings dual default path:** New settings fields need TWO places: Zod schema `.default()` AND `settingsRegistry.*.defaults` / `DEFAULT_SETTINGS` in `registry.ts`. Runtime uses `DEFAULT_SETTINGS` (not Zod parsing), so adding only to the schema leaves runtime and mock factories missing the field.
- **Form `settingsFromX` helpers must use the registry overlay, not hardcoded unions.** When deriving form state from a stored entity, spread `<ENTITY>_REGISTRY[entity.type].defaultSettings` and **overlay non-null stored values** — never enumerate every possible field across every adapter type. Strict per-type schemas (`.strict()`) reject foreign-type fields with `Unrecognized keys` 400. The overlay (not defaults alone) is what preserves valid non-default keys actually persisted by the UI (e.g., MAM's `isVip`/`classname`). Component tests for entity edit forms must assert the `onFormTest` payload's `settings` contains no foreign keys for the selected type — not just that the callback fired.
