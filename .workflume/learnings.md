## sse-inject-helper-gap

**source:** #755
**added:** 2026-05-04
**files:** src/server/__tests__/search-grab-flow.e2e.test.ts, src/server/__tests__/sse-helpers.ts
**tags:** testing, sse, fastify, e2e, test-harness

---

Fastify's `app.inject()` cannot exercise SSE/streaming routes because Fastify hijacks the response on those handlers — the injection API never sees the streamed body. When migrating E2E tests from a non-streaming endpoint to an SSE replacement, the available workarounds are (a) call the underlying service method directly (preserves MSW/mocking assertions but bypasses the route handler) or (b) bind a real ephemeral port and parse the SSE event stream from a real HTTP client.

Observed in `src/server/__tests__/e2e-helpers.ts` during the #755 migration: three tests originally hit `GET /api/search?q=...` via `app.inject()` and were ported to call `e2e.services.indexer.searchAll()` directly against `/api/search/stream`. The route-layer coverage was lost as a tradeoff. See the explanatory comment in `src/server/__tests__/search-grab-flow.e2e.test.ts` (where `GET /api/search` is noted as retired in favor of the SSE surface, and the indexer service is exercised directly so the MSW capture still verifies the outgoing query params); `src/server/__tests__/sse-helpers.ts` documents why `app.inject()` hangs on `reply.hijack()` routes.

If future work needs true end-to-end SSE coverage in this harness, add a `searchViaStream(e2e, query)` helper that spins up the app on a free port, opens a streaming HTTP request, and accumulates SSE `data:` frames into a result array. Until that helper exists, prefer the direct-service-call pattern for SSE route tests and document the bypass in the test.

## edit-mode-id-injection-on-form-test

**source:** #827
**added:** 2026-05-04
**tags:** forms, settings, react, secrets, dry

---

When a settings form runs a server-side test (`onFormTest`) while editing an existing entity, it must spread the entity id alongside the form data: `{ ...data, id: entity.id }`. The server uses that id to resolve sentinel placeholders for secret fields the client never sees in plaintext. Without it, the test runs against a partial payload and the server can't reconstruct the real credentials.

Three forms currently follow this pattern by hand: `IndexerCard`, `NotifierCard`, and `DownloadClientForm`. Each carries the same explanatory comment. If a fourth edit form is added, prefer one of:

1. Lifting the injection into `useConnectionTest` / `useCrudSettings` by accepting an optional `entityId` and merging it inside `handleFormTest`. Consumers then stop having to remember.
2. If keeping it inline, copy the comment verbatim so the intent stays discoverable.

Known exception: the import-list form does NOT need this — it routes through a saved-id test endpoint instead of the generic test-with-payload endpoint. Don't 'normalize' it into the spread pattern; that would break it. Originally surfaced in #827.

## ts-diagnostic-offsets-for-codemods

**source:** #940
**added:** 2026-05-04
**tags:** typescript, codemod, compiler-api, strict-flags, nuia

---

**Pattern:** When building codemods that respond to TypeScript strict-flag diagnostics (noUncheckedIndexedAccess, strictNullChecks, exactOptionalPropertyTypes, etc.), drive insertions from `ts.Diagnostic.start` and `ts.Diagnostic.length` via `ts.createProgram` + `ts.getPreEmitDiagnostics`. Do NOT parse `tsc --pretty false` line/col text.

**Why:** The compiler's text output anchors to the start of the outermost expression. For a `PropertyAccessExpression` chain like `a.b.c.d` where `c` is `T | undefined`, line/col points at `a` even though the `!` belongs after `c`. Inferring the node span from source text works for plain `arr[0]` access but silently produces wrong fixes on chains — and the codemod will appear to succeed.

**Canonical recipe:**
```ts
const program = ts.createProgram({ rootNames, options });
for (const d of ts.getPreEmitDiagnostics(program)) {
  if (!d.file || d.start == null || d.length == null) continue;
  const insertAt = d.start + d.length; // exact end of the offending node
  // apply ! or ?? fallback at insertAt
}
```

**Known exceptions:** None for nuia/strictness sweeps. If you genuinely only have textual compiler output (e.g. consuming a CI artifact), you must re-resolve the node via the AST before inserting — never trust the column for chained access.

**References:** Discovered during issue #940. See the `ts6-walk` skill for the structured per-site decision format used in these sweeps.

## fixture-builder-eopt-overrides

**source:** #938
**added:** 2026-05-04
**tags:** typescript, exactoptionalpropertytypes, fixture-builders, test-helpers, eopt

---

Fixture builders that accept `Partial<T>` and rely on callers passing `{ key: undefined }` to strip default fields break under `exactOptionalPropertyTypes` (eopt). TypeScript rejects object literals containing explicit `undefined` for optional properties when eopt is enabled.

Three viable patterns when you encounter or write such a builder:

1. **Destructure-and-omit at the call site** — instead of `makeResult({ score: undefined })`, build the override object without the key. Works but pushes complexity to every caller.
2. **Custom overrides type on the builder** — type the parameter as `{ [K in keyof T]?: T[K] | undefined }` instead of `Partial<T>`. Allows explicit `undefined` literals; localizes the workaround to the builder definition.
3. **Explicit-undefined-stripping helper** — a shared utility that accepts overrides including `undefined` and applies them with key deletion semantics.

First observed in `src/server/services/search-pipeline.test.ts` (`makeResult`) during #938. Before widening this pattern across production fixtures (Phase 2 of the eopt migration), the codebase should standardize on one approach. Option 2 (custom mapped type) is generally the lowest-friction choice because it keeps call sites idiomatic, but a centralized helper is preferable if many builders share the same shape.

When reviewing or adding a fixture builder under eopt: check whether callers need to strip defaults; if so, do not use bare `Partial<T>` for the overrides parameter.

## lookup-callback-dual-shape

**source:** #966
**added:** 2026-05-04
**tags:** undici, dns, node, callback-shape, network

---

Custom `LookupFunction` implementations (e.g. `validatingLookup` in `src/core/utils/network-service.ts`) MUST support both callback shapes:

- Single-form: `(err, address, family)` — used by legacy paths
- Array-form: `(err, addresses[])` — used when the caller passes `{ all: true }`

**Why:** Node 24 + undici 8's `net.connect` dispatcher calls `connect.lookup` with `{ all: true }` and expects the array-form callback (verified at `node:net:1554`, `lookupAndConnectMultiple`). A lookup function that only implements the single-form will throw `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` when invoked from this path, even though it works fine for older callers.

**Pattern:** Branch on the `options.all` flag passed to the lookup function and invoke the callback with the matching shape. Reference implementation: see the `successBehavior` helper in `cover-download.e2e.test.ts:62`, which exercises both forms.

**When this applies:** Any time you add or modify a custom DNS lookup hook used by HTTP/socket clients in this codebase. If you only test one path, the other will silently break.

## fastify-max-param-length-100-default

**source:** #1017
**added:** 2026-05-07
**files:** src/server/index.ts
**tags:** fastify, routing, path-params, tokens

---

Fastify 5 defaults `routerOptions.maxParamLength` to 100 chars per dynamic path parameter. Anything longer (signed capability tokens, base64url payloads, content hashes, JWT-shaped strings) silently fails to match the route — Fastify returns a generic 404 'Route not found' from its not-found handler, with no warning, no log, and no validation error. The handler is never invoked; throws and console.logs inside it do not fire.

**Pattern:** When introducing a route that takes variable-length encoded data in a path parameter, bump the cap on the Fastify constructor: `Fastify({ routerOptions: { maxParamLength: 2048 } })` (or whatever the real upper bound is). Mirror the change in any test-app constructor (`src/server/__tests__/helpers.ts:createTestApp` and per-test ad-hoc instances) — the cap is per-instance, not a runtime config.

**Why this is non-obvious:** the 404 looks like a routing bug. Common debugging instincts (add a log to the handler, throw inside the handler, check Zod validation, check the type provider) all return the same 404 because the request never reaches the handler. The fix is not in your code — it's in the constructor option.

**The deprecated form:** `Fastify({ maxParamLength: 2048 })` at the top level still works in Fastify 5 but emits FSTDEP022 and is removed in Fastify 6. Always use `routerOptions.maxParamLength`.

**Where to keep this in mind:** any feature that encodes data into the URL path — signed tokens, hashes, encoded ids, capability strings. Reference: `src/server/index.ts` and `src/server/__tests__/helpers.ts` after #1017.

## drizzle-migration-prompt-hang

**source:** #1133
**added:** 2026-05-18
**files:** drizzle/, src/db/schema.ts
**tags:** drizzle, migrations, db, automation, watchdog, agent-dispatch

---

`pnpm db:generate` (which runs `drizzle-kit generate`) is non-interactive ONLY when the schema diff is unambiguous — pure adds, pure drops, or new tables. For ambiguous diffs (column renames, table renames, or anything Drizzle's heuristic treats as rename-vs-drop+add), drizzle-kit emits a multi-choice `select` prompt asking the operator to disambiguate (e.g. "did you rename column X to Y, or drop X and add Y?"). It reads from `process.stdin`. There is no `--yes` or `--default` flag that auto-answers it.

In a non-TTY context — every agent dispatch, every CI run — the prompt hangs the subprocess waiting for input that will never arrive. The workflume executor's inactivity watchdog SIGTERMs the run after 15 minutes of stdout silence, and the entire in-flight implementation (including unrelated work the agent did before generating the migration) is lost. The dispatch then comes back as a `Schema validation failed: LLM subprocess exited 143 with no extractable payload` block, which makes it look like a payload-extraction bug instead of a migration-step hang.

**Workarounds that DO NOT work** — verified hung in #1133:

- `script -qe -c "pnpm db:generate" /dev/null < <(yes "y")` — Drizzle's prompt is `select`, not y/n; `yes` output is not a valid choice and the prompt waits forever
- `echo "y" | pnpm db:generate` — same issue
- `pnpm db:generate < /dev/null` — Drizzle reads stdin and either crashes or hangs
- Any other TTY-emulation, heredoc, or stdin-redirection trick

**Correct approaches** — verified in #1103 and #1129:

1. **Split the migration into two non-ambiguous runs** (preferred when you can):
   - Stage only the drops in `src/db/schema.ts`, run `pnpm db:generate`, commit
   - Stage the adds, run `pnpm db:generate` again, commit
   - Each run sees an unambiguous diff and skips the prompt

2. **Scaffold an empty migration and write SQL by hand** (use when the schema rewrite is structural):
   ```
   pnpm exec drizzle-kit generate --custom --name <descriptive_slug>
   ```
   This bypasses the diff engine entirely. Replace the generated placeholder (`-- Custom SQL migration file, put your code below!`) with the SQL DDL you want, using `--> statement-breakpoint` separators between statements. In `--custom` mode the `--name` flag is required because there's no schema delta to auto-derive a filename from.

For data migrations (UPDATE/DELETE that go beyond pure DDL), use the `--custom` path and hand-write the statements. Drizzle does not generate non-DDL operations from schema diffs.

After either path, commit the whole `drizzle/` folder — the SQL file plus `meta/_journal.json` plus `meta/<N>_snapshot.json` are co-required (CI re-runs migrations from scratch; committing only the SQL file silently skips the run there but passes locally because the dev DB already has the schema). See the existing `Drizzle migration commits` gotcha in CLAUDE.md.

**How to recognize this in a stuck dispatch:** the agent's last tool call will be a Bash invocation containing `db:generate` and some TTY workaround (`script`, `yes`, redirection). Stdout from then on will be silent or contain only the `script` wrapper's noise. The subprocess exits ~15+ minutes later with code 143. The agent never gets a chance to emit the WORKFLUME_PAYLOAD block, so the failure looks like a parser bug at the workflume layer — it isn't.

## compat-surface-zod-strip-not-strict

**source:** #1198
**added:** 2026-06-01
**files:** src/server/routes/prowlarr-compat.ts, src/server/utils/readarr-echo-fields.ts
**tags:** zod, prowlarr-compat, api-impersonation, request-validation

---

Request-body schemas for API-impersonation/compatibility surfaces (narratorr's Prowlarr/Readarr-compat routes in src/server/routes/prowlarr-compat.ts) must use Zod's default `.strip()` (i.e. NOT `.strict()`), and must additionally strip the impersonated product's echo-only fields out of any service-facing `settings` they translate to. Rationale: the impersonated product controls the payload and adds fields over time; `.strict()` 400s on every unanticipated field and breaks the integration, while `.strip()` silently drops unknown top-level keys before handler code runs (handlers read only named fields → no mass-assignment risk). `.passthrough()` is wrong — it carries attacker-controllable keys forward. Do NOT 'fix' a break by allowlisting the specific new field into the schema — that is whack-a-mole and has already regressed this exact surface twice (#733 introduced `.strict()`; an earlier `enableAutomaticSearch`/`enableInteractiveSearch` break was bandaged by allowlist; #1198 broke again on Prowlarr's `categories`/`minimumSeeders`/`seedCriteria.*`). Echo-only fields must also be filtered before they reach the strict per-adapter settings schemas (src/shared/schemas/indexer.ts `torznabSettingsSchema`/`newznabSettingsSchema`), which legitimately stay strict because narratorr owns that contract. Keep the strict instinct for request validators you own; relax it only for surfaces impersonating an external API. See src/server/utils/readarr-echo-fields.ts for the shared strip helper used by both the route and IndexerService.createOrUpsertProwlarr.

## drizzle-sqlite-text-enum-no-db-check

**source:** #1129
**added:** 2026-05-15
**files:** src/db/schema.ts
**tags:** drizzle, sqlite, enums, migrations

---

Drizzle SQLite's `text(name, { enum: [...] })` produces a TS-only narrow union — no DB-level CHECK constraint is emitted. Adding/removing enum values requires no migration (`pnpm db:generate` reports `No schema changes`), and rows with any string value will be accepted at the DB layer. Enforce enum integrity by: (a) Zod `.parse()` on inbound writes, and (b) a schema-alignment test asserting `<zodEnum>.options ↔ <table>.<column>.enumValues` set equality. Adding a manual CHECK constraint requires a hand-written SQL migration since Drizzle won't emit one.

## render-body-logging-lint-constraints

**source:** #1362  
**added:** 2026-06-12  
**files:** src/client/lib/eventReasonFormatters.tsx  
**tags:** eslint, no-console, react-hooks, react-render

---

In this repo, logging a validation/parse failure from inside a React component's render body has two hard lint constraints: (1) eslint `no-console` allows only `console.warn`/`console.error` in client code (so `console.debug`/`log`/`info` fail lint; server/core have no-console off), and (2) `react-hooks/refs` forbids reading/mutating `ref.current` during render, so a `useRef`-based once-guard accessed in the render body fails too. The working once-guard is a `useEffect` keyed on the data identity: `useEffect(() => { const r = schema.safeParse(data); if (!r.success) console.warn('...', r.error); }, [data])` — it fires once per distinct payload (not per re-render) and keeps the warn out of render. See src/client/lib/eventReasonFormatters.tsx (HeldForReviewDetails) for the implementation and src/client/lib/sse/safe-parse-event.ts for the non-render warn precedent. Note: specs that recommend `console.debug` for render-body signals are not directly implementable here — translate them to the effect-keyed warn.

## import-cleanup-marker-aware-fs-mock

**source:** #1336  
**added:** 2026-06-12  
**files:** src/server/services/import.service.test.ts  
**tags:** vitest, fs-mock, import-staging, disk-state-gate

---

After #1336, the import failure-cleanup paths (`handleImportFailure` in import-steps.ts, `stagedAudioReplace`'s catch in import-staging.ts) decide whether to preserve `.import-bak` + the commit-pending marker by STATTING the marker on disk (`markerPresent(targetPath, log)`), not by the thrown error's type. Consequence for tests: any mocked `node:fs/promises` with a blanket `stat.mockResolvedValue({...})` makes `${targetPath}.import-commit-pending` read as present, so `preserveBackup` becomes true on every failure — silently flipping deletion assertions AND pushing `prepareImportSiblings` into its recovery branch. In mocked-fs import suites, default the marker stat to ENOENT (`mockImplementation` that rejects for paths ending in `.import-commit-pending`, resolves a directory otherwise) and only override to resolve in tests that specifically assert marker-present preservation. `markerPresent` also fails toward preservation on a non-ENOENT stat error, so a marker stat that rejects with e.g. EACCES is treated as present. Real-tmpdir suites (staged-audio-replace.test.ts) need no special handling — there's no marker on disk unless the test stages one. The marker-aware mock idiom is already in service throughout import.service.test.ts — copy it from there.

## folder-parser-dash-split-before-cleanname

**source:** #1331  
**added:** 2026-06-12  
**files:** src/server/utils/folder-parsing.ts  
**tags:** folder-parsing, parseFolderStructure, cleanName

---

`parseFolderStructure` in src/server/utils/folder-parsing.ts splits `Author - Title` shapes on the raw input (tryAuthorTitleForms) BEFORE cleanName runs, then cleans each half independently. Consequence: `cleanName(wholeString)` output does NOT equal `parseFolderStructure([wholeString]).title` for dash-bearing names — reason about parser behavior through the end-to-end parser, never the component cleaner. Historical instance: pre-#1332, a bracket-only right segment (`[tag]`) cleaned to '' and cleanNameWithTrace's raw fallback re-injected the RAW bracket as the title. #1332 guarded that fallback for pure release-tag inputs (`current || (isPureReleaseTagBracket(name) ? '' : name.trim())`), so the pure-tag case no longer leaks — but the fallback still re-injects raw text for any other input that cleans to empty, and the split-before-clean structure is unchanged. When fixing parser behavior, validate expectations end-to-end via `pnpm exec tsx` against `parseFolderStructure`, and diff against the relevant historical commit (e.g. `git show <merge>^:...`) to get true pre-fix behavior — don't infer it from the component cleaner or trust a spec's 'pre-fix was X' claim. This bit #1331: the spec's expected 'Wool Omnibus -' was the cleanName-of-whole value, not the actual pre-#1316 parser output.

## vimock-barrel-replace-drops-named-exports

**source:** #1404  
**added:** 2026-06-12  
**files:** src/client/hooks/useCrudSettings.ts  
**tags:** vitest, vi-mock, barrel-exports, importOriginal, tanstack-query

---

A `vi.mock('<barrel>', () => ({...}))` factory REPLACES the module — any named export not listed becomes `undefined`. When a shared hook/component newly references a named export from that barrel at RUNTIME (not just types), every consumer test using a no-`importOriginal` factory breaks, but only when the code path touching the export executes (e.g. a mutation `onError`). This evades `tsc` and the hook's own tests; it surfaces only under full verify in consumer suites. Two fixes: (1) preferred — `vi.mock('<barrel>', async (importOriginal) => ({ ...(await importOriginal<typeof import('<barrel>')>()), api: {...} }))` to preserve real exports; (2) inline a hand-rolled stand-in in the factory (see CredentialsSection.test.tsx for the `ApiError` class precedent) — works but drifts from the real implementation. Rule of thumb: when you make a broadly-consumed module gain a runtime dependency on a new symbol from a heavily-mocked barrel, audit consumer mocks and run the full suite, not just typecheck + the unit's own tests. Originated in #1404 (useCrudSettings gained a runtime `ApiError` import; four settings-page suites broke only on their delete-failure tests).

## marker-recovery-is-additive

**source:** #1418  
**added:** 2026-06-12  
**files:** src/server/utils/import-staging.ts  
**tags:** import-staging, commit-pending-marker, recovery

---

The commit-pending recovery sequence (recoverInterruptedBackup in src/server/utils/import-staging.ts, reached via recoverInterruptedCommit) is ADDITIVE: it renames files from `<target>.import-bak` into the target (overwriting only same-named files), then clears the backup and marker. It never deletes existing target files, so the top-level audio count after recovery is always >= the count before. Do not reason about recovery as 'swapping in' or 'replacing' the target's file set — that's what the #1287 staged swap (stagedAudioReplace/commitStagedImport) does, not bare recovery. Practical effect: a guard that re-checks a minimum-file-count AFTER recovery (e.g. the #1418 merge >=2 re-validation) is correct defense-in-depth but cannot be triggered by the real recovery flow when a pre-recovery validation already enforced that minimum; test such guards by simulating divergent pre/post-recovery readdir results in a mocked-fs suite rather than trying to arrange a real-tmpdir shrink.

## guarded-transition-needs-returning-in-tx-mocks

**source:** #1470
**added:** 2026-06-14
**files:** src/server/services/import-queue-worker.test.ts
**tags:** drizzle, vitest, transaction-mock, transitionBookStatus, expected-guard

---

transitionBookStatus (src/server/utils/book-status.ts) and the symmetric transitionDownloadState compile to two different SQL shapes: an UNGUARDED transition is `db.update(t).set(s).where(eq(id))` and is awaited directly; a GUARDED transition (`expected: { status: X }`) is `...where(and(eq(id), eq(status, X))).returning({ id })` and reads `result.length > 0` to learn whether the precondition matched. Consequence for tests: worker/service transaction-spy mocks that build an update terminus as `where: vi.fn().mockResolvedValue({ rowsAffected: 1 })` work for unguarded writes but throw `TypeError: returning is not a function` the moment a write becomes guarded — and that TypeError reads like a behavior failure, not a stale-mock failure. When you add an `expected` guard to any of these transitions, update the test doubles in the same change: give the update terminus a value that is BOTH awaitable AND exposes `.returning()` (see the `updateWhereTerminus()` thenable helper in import-queue-worker.test.ts), and to assert guard semantics use a stateful mock that returns `[{id}]` on match / `[]` on miss keyed off a mutable tracked status (see `makeGuardedTxUpdate`). Rollback mocks that previously threw inside an async `where` must move the throw to `.returning()` for the guarded (books/downloads) write. Discriminate import_jobs writes (payload has `phase`) from book writes (no `phase`). This is broader than #1470's books axis — the downloads axis has the same shape.

## zod-type-provider-send-union-narrowing

**source:** #1452
**added:** 2026-06-14
**files:** src/server/routes/v1/actions.ts
**tags:** fastify, fastify-type-provider-zod, zod, response-schema, error-envelope

---

fastify-type-provider-zod types FastifyReply.send() as the union of the schemas declared in the route's `response` map. So once a route (using withTypeProvider<ZodTypeProvider>()) declares its 200/201 success shape, `reply.status(400).send(envelope)` fails typecheck unless 400 is also declared in the response map. Two ways to satisfy it: (1) throw a typed error and let a setErrorHandler build the envelope via its own untyped reply (how the v1 READ routes avoid the issue — they throw V1NotFoundError → v1ErrorHandler), or (2) declare an error-envelope schema for every status the handler reply.send()s inline (how the v1 ACTION routes do it: response `{ 200, 201, 400, 401, 404, 409, 500, 502, 504 }`). Helper functions receiving a bare FastifyReply parameter are not subject to the narrowing. Approach (2) also fail-closes error-body serialization. Reference: src/server/routes/v1/actions.ts vs src/server/routes/v1/books.ts + _helpers.ts (v1ErrorHandler).

## fastify-swagger-servers-strips-path-prefix

**source:** #1454
**added:** 2026-06-14
**files:** src/server/routes/v1/openapi.ts
**tags:** fastify-swagger, openapi, url-base

---

@fastify/swagger (openapi mode) emits relative path keys in `app.swagger().paths` and puts any base/prefix in `openapi.servers[].url`. If you register routes under a URL_BASE prefix and set `openapi.servers = [{ url: urlBase }]`, the spec's path keys stay relative (`/api/v1/books`), and the full URL is `servers.url + path` (`/narratorr/api/v1/books`). This is correct OpenAPI semantics (clients combine server base + relative path) but surprises tests that expect prefixed path keys — assert `servers` reflects the prefix AND path keys are relative, not `spec.paths['/narratorr/api/v1/books']`. Mechanism: `stripBasePath: true` is the default (`@fastify/swagger/lib/mode/dynamic.js`), and `normalizeUrl` (`lib/spec/openapi/utils.js`) strips each `servers[].url` basePath from every route url before emission (`if (url.startsWith(basePath) && basePath !== '/') url = url.replace(basePath, '')`), so a route mounted at `/narratorr/api/v1/books` is rewritten to `/api/v1/books`. This is non-obvious enough that it tripped a PR reviewer into a BLOCKING false-positive (#1483 F1: "URL_BASE duplicated in operation URLs") — a v1 transform that returns the route url unchanged is correct precisely because swagger strips the prefix downstream; stripping again in the transform would be dead code. Ref: src/server/routes/v1/openapi.ts (registerV1OpenApi), src/server/routes/v1/openapi.test.ts ('URL_BASE honored' describe block).

## rhf-parent-reset-clobbers-child-seterror-on-mount

**source:** #1491
**added:** 2026-06-15
**files:** src/client/components/settings/ConnectorCardForm.tsx, src/client/components/settings/ConnectorCard.tsx
**tags:** react-hook-form, useEffect, setError, component-testing

---

React runs child effects before parent effects. If a child form component applies RHF setError() in a mount effect (e.g. mapping server test `fieldErrors` onto nested `settings.*` inputs) while the parent component resets the same form via form.reset() in its own mount effect, the parent reset wipes the child's errors because it runs second. This is invisible in production (the failing test result arrives after a user click, long after mount, so reset() has already run and its deps don't change), but it breaks component tests that pass the failing result as an initial prop. Fix in tests: deliver the result AFTER mount via a small stateful wrapper that setStates it in a useEffect, mirroring the real click-driven flow — do not pass it at initial render. Applies to any entity-edit card that pairs a parent reset() effect with child-applied field errors (currently ConnectorCard; the indexer/download-client/notifier cards would hit the same trap if they add fieldError mapping). See src/client/components/settings/ConnectorCard.test.tsx.

## sqlite-null-unique-index

**added:** 2026-06-17
**files:** src/db/schema.ts, drizzle/**
**tags:** sqlite, drizzle, unique-index, null, migrations

---

In SQLite, NULL ≠ NULL inside a UNIQUE index — a nullable column does NOT prevent duplicate rows where that column is NULL. Don't rely on a unique constraint over a nullable column to dedupe; populate the column before insert, or add a service-layer dedupe guard. (Surfaced during the publicId work, where a nullable unique column silently allowed dupes at the migration boundary.)

## drizzle-enum-type-derivation

**added:** 2026-06-17
**files:** src/server/services/types.ts, src/db/schema.ts
**tags:** drizzle, typescript, enums, inferselect, inferinsert

---

Drizzle widens enum columns to `string` at the TS boundary. On READ, `typeof table.$inferSelect` re-widens enum columns — do NOT redeclare `type FooRow = typeof foos.$inferSelect` per file; import the canonical narrowed Row type from `src/server/services/types.ts` (`BookRow`, `DownloadRow`, `IndexerRow`, `BookEventRow`, etc.). A hand-rolled DB-shaped type that types an enum column as `string` is the same anti-pattern in different syntax — import the canonical type instead. On WRITE/derive, get the narrow union from `NonNullable<typeof table.$inferInsert['col']>`, never bare `string`.

## sqlite-in-clause-bind-limit

**added:** 2026-06-17
**tags:** sqlite, libsql, bind-limit, in-clause

---

When building a dynamic `IN (...)` query, chunk to stay under SQLite's bound-parameter cap and account for ALL bound params in the statement (the WHERE clause AND the IN list), not just the list length. The old "999" figure is stale — modern SQLite (≥ 3.32) / libSQL set `SQLITE_MAX_VARIABLE_NUMBER` to 32766 — but the failure mode is the same: exceed it and the statement errors at runtime. Count every placeholder when sizing chunks.

## zod-nullish-external-api

**added:** 2026-06-17
**files:** src/core/indexers/**, src/core/metadata/**, src/core/import-lists/**
**tags:** zod, validation, nullish, external-api, metadata, indexers

---

`z.string().optional()` accepts `undefined` but REJECTS `null` ("Expected string, received null"). Real external APIs (NYT, Audible, ABS, Hardcover, MAM, Audnexus) return `null` for absent values, so ANY field parsed from an external response must use `.nullish()` (accepts both null and undefined). Reserve `.optional()` for schemas we own (request validators, DB-derived shapes, form data, settings) where we control the contract.

## zod-default-ignores-empty-string

**added:** 2026-06-17
**files:** src/shared/schemas/**
**tags:** zod, defaults, validation, coercion

---

`z.string().default('x')` only applies the default for `undefined` — an empty string `''` passes through unchanged. To coalesce empty/whitespace input to a default, use `.transform(v => v || default)` (trim first if needed), not `.default()`.

## zod-trim-min-one

**added:** 2026-06-17
**files:** src/shared/schemas/**
**tags:** zod, validation, trim, user-input

---

`z.string().min(1)` accepts `'   '` (whitespace-only). For user-facing text fields use `.trim().min(1)` so a spaces-only value is rejected.

## zod-resolver-effects-divergence

**added:** 2026-06-17
**files:** src/client/components/**
**tags:** zod, zodresolver, react-hook-form, forms

---

`z.preprocess()`, `z.transform()`, and `z.default()` create ZodEffects where the input type ≠ output type; `zodResolver` requires them aligned and otherwise mistypes the form. Fix: omit `.default()` in form schemas (forms always pass explicit `defaultValues`), and use `setValueAs` in `register()` for coercion instead of `z.preprocess()`. Use the `stripDefaults()` helper to remove defaults from a server schema before reusing it in a form.

## settings-field-dual-default

**added:** 2026-06-17
**files:** src/shared/schemas/settings/**
**tags:** settings, zod, defaults, registry, mock-factory

---

A new settings field needs TWO edits: the Zod schema `.default(...)` AND `DEFAULT_SETTINGS` / `settingsRegistry.*.defaults` in `registry.ts`. Runtime reads `DEFAULT_SETTINGS` (it does NOT Zod-parse to fill defaults), so a schema-only addition leaves the runtime value and the mock factories missing the field — green typecheck, `undefined` at runtime.

## settings-from-entity-registry-overlay

**added:** 2026-06-17
**files:** src/client/components/settings/**
**tags:** settings, forms, registry, strict-schema, adapters

---

A `settingsFromX` helper that derives form state from a stored entity must spread `<ENTITY>_REGISTRY[entity.type].defaultSettings` and then overlay the entity's non-null stored values — never enumerate every possible field across every adapter type. Strict per-type schemas (`.strict()`) reject foreign-type fields with `Unrecognized keys` (400); the overlay (not defaults alone) is what preserves valid non-default keys the UI actually persisted (e.g. MAM's `isVip` / `classname`). Component tests must assert the `onFormTest` payload's `settings` contains no foreign keys for the selected type.

## sse-setquerydata-not-invalidate

**added:** 2026-06-17
**files:** src/client/hooks/**
**tags:** react-query, sse, setquerydata, realtime

---

For high-frequency SSE/stream updates, patch rows in place with `setQueryData()`, not `invalidateQueries()` — invalidation refetches on every event and thrashes the UI.

## react-query-optimistic-cancel

**added:** 2026-06-17
**files:** src/client/hooks/**
**tags:** react-query, optimistic-update, mutations

---

For optimistic updates, call `cancelQueries` before `setQueryData` — otherwise a pending refetch can overwrite the optimistic data. For paginated queries, set `placeholderData: (prev) => prev` to avoid flicker during page transitions.

## module-state-use-sync-external-store

**added:** 2026-06-17
**files:** src/client/hooks/**, src/client/lib/**
**tags:** react, usesyncexternalstore, module-state

---

Module-level mutable state read by React components must be exposed via `useSyncExternalStore` with a subscribe/notify pair — a bare `let` won't trigger re-renders and tears across concurrent renders.

## derived-state-over-copied

**added:** 2026-06-17
**tags:** react, react-query, derived-state, race

---

Prefer derived state to copied state: `override ?? queryDefault ?? fallback` instead of copying async query data into `useState`. Copying creates a race where the local copy goes stale relative to the query cache.

## backdrop-filter-stacking-context

**added:** 2026-06-17
**files:** src/client/components/**
**tags:** css, tailwind, portal, z-index

---

An element with `backdrop-filter` (e.g. glass-card containers) creates a stacking context that traps descendant z-index. Dropdowns/modals that must escape it have to render through a portal attached to `<body>`, not the nearest parent.

## dropdown-option-case-insensitive-dedup

**added:** 2026-06-17
**tags:** react, filters, dedup

---

Deduplicate dropdown/filter options case-insensitively (a Map keyed by the lowercased value) — otherwise values differing only by case render as duplicate entries.

## stable-list-keys

**added:** 2026-06-17
**tags:** react, keys, lists

---

Use field-based React keys, not array indices. Append an index suffix only at actual collision points, via a dedup helper — index-only keys remount/reorder incorrectly when the list changes.

## spa-fallback-url-base-scope

**added:** 2026-06-17
**files:** src/server/server-utils.ts
**tags:** fastify, spa, url-base, routing

---

The SPA index.html fallback must reject any request whose path doesn't start with `URL_BASE` before serving index.html — otherwise unrelated paths get the SPA shell instead of a 404 when the app is mounted under a sub-path.

## fire-and-forget-preflight

**added:** 2026-06-17
**files:** src/server/services/**
**tags:** fastify, background-jobs, async, validation

---

When a service method kicks off a background job (`.start()`), do all pre-flight validation SYNCHRONOUSLY before creating the job — a throw inside the async work function is unreachable by the caller because the route already returned 202. Make the method `async`, validate first, then create the job.

## db-update-after-first-irreversible-fs-step

**added:** 2026-06-17
**files:** src/server/utils/import-staging.ts, src/server/services/import.service.ts
**tags:** import, filesystem, db-consistency

---

In a pipeline that mutates the filesystem, update the database immediately after the FIRST irreversible fs step, not at the end. Deferring the DB write opens a window where the files have moved but the DB still points at the old state if the process dies mid-pipeline.

## fk-restore-find-or-create

**added:** 2026-06-17
**files:** src/server/services/**
**tags:** backup, restore, foreign-keys, db

---

When restoring records (backup import, re-import), find-or-create the related FK records too, not just the primary scalar columns — a restore that writes only the primary row leaves dangling FKs to authors/series/etc. that no longer exist.

## import-commit-atomic-rename

**added:** 2026-06-17
**files:** src/server/utils/import-staging.ts
**tags:** import, filesystem, rename, atomicity

---

The import commit/rollback in `import-staging.ts` relies on `rename()` atomically replacing the destination file. Do NOT `unlink()` before `rename()`, and don't substitute copy+delete — either opens a data-loss window the rollback assumes cannot exist. (POSIX gives no ordering guarantee between an un-fsync'd write and the backup-out renames, which is why the commit guards before the destructive step.)

## variable-length-format-most-specific-first

**added:** 2026-06-17
**tags:** parsing, cron, schedule

---

When parsing a format with a variable field count, check the MOST specific shape first — e.g. a 6-part (seconds-precision) cron before a 5-part cron — otherwise the shorter pattern greedily matches and the extra field is mis-parsed.

## bitrate-bps-kbps-boundary

**added:** 2026-06-17
**files:** src/core/utils/**
**tags:** audio, bitrate, music-metadata, units

---

`music-metadata` returns bitrate in bps (128000); settings/schemas use kbps (128); the DB stores bps. Always convert at the call site with `Math.floor(bps / 1000)` — never compare raw bitrate values across this boundary.

## retention-lt-not-lte

**added:** 2026-06-17
**files:** src/server/jobs/**
**tags:** retention, cleanup, date-boundary

---

"Older than N days" means strictly-less-than: use `lt`, not `lte`, on the cutoff timestamp. `lte` includes the boundary day and deletes one day too much.

## mock-settings-deep-clone

**added:** 2026-06-17
**files:** src/shared/schemas/settings/create-mock-settings.fixtures.ts
**tags:** test-fixtures, settings, deep-clone, test-isolation

---

The mock-settings factory deep-clones `DEFAULT_SETTINGS` (via `JSON.parse(JSON.stringify(...))`) so a test mutating the returned object can't pollute the shared default for later tests. Any new factory built off a shared default object must deep-clone it — a shallow `{ ...obj }` shares nested references and leaks mutations across tests.

## vitest-clearallmocks-once-queue

**added:** 2026-06-17
**tags:** vitest, mocks, test-isolation

---

`vi.clearAllMocks()` only clears call history (`mockClear`); it does NOT drain `mockResolvedValueOnce` / `mockReturnValueOnce` / `mockImplementationOnce` queues or reset implementations. A `beforeEach(clearAllMocks)` mixed with per-test `*Once()` queueing leaks stale queued responses across tests (flaky pass/fail). Use `vi.resetAllMocks()` (or per-mock `mockReset()`) when `*Once()` queues are in play — it drains the queue AND restores the implementation.

## vitest-faketimers-react-query

**added:** 2026-06-17
**tags:** vitest, faketimers, react-query

---

A full `vi.useFakeTimers()` deadlocks TanStack Query's internal `setTimeout`. In tests that mix polling hooks with Query, fake only what you need: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` and drive with explicit `vi.advanceTimersByTime()`.

## esm-same-module-vi-mock-bypass

**added:** 2026-06-17
**files:** src/core/utils/network-service.ts
**tags:** vitest, vi-mock, esm, module-binding

---

When an exported function calls another exported function from the SAME module (e.g. `fetchWithSsrfRedirect` → `fetchWithOptionalDispatcher` in `network-service.ts`), the inner call uses the local binding, not the module's export — so a `vi.mock` factory overriding the inner export will NOT intercept it (only external callers see the override). Workarounds, in order of preference: (1) mock at the OS boundary (`node:dns/promises`, `node:fs/promises`, `vi.stubGlobal('fetch', ...)`); (2) stub the entry point itself, not its inner deps; (3) replace the entry-point implementation in the mock factory. Do NOT add `__internal` indirection to production code just to enable mocking.

## serialize-error-catch-binding-tracing

**added:** 2026-06-17
**tags:** eslint, pino, serialize-error, logging

---

The `narratorr/no-raw-error-logging` rule traces values back to their catch-binding origin: it fires on `{ error: catchBinding.<dot.chain> }` (e.g. `{ error: error.cause }`, `{ error: err.message }`) but NOT on `{ error: typedResult.error }` where the root identifier is a typed result-union. Computed (`obj[key]`) segments are skipped. If it fires, wrap the value with `serializeError()` from `src/server/utils/serialize-error.js` — don't reach for `// eslint-disable`; check whether the value really traces back to a catch binding.

## abortsignal-timeout-native-timer-retry-tests

**source:** #1527
**added:** 2026-06-18
**files:** src/core/utils/network-service.ts
**tags:** abortsignal, fetch-timeout, retry-backoff

---

Node 24's `AbortSignal.timeout(ms)` schedules on an internal native timer, NOT the patchable `globalThis.setTimeout` (verified: a wrapped `globalThis.setTimeout` is not invoked when `AbortSignal.timeout` is created, and the signal still aborts with `TimeoutError`). Consequence for testing retry adapters that pair `fetchWithTimeout` (`src/core/utils/network-service.ts` — built on `AbortSignal.timeout`) with their own `setTimeout` backoff: `vi.spyOn(globalThis, 'setTimeout')` can capture the adapter's exact backoff delay AND redirect it to fire immediately (`return original(fn, 0)`) while the per-call request timeout keeps working against real MSW responses. This gives deterministic exact-delay assertions (honored `Retry-After`, fallback default, max-clamp, caller-abort-during-backoff) with no `vi.useFakeTimers` / `advanceTimersByTimeAsync` / MSW interleaving fragility. Exemplar: `src/core/download-clients/retry.test.ts` (503 retry suite; `attribution.test.ts` was removed with the earwitness cut, #1596). Exception/guardrail: this works ONLY because `AbortSignal.timeout` is native — a hand-rolled `AbortController` + `setTimeout` timeout WOULD be captured by the spy, so the pattern breaks for clients not built on `fetchWithTimeout`.
