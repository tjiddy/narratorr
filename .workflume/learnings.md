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

**source:** #1129, #1957
**added:** 2026-05-15
**files:** src/db/schema.ts
**tags:** drizzle, sqlite, enums, migrations, check-constraints, drizzle-kit

---

Drizzle SQLite's `text(name, { enum: [...] })` produces a TS-only narrow union — no DB-level CHECK constraint is emitted. Adding/removing enum values requires no migration (`pnpm db:generate` reports `No schema changes`), and rows with any string value will be accepted at the DB layer. Enforce enum integrity by: (a) Zod `.parse()` on inbound writes, and (b) a schema-alignment test asserting `<zodEnum>.options ↔ <table>.<column>.enumValues` set equality.

**Correction (#1957).** This entry used to end "Adding a manual CHECK constraint requires a hand-written SQL migration since Drizzle won't emit one." **That was false and it mis-steered a design document.** The claim holds only for the enum COLUMN helper above. The `check()` TABLE-CONSTRAINT helper from `drizzle-orm/sqlite-core` is a different API and it DOES emit DB-level constraints: return `` check('<name>', sql`<predicate>`) `` from the table's second-argument array and an ordinary `pnpm exec drizzle-kit generate --name <slug>` writes inline `CONSTRAINT "<name>" CHECK(...)` clauses into the CREATE TABLE. Verified on drizzle-orm@0.45.2 / drizzle-kit@0.31.10, dialect `turso` — see `src/db/schema.ts` (eight of them) and the emitted `CONSTRAINT "ck_companion_ebooks_*" CHECK(...)` clauses in `drizzle/0000_baseline.sql`, with real-DB proof in `src/db/companion-ebooks-schema.integration.test.ts`. (Cite the constraint names, not a migration index — the index is not stable pre-1.0; these clauses were emitted into a `0001_companion_ebooks` that has since been flattened into the baseline.)

Four traps when writing them:

1. **No bound parameters in DDL.** A `${value}` interpolation inside the `sql` template becomes a `?` placeholder, which is invalid inside a CHECK. To derive a literal list from a canonical tuple use `` sql.raw(TUPLE.map((s) => `'${s}'`).join(', ')) ``, and assert in a test that the emitted DDL contains the literals and no `?`.
2. **Never use `--custom` for this.** `drizzle-kit generate --custom` writes an empty SQL file *and* a snapshot that does not contain the new table, so the next ordinary `generate` emits a second, duplicate `CREATE TABLE`. That migration applies cleanly on the generating machine and fails a from-scratch CI run with "table already exists" — the local-passes/CI-fails class the `git add drizzle/` rule exists to prevent. A new table is a pure add, so ordinary generate never prompts (cf. `drizzle-migration-prompt-hang`).
3. **SQLite treats a CHECK evaluating to NULL as SATISFIED.** Any predicate touching a nullable column must go through a total operator (`IS NULL` / `IS NOT NULL` / `typeof(...)`) or be guarded by an `IS NOT NULL` term in the same conjunction.
4. **SQLite evaluates CHECKs in declaration order and reports only the FIRST failure by name.** A test asserting *which* constraint fired must use a row that violates exactly one, and must compare the extracted name (`/CHECK constraint failed: (\S+)/`) with equality — a substring match lets a name that prefixes another satisfy the wrong assertion.

Related: `migrated-db-assertions-through-drizzle` (the constraint message is on `.cause`, not `.message`).

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

**source:** #1404, #1963  
**added:** 2026-06-12  
**files:** src/client/hooks/useCrudSettings.ts, src/client/pages/book/BookPage.test.tsx  
**tags:** vitest, vi-mock, barrel-exports, importOriginal, tanstack-query, jsdom, fetch

---

A `vi.mock('<barrel>', () => ({...}))` factory REPLACES the module — any named export not listed becomes `undefined`. When a shared hook/component newly references a named export from that barrel at RUNTIME (not just types), every consumer test using a no-`importOriginal` factory breaks, but only when the code path touching the export executes (e.g. a mutation `onError`). This evades `tsc` and the hook's own tests; it surfaces only under full verify in consumer suites. Two fixes: (1) preferred — `vi.mock('<barrel>', async (importOriginal) => ({ ...(await importOriginal<typeof import('<barrel>')>()), api: {...} }))` to preserve real exports; (2) inline a hand-rolled stand-in in the factory (see CredentialsSection.test.tsx for the `ApiError` class precedent) — works but drifts from the real implementation. Rule of thumb: when you make a broadly-consumed module gain a runtime dependency on a new symbol from a heavily-mocked barrel, audit consumer mocks and run the full suite, not just typecheck + the unit's own tests. Originated in #1404 (useCrudSettings gained a runtime `ApiError` import; four settings-page suites broke only on their delete-failure tests).

**The reciprocal hazard (#1963) — preserving the barrel keeps every unstubbed method REAL.** Fix (1) above is correct, but when the factory spreads `actual.api` rather than replacing `api` wholesale, every method you do NOT stub still runs. A real method calls `fetchApi` → `` fetch(`${URL_BASE}/api${path}`) ``, a relative URL jsdom resolves against its base — so the suite issues genuine network requests. They usually degrade silently, so nothing goes red and the suite quietly depends on the host's fetch behaviour. Measured on `BookPage.test.tsx`, where only the book loaders were stubbed; a `vi.spyOn(globalThis, 'fetch')` probe caught three escapees: `/api/books/1/series` (SeriesCard, via BookDetailsContent), `/api/settings/ffmpeg-status` (useFfmpegStatus, which BookDetails always executes), `/api/auth/stream-token` (mintStreamToken, via SearchReleasesModal).

Enumerating them is not durable — a new child component adds a fourth. Add a standing guard:

```ts
let fetchSpy: MockInstance<typeof globalThis.fetch>
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch') })
afterEach(() => { fetchSpy.mockRestore() })

it('issues no real network request while rendering the fully-loaded page', async () => {
  renderPage()
  await waitFor(() => expect(screen.getByText('<late-arriving content>')).toBeInTheDocument())
  expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([])
})
```

Two details: await the fully-loaded page or the secondary queries have not fired yet; and type the handle as `MockInstance<typeof globalThis.fetch>` — `ReturnType<typeof vi.spyOn>` loses the generic and trips TS7006 on `.mock.calls`. This is a per-suite audit, not an automatic consequence: `BookDetails.test.tsx` and `BookDetailsContent.test.tsx` use the same shape and were already clean.

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

**source:** #1963
**added:** 2026-06-17
**files:** src/client/hooks/**, src/client/pages/book/useCompanionEbookSelection.ts
**tags:** react-query, optimistic-update, mutations, test-observability

---

For optimistic updates, call `cancelQueries` before `setQueryData` — otherwise a pending refetch can overwrite the optimistic data. For paginated queries, set `placeholderData: (prev) => prev` to avoid flicker during page transitions.

**Testing it (#1963) — the obvious test is vacuous.** `queryClient.invalidateQueries()` refetches with `cancelRefetch: true` by default, aborting the current retryer and discarding any in-flight fetch's result. So in the standard shape (`await cancelQueries()` → `setQueryData(result)` in `onSuccess`, then `invalidateQueries()` in `onSettled`), the trailing invalidation independently kills a pre-write GET. An END-STATE test — hold a GET open, do the write, release the stale GET late, assert the post-write value is still shown — therefore passes with the `cancelQueries` call **deleted**. Verified: removing it from `useCompanionEbookSelection.ts` left all 85 tests green.

The window `cancelQueries` actually protects is between `setQueryData` and `onSettled`'s invalidation, and it is not deterministically reachable (react-query awaits `onSuccess` before `onSettled`). Assert the ordering directly instead:

```ts
const cancelSpy = vi.spyOn(client, 'cancelQueries')
const setDataSpy = vi.spyOn(client, 'setQueryData')
// ... drive the mutation ...
expect(cancelSpy).toHaveBeenCalledWith({ queryKey: key })
expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(setDataSpy.mock.invocationCallOrder[0])
```

Example: `src/client/pages/book/CompanionEbookSection.test.tsx`, 'cancels an in-flight /state GET before installing the post-write body'. Related: `vacuous-assertion-observation-points`.

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

**source:** #1974
**added:** 2026-06-17
**files:** src/server/services/companion-ebook-open.test.ts
**tags:** eslint, pino, serialize-error, logging, test-assertions

---

The `narratorr/no-raw-error-logging` rule traces values back to their catch-binding origin: it fires on `{ error: catchBinding.<dot.chain> }` (e.g. `{ error: error.cause }`, `{ error: err.message }`) but NOT on `{ error: typedResult.error }` where the root identifier is a typed result-union. Computed (`obj[key]`) segments are skipped. If it fires, wrap the value with `serializeError()` from `src/server/utils/serialize-error.js` — don't reach for `// eslint-disable`; check whether the value really traces back to a catch binding.

**Asserting it in a test (#1974).** `expect.objectContaining({ message: ... })` and `toMatchObject` do NOT discriminate a serialized error from a raw one: `Error.prototype.message`/`.stack` are non-enumerable own properties and both matchers read through to them, so a raw `Error` satisfies the assertion and the test stays green if `serializeError()` is deleted. A recursive string scan over the record is hollow too when the fixture is `Object.assign(new Error(m), { code })` — `code` is enumerable and is found on the raw Error. **Assert something the raw Error lacks.** Either include `type: 'Error'` (the repo's prevailing idiom, ~20 sites — `type` is the load-bearing term, not `message`), or pin the full own-enumerable key set for maximum strength:

```ts
expect(logged).not.toBeInstanceOf(Error)
expect(Object.keys(logged).sort()).toEqual(['code', 'message', 'stack', 'type'])
// then toEqual the exact values
```

The key set is also what Pino actually emits, since it serializes own-enumerable properties only. Strongest precedent: `indexer-search.service.test.ts:715-724`; reusable `expectSerializedError` helpers in `companion-ebook-open.test.ts` / `companion-ebook-discovery.test.ts`. Validate any such assertion by mutating the production call to log the raw binding and confirming the test fails. Related: `vacuous-assertion-observation-points`.

## abortsignal-timeout-native-timer-retry-tests

**source:** #1527
**added:** 2026-06-18
**files:** src/core/utils/network-service.ts
**tags:** abortsignal, fetch-timeout, retry-backoff

---

Node 24's `AbortSignal.timeout(ms)` schedules on an internal native timer, NOT the patchable `globalThis.setTimeout` (verified: a wrapped `globalThis.setTimeout` is not invoked when `AbortSignal.timeout` is created, and the signal still aborts with `TimeoutError`). Consequence for testing retry adapters that pair `fetchWithTimeout` (`src/core/utils/network-service.ts` — built on `AbortSignal.timeout`) with their own `setTimeout` backoff: `vi.spyOn(globalThis, 'setTimeout')` can capture the adapter's exact backoff delay AND redirect it to fire immediately (`return original(fn, 0)`) while the per-call request timeout keeps working against real MSW responses. This gives deterministic exact-delay assertions (honored `Retry-After`, fallback default, max-clamp, caller-abort-during-backoff) with no `vi.useFakeTimers` / `advanceTimersByTimeAsync` / MSW interleaving fragility. Exemplar: `src/core/download-clients/retry.test.ts` (503 retry suite; `attribution.test.ts` was removed with the earwitness cut, #1596). Exception/guardrail: this works ONLY because `AbortSignal.timeout` is native — a hand-rolled `AbortController` + `setTimeout` timeout WOULD be captured by the spy, so the pattern breaks for clients not built on `fetchWithTimeout`.

## music-metadata-common-shapes-and-native-freeform

**source:** #1671  
**added:** 2026-06-29  
**files:** src/server/services/retag-plan.ts  
**tags:** music-metadata, audio-tags, tag-readback

---

music-metadata's `common` (ICommonTagsResult) returns these as `string[]` — read `?.[0]`: subtitle, publisher, description, genre, composer, label. These are scalars: artist, album, albumartist, grouping, asin (string), year (number), date (string). Freeform/custom tags (e.g. `series`, `series-part`) written via ffmpeg `-metadata key=value` do NOT appear in `common` at all — they only surface in `metadata.native` keyed by format, as `{ id, value }` arrays, with ids like `TXXX:series` (ID3v2), `----:com.apple.iTunes:series` (MP4), or a bare `series`; TXXX `value` can be a `{ description, text }` object rather than a plain string. Any tag-readback (populate_missing field-awareness, dedup, enrichment) must therefore handle: (1) array-vs-scalar per common field, and (2) a native-frame scan for freeform fields with no common mapping. retag-plan.ts splits this into readCommonCoreTags/readCommonAbsTags (common) + readNativeSeriesTags/readNativeFreeform (native), matching id by exact-equal or `:<key>` suffix, case-insensitive. Prior art for native ASIN scanning lives in src/core/utils/audio-scanner.ts (scanNativeForAsin).

## book-duration-minutes-vs-quality-seconds

**source:** #1797
**added:** 2026-07-02
**files:** src/core/utils/quality.ts, src/server/services/book-list.service.ts
**tags:** quality, duration-units, audiobook, grab-floor, resolveBookQualityInputs

---

`books.duration` (DB column) is stored in MINUTES (Audible `runtime_length_min`); `books.audioDuration` is stored in SECONDS. The quality chain — `calculateQuality(sizeBytes, durationSeconds)`, `compareQuality`, and the MB-per-hour grab floor / quality tiers in `src/server/services/search-pipeline.ts` — is entirely SECONDS-based. Passing raw `book.duration` into that chain inflates MB/hr 60× and makes absolute thresholds (grabFloor, `NARRATOR_QUALITY_FLOOR_MBHR`) inert while leaving relative ranking unaffected (the 60× cancels within one book), so the bug is easy to miss. The single JS normalization home is `resolveBookQualityInputs(book)` in `src/core/utils/quality.ts`, precedence `audioDuration ?? duration*60`. Every grab/retry/RSS path and the display path must funnel duration through it; the display path already sends true seconds from the client (`SearchReleasesModal.tsx` now routes through `resolveBookQualityInputs`, not a manual multiply). Guard against reintroduction: `grep -rn "duration \* 60" src` (excluding tests/comments) must return exactly one production hit (quality.ts). When writing fixtures, remember a `duration` literal that looks like seconds (e.g. `36000`) in a minutes column is 600 hours, not 10 — pair `_SIZE = mbPerHour*hours*MB` fixtures with `duration` in minutes (`hours*60`).

**Note (triage-verified, #1804):** there is a SECOND deliberate normalization home the grep-guard does not catch — the library list-sort path re-expresses the same conversion in SQL as `${books.duration} * 60` at `src/server/services/book-list.service.ts:355` (a Drizzle order-by can't call the JS helper), and it's DRY-3-commented there. So the guard's "exactly one production hit" counts only the JS `duration * 60` literal; the SQL twin is expected and must be kept in sync with the helper's precedence.

## libsql-foreign-keys-on-by-default

**source:** #1736
**added:** 2026-06-30
**files:** src/db/client.ts, src/db/schema.ts
**tags:** libsql, sqlite, foreign-keys, drizzle

---

`@libsql/client` (used in `src/db/client.ts` `createDb`) enables `PRAGMA foreign_keys` by default — a fresh connection returns `foreign_keys=1` even though nothing in the codebase sets the pragma. This is the OPPOSITE of vanilla SQLite, which defaults FK enforcement OFF. Verified empirically. Implications: (1) every `onDelete: 'set null' | 'cascade'` clause in `src/db/schema.ts` is enforced at runtime — deleting a `books` row nulls `import_jobs.book_id`/`book_events.book_id` and cascade-deletes `book_authors`/`book_narrators`, which is why `BookService.delete` only deletes the `books` row and code can rely on FK set-null rather than manually nulling linkage columns (#1736); (2) inserting a child row that references an already-deleted parent throws a FK violation, so mind write ordering (e.g. record an event with `bookId: null` after deleting the book, never the dead id); (3) real-DB tests via `createDb`/`runMigrations` enforce FKs the same way. Don't add a `PRAGMA foreign_keys=ON` thinking it's missing, and don't assume schema FK clauses are inert.

## new-books-column-breaks-inline-fixtures

**source:** #1711
**added:** 2026-06-30
**files:** src/server/__tests__/factories.ts, src/server/services/types.ts
**tags:** drizzle, inferselect, test-fixtures, schema-migration

---

Adding a nullable column to the `books` table (e.g. #1711 `edition_label`) breaks every hand-built `BookRow`/`BookWithAuthor` object literal in tests, because Drizzle's `$inferSelect` types a nullable column as a REQUIRED `string | null` property (plain nullable columns are not optional at the type level). The canonical fixture is `createMockDbBook` in `src/server/__tests__/factories.ts` — update it first — but several suites inline their own book literals that each need the new field: `quality-gate.service.test.ts`, `quality-gate.helpers.test.ts`, and `import-list.service.test.ts`. When adding a books column, grep for `productionType:`/`enrichmentAttempts:` to locate inline literals and run `pnpm typecheck` to enumerate the rest. The canonical narrowed Row types live in `src/server/services/types.ts`.

**Note (triage-verified, #1718):** the canonical `createMockDbBook` factory is NOT a drop-in for every suite — `quality-gate`'s `baseBook` is a SUPERSET shape (it carries `narrators`/`language`/`rating`/`tags` the DB-row factory lacks), so it genuinely can't delegate to the factory and the inline-literal ripple there is unavoidable, not merely un-DRY debt. Related: `drizzle-enum-type-derivation` (same `$inferSelect` territory, different lesson).

## ffprobe-mm-disjoint-duration-lies

**source:** #1846
**added:** 2026-07-08
**files:** src/core/utils/audio-probe.ts
**tags:** ffprobe, music-metadata, audio-duration, mp3-xing, plausibility-guard

---

The scanner's two duration sources fail in disjoint ways, so neither is trustworthy alone. ffprobe's MP3 `format=duration` = filesize ÷ header bitrate: a file with a garbage Xing/Info header bitrate (e.g. The Rise of Endymion 001/118 at 827/746 bps) makes ffprobe report ~7.7–8.6 h for 4:00 files, inflating a book from ~30 h to ~46 h and raising a false duration-mismatch review flag. music-metadata derives MP3 length from the Xing frame count and reads those correctly, but historically halved ~1.7% of 64-bit-atom M4Bs (fixed in music-metadata v11.13.0) and returns no duration for version-1 `tkhd` M4Bs (ffprobe reads those). #1846 made music-metadata primary (free — already parsed for tags — and now trustworthy) with ffprobe as fallback/arbiter, gated by `isPlausibleDuration(duration, fileSize)` in src/core/utils/audio-probe.ts: implausible iff duration/fileSize non-finite-or-≤0, or implied bitrate `fileSize*8/duration` < 8000 bps AND duration > 1800 s (duration-gated floor so short low-bitrate files like e2e/assets/silent.m4b pass), or implied bitrate > 10_000_000 bps. When neither source is plausible the file's duration is omitted (never resurrect a known lie). The guard catches only gross lies — a subtle 2× halving inside the bitrate band is undetectable by bitrate alone; a downstream duration-mismatch comparison is the backstop where one exists. Constants are bps/seconds — never compare against kbps (see bitrate-bps-kbps-boundary).

## zod-type-scoped-settings-transform

**source:** #1879
**added:** 2026-07-17
**files:** src/shared/schemas/import-list.ts
**tags:** zod, settings-schema, superRefine, transform

---

Per-adapter settings schemas that must emit ONLY the effective type's own keys (no stale foreign key from a prior type) should strip via a `.transform()` chained after `.superRefine()`, not a plain strict object (which keeps every present declared key). The server resolver (`validateSettingsPerType`, src/shared/schemas/import-list.ts) replaces `data.settings` with the schema's parsed output, so the transform's per-branch object becomes what is persisted. Zod runs a `.transform()` only when the preceding `.superRefine()` produced no issues (verified empirically on zod 4.4.1), so non-null assertions inside the transform for fields the refine guarantees present are safe. Declare the output as an explicit single wide optional-field type (not `z.infer`, which yields a discriminated union the registry factory can't index). Keep the discriminant (`listType`) optional with an omitted→default branch for backward compatibility. Prior art: `hardcoverSettingsSchema` (#1879). Related: settings-from-entity-registry-overlay, compat-surface-zod-strip-not-strict.

## drizzle-schema-toplevel-deref-breaks-partial-mocks

**source:** #1894
**added:** 2026-07-21
**files:** src/server/services/import-submission-report.service.ts
**tags:** drizzle, vitest, vi-mock, db-schema, module-load

---

A module-level constant that dereferences Drizzle schema columns (e.g. `const PROJ = { disposition: importSubmissionItems.disposition }`) is evaluated at import time. Any suite that `vi.mock`s `db/schema` with a partial factory omitting that table will then crash on load of ANY module in the import graph — the error is `No "<table>" export is defined on the "../../db/schema.js" mock`, thrown from the const's line, not from the test. Existing services avoid this by only referencing tables inside method bodies (evaluated at call time). Build such column projections lazily (a function returning the object, called at query time). Symptom is invisible to typecheck and to the module's own focused tests; it only appears when an unrelated suite that partial-mocks the schema pulls the module into its graph — so validate with the full `vitest run`, not just the changed files. Seen: top-level `REPORT_ITEM_PROJECTION` in import-submission-report.service.ts vs the partial db/schema mock in tagging.service.test.ts (#1894). Related: vimock-barrel-replace-drops-named-exports.

## react-query-mutation-callbacks-post-unmount

**source:** #1905
**added:** 2026-07-21
**files:** src/client/hooks/useReplaceGrab.ts, src/client/components/SearchReleasesModal.tsx
**tags:** react-query, tanstack-query, mutations, unmount, keyed-remount

---

TanStack Query v5's `useMutation({ onSuccess, onError, onSettled })` callbacks fire even after the component that called `mutate()` has unmounted — they are captured into the Mutation instance at build/mutate time and `mutation.execute()` invokes them regardless of whether the observer was removed. **This is the opposite of the `mutate(vars, { onSuccess })` form**, whose callbacks ARE skipped after unmount (`mutationObserver.js` gates them on `this.#mutateOptions && this.hasListeners()`); the docs describe that second form, so the two look contradictory unless you know which one you're holding. Consequence: unmounting a component (including a keyed remount on an id change) does NOT cancel a pending mutation's hook-level follow-up side effects. Any lifecycle-local effect (toast, modal close, setState on the unmounted tree's owner, confirm dialog) must be guarded — the established pattern here is a monotonic generation ref captured in `onMutate` and re-checked in the callbacks (see src/client/hooks/useReplaceGrab.ts), suppressing lifecycle-local effects for a stale generation while leaving unconditional cache invalidations in place. When the teardown is a keyed remount or close, advance that generation on a SYNCHRONOUS seam (a `useLayoutEffect` cleanup, which runs before the next instance is interactive), not a passive `useEffect` cleanup (which runs after the new instance has committed, leaving a stale-callback window). Verified in src/client/components/SearchReleasesModal.book-change.test.tsx. Related: rtl-layout-vs-passive-seam-testing (how to write a test that actually proves the seam).

## rtl-layout-vs-passive-seam-testing

**source:** #1905
**added:** 2026-07-21
**files:** src/client/components/SearchReleasesModal.book-change.test.tsx
**tags:** useLayoutEffect, effect-ordering, act

---

React Testing Library's `render`/`rerender` wrap updates in `act`, which flushes passive effects synchronously before returning. Therefore a test that settles a held promise AFTER `rerender()` cannot distinguish a `useLayoutEffect` cleanup from a `useEffect` cleanup — the guarded state (e.g. a generation ref) is already advanced by the time the awaited callback runs, so the test passes for both seams and provides no protection. To prove a teardown runs on the synchronous (layout) seam, force the observation into the pre-passive window: (1) SYNCHRONOUS THENABLE — for a continuation attached directly to a promise, stub the awaited call to return a hand-rolled thenable whose `.resolve()` invokes queued `.then`/`.catch` synchronously, and trigger `.resolve()` from a sibling probe's `useLayoutEffect` setup (keyed alongside the swapped subtree) so the continuation runs in the layout phase; assert on the count of ALL constructed side-effect instances, not just live ones (a passive cleanup can construct-then-close within the same commit). (2) EFFECT-ORDERING MARKERS — when the continuation is inherently async (react-query awaits its mutationFn so its callbacks always run post-passive), technique 1 won't work; wrap the teardown hook via `vi.mock(m, importOriginal)` (memoize the wrapper to keep identity stable so the layout effect doesn't re-run), push a marker from the teardown and another from the incoming component's `useLayoutEffect` setup, and assert order `[teardown, interactive]` — React runs all layout cleanups before all layout setups, and a passive cleanup reverses that order. Non-negotiable: confirm each such test FAILS when the production seam is temporarily reverted to the passive form. Example: src/client/components/SearchReleasesModal.book-change.test.tsx (#1905).

## fetch-status-classification-for-cached-outcomes

**source:** #1942
**added:** 2026-07-25
**files:** src/core/utils/network-service.ts, src/core/metadata/audnexus.ts
**tags:** fetch, http-status, network-service, provider-adapters, caching

---

Any adapter whose outcome gets CACHED must classify the response deliberately; the shortcuts in the uncached adapters are unsafe there.

- **`response.ok` is not `status === 200`.** The Fetch Standard defines `ok` as 200-299, so a null-body 202/204/206 passes `if (response.ok)` and reaches the JSON parser. Gate a definitive/cacheable branch on `response.status === 200` exactly.
- **Never fold all non-OK statuses into a 'not found'.** `audnexus.ts` `fetchJsonDetailed` does `if (!response.ok) return { kind: 'not_found' }`, which is fine for a throwaway result but would cache a temporary 401/403/408/auth-proxy error as a permanent absence. Map only the statuses the upstream API DOCUMENTS as absence (Audnexus: 400 and 404); everything else is transient.
- **3xx never arrives as a status.** `fetchWithTimeout` (src/core/utils/network-service.ts) sets `redirect: 'manual'` and throws for 300-399 before returning, so redirects surface via the pre-header catch. No 3xx arm is needed — but that catch must classify as transient, not as a miss.
- **Split at the body boundary.** `fetchWithTimeout` returns the Response with its `AbortSignal.timeout` still attached, so the body stream can reject after headers. `response.json()` reads AND parses in one call, conflating 'the exchange never completed' with 'the body arrived and is garbage'. Do `await response.text()` (rejection → transient) then `JSON.parse` (failure → invalid-record).
- **Bytes arriving is not authority.** This boundary explicitly expects HTML interstitials, rate-limit pages, and upstream shape changes. If the cached verdict is about a specific entity, require an identity predicate (`body.asin === requestedAsin`) AND a shape predicate (the expected collection is present) — an OR admits both wrong-entity records and error envelopes.

Reference implementation and full status/body test matrix: `AudnexusProvider.getChapterRuntime` / `classifyChapterBody` in src/core/metadata/audnexus.ts, tests in audnexus.test.ts ('getChapterRuntime — chapter-runtime adapter (#1942)'). Related: zod-nullish-external-api (optional external fields alone cannot prove a record is genuine).

## windows-hostile-test-primitives

**source:** #1959, #1976, #1989
**added:** 2026-07-27
**files:** src/server/**/*.test.ts, src/server/__tests__/**/*.ts, src/core/**/*.test.ts, src/core/__tests__/**/*.ts, src/db/**/*.test.ts, src/shared/**/*.test.ts
**tags:** windows, vitest, filesystem, symlink, chmod, libsql, tmpdir, cross-platform

---

**Scope note.** The `files` list above is deliberately broad: it covers every server, core, db and
shared test PLUS the test-infrastructure files under `__tests__/` (`e2e-helpers.ts`, `windows-fs.ts`,
`epub-archive.fixture.ts`), because that is where these traps are actually written. It was originally
scoped to the four directories where one batch's failures happened to land, which silently excluded
`src/server/routes/**` and `src/server/__tests__/**` — the latter is where e2e suites live, and it
missed the very next one written. Scope this by where the trap *applies*, not where it last bit.
Client tests are excluded on purpose: jsdom touches no filesystem.

Four filesystem primitives behave differently on Windows and will fail a suite that passes on the
Linux pipeline. **The pipeline cannot observe any of them**, so they land green in CI and only surface
when Todd runs `pnpm verify` on his machine — which is his gate before every push, so a suite carrying
these blocks *all* local verification, not just its own file. One companion-ebook slate landed 38 such
failures across 7 files in a single night, none of them production defects.

**1. `symlink()` raises `EPERM`.** Windows requires Developer Mode or an elevated shell. A junction is
not a substitute — it is directory-only and `lstat().isSymbolicLink()` is what production actually
tests. Gate on a **capability probe**, not `process.platform === 'win32'`: a dev box with Developer
Mode on can run it, and these assertions usually guard a security property worth skipping as rarely as
possible.

```ts
const CAN_SYMLINK = await (async () => {
  const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const probe = await mkdtemp(path.join(tmpdir(), 'symlink-probe-'));
  try { const t = path.join(probe, 't'); await writeFile(t, ''); await symlink(t, path.join(probe, 'l')); return true; }
  catch { return false; }
  finally { await rm(probe, { recursive: true, force: true }); }
})();

it.skipIf(!CAN_SYMLINK)('rejects a symlink ...', async () => { /* ... */ });
```

**2. `chmod 000` does not deny the owner.** The permission-denied branch never triggers, so a test
asserting an `EACCES` path silently exercises the success path instead and fails on the *outcome*, not
with an error. `it.skipIf(process.platform === 'win32')`. Prior art: the `case 52` chmod test in
companion-ebook-reconciler.integration.test.ts.

**3. The filesystem is case-insensitive — `a.epub` and `A.epub` cannot coexist.** A fixture that
creates both silently produces **one** file, so candidate counts come up short and the failure reads
as a logic bug. This is **not fixable by rewriting the fixture**: the scenario is unrepresentable on
NTFS. If a test's whole point is case-distinct filenames (e.g. proving a code-point sort orders `A`
before `a` where `localeCompare` ties them), it can only be skipped on win32. Prefer designing
fixtures that do not need two names differing solely by case.

**4. `rmSync(dir, { recursive: true, force: true })` in `afterAll` raises `EPERM`** when the directory
held a libSQL database. Windows refuses to delete a directory containing open handles; Linux unlinks
open files happily. **Closing the client first is NOT sufficient** — see the documented repro at
src/server/__tests__/e2e-helpers.ts:38 (`create-client → close → rmSync fails EPERM`). Make temp-dir
teardown tolerant rather than fighting it; a leaked tmpdir is cheaper than a red suite:

```ts
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps libSQL handles open; see windows-hostile-test-primitives */ }
});
```

**Separately and already known:** `path.join()` yields backslashes on Windows. Never assert a
hardcoded-separator path — normalize the actual with `.split('\\').join('/')`, or use
`expect.stringContaining()`. Production code that persists paths (DB, API responses) normalizes to
POSIX because the app runs in Docker.

## max-lines-counts-code-not-raw-lines

**source:** #1989
**added:** 2026-07-27
**files:** eslint.config.js, src/**/*.ts
**tags:** eslint, max-lines, file-splitting, comments

---

`max-lines` (400) and `max-lines-per-function` (150) are configured with `skipBlankLines: true,
skipComments: true` (eslint.config.js:190-191) — they count **code lines only**. Files in this repo
run 40-50% comment density, so raw size is roughly double the counted size: `validate.ts` at 809 raw
lines counts ~331 and passes the 400 cap cleanly.

Two decisions this changes:

- **Do not split a file (or decline to co-locate two concerns) because `wc -l` or the editor's line
  count approaches 400.** Measure what the rule measures. Quick check:
  `pnpm exec eslint <file> --rule '{"max-lines":["error",{"max":400,"skipBlankLines":true,"skipComments":true}]}'`
  — or just run lint and see if it fires.
- **Do not pad toward the cap either** — a heavily-commented 700-raw-line file that lints clean is
  compliant, but the cap is a ceiling, not a target; the SRP question ("does this file have one
  reason to change?") is still the real splitting criterion.

Same trap in reverse for reviews: a "this file exceeds max-lines" finding based on raw line count is
a false positive unless lint actually fires.

## vacuous-assertion-observation-points

**source:** #1992, #1993, #2002, #2012, #2017, #2020, #2032
**added:** 2026-07-28
**files:** src/**/*.test.ts, src/**/*.test.tsx
**tags:** mutation-testing, test-observability, counterfactual-verification, async-ordering

---

**An assertion is only as strong as its observation point.** The companion-EPUB slate produced this
same defect seven times in seven different media, every time with a green pre-existing test: the
observable the test watched could not see the property the test claimed to prove, so it passed
against broken production code. This is the single most repeated mistake in that slate, which is why
these live in one entry rather than seven.

**The closing step is non-negotiable: reproduce the counterfactual.** Break production exactly as
the assertion claims to prevent, and confirm the new test fails while the pre-existing ones stay
green. If the old tests also fail, the new one may be redundant. If nothing fails, the test proves
nothing — and you have just written the eighth instance of this entry.

The seven verified mechanisms, each with the observable that actually works:

**1. Issuance ≠ persistence (#2017).** A Drizzle chain mock's `where()` body executes SYNCHRONOUSLY
as the statement is built, so `where: () => { trace.push('update'); return terminus; }` records when
the write was *issued*. Drop the `await` on the calling helper and the trace order is unchanged. Gate
the terminus instead — and it must be BOTH awaitable and `.returning()`-capable (see
`guarded-transition-needs-returning-in-tx-mocks`):

```ts
const settle = () => gate.then(() => { trace.push('persisted'); });
return {
  then: (res, rej) => settle().then(() => ({ rowsAffected: 1 })).then(res, rej),
  returning: vi.fn().mockImplementation(() => settle().then(() => [{ id: 1 }])),
};
```

Then: await issuance → assert the follow-up has NOT started → release → assert it has. Two siblings
from the same review round: **call counts are order-blind** (`3 renames, 1 sweep` is identical whether
the sweep precedes or follows the loop — hold the FINAL iteration pending instead), and **hard-coded
post-state** reports the post-condition no matter when the dependent code ran (use ONE shared mutable
state object that the production write itself advances, and make the pre-condition genuinely able to
produce the failure).

**2. react-query holds the error until the retry ladder ends (#2020).** TanStack Query v5 keeps a
failed fetch in `failureReason`/`failureCount` and promotes it to `state.error` only after retries are
exhausted. A test that waits on the fetch mock's CALL COUNT asserts before the error exists and passes
for implementations that get the error path wrong — in #1963 it let both `if (isError) return null`
and an any-4xx generalisation of a 409-only rule survive. Easy to miss because `renderWithProviders`
sets `retry: false`, but a QUERY-level `retry` predicate overrides the client default. Wrong:
`await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))`. Right:
`await waitFor(() => expect(client.getQueryState(queryKeys.X(id))?.status).toBe('error'))`. Supply
`retryDelay: 0` to keep the ladder fast — it changes how long a retry waits, never whether one happens.
`failureCount` starts at 0 and the default is three retries, so `failureCount < 3` yields FOUR requests.

**3. Route-level status flattening masks guard removal (#2032).** The companion read routes collapse
every rejection into one response *on purpose* — `loadCompanionInspection` maps every non-`available`
inspection to a bare 404, and the v1 stream maps every non-`ok` open outcome to a single
`UNAVAILABLE_BODY`, since the distinction is the existence oracle the endpoint must not become.
Consequence: **a route-status assertion cannot attribute a red to a specific `src/core/epub/` guard**,
and a test written that way stays green after the guard is deleted. Three mutations verified
green-under-removal. Two observables that DO work: assert the persisted `validationCode` (poll
`GET /api/books/:id/companion-epub/state` until it settles — requires seeding a deliberately stale
`mtimeMs`/`ctimeMs`, or `isUnchanged` returns before any validation), or make the fixture valid on
every other axis so removing the guard yields a 200 rather than a differently-caused 404. Corollary:
pick the sharper observable BEFORE writing the fixture — a fixture that trips a second guard
identically is indistinguishable from one that trips the intended guard.

**4. A same-turn `stop()` test must gate PRE-lock setup (#2012).** `CompanionEbookReconciler`'s
per-book methods register their run promise in `activeBookRuns` synchronously before the first
`await`, and `stop()` drains that set — but every locked pass also re-checks `this.stopping` as its
first statement inside `withBookAdmissionLock`. So a same-turn drain test that gates a collaborator
called *inside* the lock is vacuous: the gate never fires, `stop()` resolves promptly, and the
assertion fails against CORRECT code. Park the run on its pre-lock setup instead (make
`settings.get('companionEpub')` return a deferred), which leaves the run observable only through the
`activeBookRuns` registration — precisely the property under test. The complementary 'gated in-flight'
case proves a different half; both are needed, neither substitutes for the other.

**5. Aborting a Transform discards already-pushed chunks (#1992).** `callback(err)` inside
`_transform` destroys the stream and drops chunks it had `push()`ed but whose consumer had not yet
pulled. A "N chunks reached the sink before the abort" assertion reads 0 whenever the source feeds
synchronously — under `stream.promises.pipeline` the source drains into the transform before the
sink's `for await` begins. Source-side counters lie in the other direction (a Readable buffers to
highWaterMark, 16 KiB). The transform's own running counter is the observable:
`createCountingStream(4)` fed twenty 1-byte chunks yields `bytesCounted === 5`, and the raised error
carries the same total.

**6. `@ts-expect-error` is satisfied by ANY error on the next line (#1993).** A negative type test
that supplies a WRONG VALUE for a field does not pin that field's requiredness — make the field
optional and the assignment still errors on the value, the directive stays used, and no TS2578 fires.
To pin requiredness, OMIT the field. The union analogue: instantiating one arm leaves the others
unpinned — use a plain positive assignment per arm (deleting an arm then fails TS2322) plus
`@ts-expect-error` on a cross-arm property access, and a bogus-discriminant negative to pin the closed
status set. A type-only module has no runtime surface, so none of this is judgeable by reading the
test: mutation-verify with `pnpm exec tsc --noEmit` and confirm non-zero exit. **Strip ANSI codes
before grepping tsc output** (`sed -e 's/\x1b\[[0-9;]*m//g'`) or `grep 'error TS'` silently matches
nothing. Worked example covering six mutations: `src/core/epub/result.test.ts:64-192`.

**7. Under Vitest, a dynamic import's `Object.keys()` is SOURCE order (#2002).** A module namespace in
native Node ESM is an exotic object that sorts its own string keys (ECMA-262 §10.4.6.1), so
`Object.keys(ns)` is lexicographic. Under Vitest that does not hold — `await import('./m.js')`
resolves through Vite's SSR transform to an ordinary `__vite_ssr_exports__` object, yielding the order
the `export` statements appear in the file. When pinning a module's public surface, `.sort()` before
comparing: it is ordering-agnostic and asserts exactly the property under test (the set of exports).
A source-text scan that reads the `.ts` and filters `^export` lines is legitimately in file order, so a
suite using both must keep the two orderings distinct.

Related: [[serialize-error-assertion-needs-enumerable-keys]] is the same defect in logging assertions
(folded into `serialize-error-catch-binding-tracing`); `react-query-optimistic-cancel` carries the
`invalidateQueries` instance; `migrated-db-assertions-through-drizzle` carries the ORM-vs-DDL instance.

## epub-stack-type-declaration-gaps

**source:** #1987, #1988, #1989
**added:** 2026-07-28
**files:** src/core/epub/xml.ts, src/core/epub/zip-source.ts, src/core/epub/validate.test.ts
**tags:** cheerio, htmlparser2, unzipper, type-declarations, pnpm, epub

---

Both third-party libraries behind the EPUB reader ship type declarations that are wrong or absent in
load-bearing ways. In both cases the fix is the same shape: **declare the true shape locally, do not
add the transitive dependency to `package.json` just to name a type.**

**1. cheerio does not re-export `domhandler`'s node types (#1987).** `cheerio@1.2.0` re-exports only
`Cheerio`, `CheerioAPI`, `CheerioOptions`, and `HTMLParser2Options` — not `Element`/`AnyNode`.
`domhandler` is a transitive dependency only, so under pnpm's strict layout
`import type { Element } from 'domhandler'` fails TS2307 at typecheck and ERR_MODULE_NOT_FOUND under
tsx. Derive it from cheerio's own API instead:

```ts
import type { Cheerio, CheerioAPI } from 'cheerio';
type RootChildren = ReturnType<ReturnType<CheerioAPI['root']>['children']>;
export type EpubXmlElement = RootChildren extends Cheerio<infer T> ? T : never;
```

The derived type carries `.name: string` and `.attribs: Record<string, string>`. Shipped at
`src/core/epub/xml.ts:37-39`. The other cheerio consumers in the tree (`newznab.ts`, `torznab.ts`,
`abb.ts`) sidestep this by never naming an element type, so this was the first site that needed it.

**2. `@types/unzipper` misdescribes `Open.custom` in two ways (#1988).** Pinned `unzipper@0.12.3` with
`@types/unzipper@0.10.11`:

- **`stream` takes an OPTIONAL length, and `undefined` means 'to end of file'.** The types declare
  `stream: (offset: number, length: number) => Readable`, but `lib/Open/directory.js` calls it with
  ONE argument for every structural read — the tail (`:96`), the ZIP64 locator (`:132`), the ZIP64
  record (`:53`), and the whole central directory (`:149`). Only per-entry reads pass a length. The
  built-in sources spell the semantics as `const end = length ? offset + length : undefined`. A source
  written to the two-parameter declaration alone fails on the very first read.
- **`Open.custom` accepts a second `options` argument the types omit.** It is forwarded straight to
  the directory parser, which reads `options.tailSize` — default **80 bytes**. 80 bytes cannot reach
  the EOCD of any container with a trailing ZIP comment, so `tailSize` must be passed explicitly for
  EPUBs.

Declare the true shapes locally and assign: `unzipper.Open.custom as OpenCustom` type-checks (a
function with fewer parameters is assignable to one with more), so no `as any` is needed and
`@typescript-eslint/no-explicit-any` stays satisfied. See `ZipPositionalSource` / `OpenCustom` in
`src/core/epub/zip-source.ts`; the one-argument shape is pinned in `zip-source.test.ts` under 'the
stream() contract', and the 80-byte default is pinned by asserting `Open.file()` rejects every
long-comment fixture that our `tailSize`-pinned path opens.

**3. Spying on which entries were read (#1989).** unzipper builds each central-directory member's
`stream`/`buffer` as an **own function property** on the member object
(`unzipper@0.12.3/lib/Open/directory.js:222-232`), not on a prototype. So a `vi.mock('unzipper')`
factory that delegates to the real `Open.custom` can wrap them in place —
`` const original = file.stream.bind(file); file.stream = (...args) => { seen.push(file.path); return original(...args); } `` —
and record exactly which members were inflated, in order, while the test stays a genuine end-to-end
run against a real archive on disk. Use this whenever the assertion is about *which* entries a
pipeline read (`validate.test.ts` pins that the ZIP-encryption-bit scan decides before any entry
stream opens, and that `validateEpub` never touches the cover). Type the wrapper against a local
structural alias, not `@types/unzipper`'s `CentralDirectory`/`File` — those need an
`as unknown as` double cast and misdeclare the source contract anyway. Exception: when the point is to
*inject* a failing stream rather than observe a real one, the fully-synthetic
`mockResolvedValueOnce({ files: [...] })` shape remains the right tool.

**Staleness note:** all three facts are pinned to specific versions. On a `cheerio` / `unzipper` /
`@types/unzipper` bump, re-verify rather than assuming.

## htmlparser2-no-attribute-normalisation

**source:** #1990
**added:** 2026-07-28
**files:** src/core/epub/xml.ts, src/core/epub/extract.ts
**tags:** cheerio, htmlparser2, xml, attribute-values, token-lists, epub

---

XML 1.0 §3.3.3 requires an XML processor to replace tab (#x9), LF (#xA), and CR (#xD) inside an
attribute value with a space before the application sees it. **htmlparser2 — the parser behind
`cheerio.load(..., { xmlMode: true })` — does not do this**; it stores the raw source text. Measured
on the pinned stack: `<nav epub:type="toc\tlandmarks" properties="nav\nscripted"/>` yields
`attribs['epub:type'] === 'toc\tlandmarks'` and `attribs.properties === 'nav\nscripted'`, separators
intact.

Two consequences for whitespace-separated token attributes (`properties`, `epub:type`, `rel`, `class`):

1. **Split on the full XML whitespace class, never on a single space.** `value.split(' ')` looks
   correct against most real documents and silently drops conforming tab- or newline-separated tokens.
   `hasToken` in `src/core/epub/extract.ts` splits on `/[\t\n\f\r ]+/` and is the one home for that
   decision across all three of its call sites.
2. **The behaviour is observable end-to-end**, so pin it with an integration test rather than only a
   unit test of the predicate — a conforming parser would have folded the separator and made it
   untestable from outside. `extract.test.ts` carries a tab/LF/CR/FF table that fails on every row if
   the split is narrowed.

More generally: **this parser is deliberately lenient and skips several conformance behaviours the XML
spec mandates — measure a spec-derived assumption against the parser before building code or tests on
it.** The same leniency is already load-bearing elsewhere: htmlparser2 never throws on malformed input,
silently repairing unclosed and mismatched tags, which is why `malformed_xml` in
`src/core/epub/xml.ts:218-243` is defined as "no usable document" rather than "not well-formed".

## migrated-db-assertions-through-drizzle

**source:** #1957
**added:** 2026-07-28
**files:** src/db/**/*.integration.test.ts
**tags:** drizzle, libsql, sqlite, migrations, integration-tests, error-handling

---

An integration test that runs against a real migrated database *looks* like schema-level coverage.
Two Drizzle behaviours mean it often isn't.

**1. The constraint message is on `.cause`, not `.message` (#1957).** Drizzle (drizzle-orm@0.45.2,
`@libsql/client`) wraps every driver failure in a `DrizzleQueryError` whose own `.message` is only
`Failed query: <sql>\nparams: <bound values>`. The SQLite message — `CHECK constraint failed: <name>`,
`NOT NULL constraint failed: <table>.<col>`, `UNIQUE constraint failed: …`,
`FOREIGN KEY constraint failed` — is on `.cause`. So
`await expect(db.run(...)).rejects.toThrow(/CHECK constraint failed/)` silently never matches, and a
suite written that way fails wholesale even when the constraints work perfectly. Flatten the chain:

```ts
let current: unknown = caught;
const parts: string[] = [];
while (current instanceof Error) { parts.push(current.message); current = current.cause; }
return parts.join(' | ');
```

(`rejectionMessage()` in `src/db/companion-ebooks-schema.integration.test.ts`.) The one-level shorthand
`String((err as Error).cause ?? err)` is also in use at
`src/server/services/book.service.dedup.integration.test.ts:475`; production does the same via
`error.cause?.message` in `src/server/services/book-dedup.ts:26-27` and
`src/server/jobs/enrichment.ts:76-77`.

**2. Drizzle INLINES schema-level column defaults into the INSERT (#1957).** It names the column and
binds the default value rather than omitting the column and letting the database apply its DDL
default. So `db.insert(t).values({ /* column omitted */ })` followed by `expect(stored.col).toBe(v)`
does NOT pin the migration's `DEFAULT v`. Measured on `companion_ebooks.candidate_count`: deleting
its `DEFAULT 0` from the generated migration left that test green and failed only the raw-SQL test
(1 failed | 61 passed). Pin the two halves separately:

- **ORM half** — typed insert omitting the column, asserting the stored value; plus
  `t.col.hasDefault === true` and an `$inferInsert` object literal omitting the field (removing
  `.default()` from `schema.ts` then makes the column required and fails `pnpm typecheck`).
- **DB half** — raw SQL naming neither the column nor a value:
  `` db.run(sql`INSERT INTO companion_ebooks (book_id, status) VALUES (${bookId}, 'none')`) ``, then
  assert the read-back.

`` sql`(unixepoch())` `` defaults have the same blind spot, so `created_at`/`updated_at` tests that only
go through the ORM don't pin the DDL default either.

**The general rule:** when validating any schema contract against a migrated DB, ask whether the ORM
could have satisfied the assertion on its own before the statement reached SQLite. The cheap way to
find out is to break the contract in the generated migration and confirm the test actually goes red.
Related: `drizzle-sqlite-text-enum-no-db-check` (which constraints Drizzle does and doesn't emit),
`vacuous-assertion-observation-points` (the same counterfactual discipline, other media).

## libsql-transactions-serialized-at-the-connection

**source:** #1959
**added:** 2026-07-28
**files:** src/db/client.ts, src/db/serial-transactions.ts, src/server/services/**
**tags:** libsql, drizzle, transactions, concurrency, sqlite-busy

---

**The fact.** A single `@libsql/client` connection — which is what `createDb` (`src/db/client.ts`)
hands out, one per process — permits only ONE transaction at a time. Two overlapping raw
`db.transaction(...)` calls on the shared handle do not queue: the later one rejects with
`LibsqlError: SQLITE_BUSY: database is locked`. This is a connection-level constraint rather than lock
contention, so no `busy_timeout` or retry-on-busy setting avoids it. Verified empirically on
@libsql/client 0.17.3 / libsql 0.5.29 / drizzle-orm 0.45.2: four concurrent `db.transaction` calls
each doing select → await → insert yield 1 fulfilled and 3 `SQLITE_BUSY` rejections.

**What to do about it — do NOT hand-roll a serialization lane.** `createDb` monkey-patches
`db.transaction` to route through `runSerializedTransaction` (`src/db/serial-transactions.ts:69`), so
**the exclusion is enforced by the connection itself, automatically, for every service** — concurrent
per-item passes queue with no caller opt-in, and so does any other service's transaction. The
reconciler documents exactly this at `companion-ebook-reconciler.ts:594` ("Nothing here serializes the
transaction, deliberately"). A per-service promise-chain lane on top of that is redundant.

Two things that follow:

- **Nesting throws.** Opening `db.transaction` while a transaction is already open on that connection
  rejects with `NestedTransactionError` — use the `tx` handle the callback receives, or
  `tx.transaction()` for a savepoint. The tracking is a Set, not a single value, because a transaction
  on connection A may legitimately contain one on connection B.
- **Keep the surrounding work outside the transaction.** Serialization applies to the transaction
  only; discovery, validation, and pre-scan reads stay concurrent under whatever `Semaphore` bound the
  service uses. Widening the transaction throws away the concurrency the bound exists to provide.

**Diagnosis note (still useful for any un-serialized path).** A `SQLITE_BUSY` rejection is raised
inside the losing task, so a service that catches per-item errors reports it as an ordinary item
failure. The symptom presents as nondeterministic missing writes, not an obvious driver error — reach
for this explanation whenever a newly-concurrent write path starts dropping records. Related:
`libsql-foreign-keys-on-by-default`, `guarded-transition-needs-returning-in-tx-mocks`.

## filehandle-stream-close-ownership

**source:** #1974
**added:** 2026-07-28
**files:** src/server/routes/companion-ebook.ts
**tags:** node-fs, filehandle, streams, fastify

---

A FileHandle-backed `fs.ReadStream` (from `filehandle.createReadStream()`) subscribes to the
FileHandle's own `close` event, and `ReadStream._destroy` closes the handle unconditionally — it is
**not** gated on `autoClose`. So an application-owned `handle.close()` destroys the stream, which
closes the handle a SECOND time. Measured on Node v24.18.0: `handle.close()` as the closer → 2
`close()` calls on both the `end` and the abort path; `stream.destroy()` as the closer → exactly 1 on
both, fd released.

When you need exactly-once cleanup for a streamed FileHandle, create the stream with
`autoClose: false` (so nothing tears down implicitly and teardown happens iff your closer runs) and
make the idempotent closer call `stream.destroy()`, NOT `handle.close()`. Reference implementation and
tests: `streamCompanionEbook` in `src/server/routes/companion-ebook.ts`, pinned by
`companion-ebook.test.ts` ('closes the handle exactly once on success') and the real-socket
`companion-ebook-stream.test.ts` (client abort, post-headers read failure).

## rate-limit-gate-fails-open-on-nan-window

**source:** #1944
**added:** 2026-07-28
**files:** src/server/services/metadata.service.ts, src/core/metadata/**
**tags:** rate-limiting, retry-after, metadata-providers, rfc-9110, falsy-guard

---

A backoff/deadline value derived from an external header must be normalized to a FINITE, non-negative
number **at the adapter boundary**, because the consumer's guard fails OPEN on a non-finite one.

`MetadataService.setRateLimited` stores `Date.now() + durationMs` in `rateLimitUntil`. `isRateLimited`
starts with `const until = this.rateLimitUntil.get(name); if (!until) return false;`. **`NaN` is
falsy**, so a NaN window short-circuits right there — the gate is **dead, not mis-timed**, and the
provider is retried on every subsequent call after it asked us to stop. The mirror case is `Infinity`,
which yields a deadline that never expires and suppresses the provider for the life of the process. So
the finiteness check belongs on the arithmetic PRODUCT, not the operand: `1e306` written out in digits
is a perfectly finite Number that overflows only after `× 1000`.

The usual source of a NaN window is `Retry-After`. **RFC 9110 permits BOTH delay-seconds and an
HTTP-date**, so `parseInt(header, 10) * 1000` yields NaN for the date form — which real servers send.
`parseInt` also silently accepts trailing garbage (`'120abc'` → `120000`); prefer an all-digit test
(`/^[+-]?\d+$/`) plus a `Date.parse` fallback, with a finite default for everything else.

**Don't rely on the log to catch this:** `setRateLimited` warns `{ provider, retryAfterMs }` and pino
serialises NaN to `null`, so the one operator-visible signal reads as a *missing* field rather than a
broken one.

Reference implementation: `parseRetryAfterMs` in `src/core/metadata/retry-after.ts` — the single
Retry-After interpretation home for the provider side; Audnexus's three 429 arms (#1944) and
Audible's two (#1948) all route through it. (The client's `parseRetryAfterMs` in
`src/client/lib/api/client.ts` is deliberately separate — it answers "may the UI show a retry hint"
with `number | undefined`, not "close the gate with a finite window"; don't couple them.) Tests:
`audnexus.test.ts` '429 retry-window normalization across both helper paths', `audible.test.ts` '429
retry-window normalization across both request paths'; service-side pins in
`metadata.service.test.ts` (finite closes the gate / NaN leaves it open). For HTTP-date assertions
freeze only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`) — full fake timers stall MSW and the
native `AbortSignal.timeout` inside `fetchWithTimeout` (see
`abortsignal-timeout-native-timer-retry-tests`).

**Scope note:** this is about deadline/threshold values reaching a falsy-guarded gate. It is NOT a
mandate to sweep every external numeric field through a Zod NaN guard — that was proposed in #1940
and closed not-planned.

## identity-reads-use-book-identifiers

**source:** #1916
**added:** 2026-07-28
**files:** src/client/hooks/useLibrary.ts, src/client/lib/helpers.ts
**tags:** react-query, pagination, duplicate-detection, api-contract

---

**Never use `GET /api/books` as a client-side ownership or duplicate-detection source.** The route
applies `limit ?? DEFAULT_LIMITS.books` (120) ordered created-at-descending, so on a library larger
than one page the oldest rows — the ones most likely to be the owned incumbent — are invisible to the
check. **The bug never reproduces on a small dev library**, which is what makes it worth an entry
rather than a code comment.

**As of #1951 the `api.getBooks()` wrapper no longer exists** — it was deleted once it had no client
callers left, so the capped endpoint is not reachable from `src/client` at all and the guard is now
structural. `src/client/lib/api/books.ts` carries a comment on `booksApi` explaining why it is absent.
**Do not re-add it.** The server route stays live because it is part of the v1 API contract; that is
not a reason to reintroduce a client wrapper for it.

The canonical client ownership source is `useBookIdentifiers()` (`src/client/hooks/useLibrary.ts`) →
`GET /api/books/identifiers` → `BookListService.getIdentifiers()`: no `where`, no `limit`, no
`ORDER BY`, projecting `{ id, asin, title, authorName, authorSlug }`. Every ownership surface reads it
(SearchResults, AuthorPage, BookEditModal, ManualImportPage) and matches via
`findLibraryMatch`/`isBookInLibrary` in `src/client/lib/helpers.ts`.

Two notes when extending it:

- **`BookIdentifier.id` is REQUIRED, not optional.** Consumers that render a link to the owned book
  read `match.entry.id`; an optional field would let that degrade to `null` with no type error. Adding
  a required field ripples into every hand-built typed fixture — run `pnpm typecheck` to enumerate,
  don't grep (untyped `vi.fn()` fixtures will NOT fail, so their passing is not evidence the change
  landed).
- **Do NOT add an `ORDER BY` to `getIdentifiers()`.** `findLibraryMatch` is order-independent by
  construction (exact-ASIN scan precedes the title-identity fallback), and an ordering would imply a
  guarantee the matcher must not depend on.

Ownership loading/failure is deliberately fail-open (undefined → Add shown); the server's
409-with-incumbent verdict is the real duplicate backstop, so a missing hint can never create a
duplicate.

## shared-test-double-defaults-ripple

**source:** #1960, #1975
**added:** 2026-07-28
**files:** src/server/__tests__/helpers.ts
**tags:** vitest, test-helpers, fastify-routes, fire-and-forget, mocking

---

This repo's shared server-test doubles have defaults that bite suites which did not change.

**1. `createMockServices` defaults every unconfigured method to a REJECTING `vi.fn()` (#1960).**
`createMockServices` / `resetMockServices` (`src/server/__tests__/helpers.ts:199-263`) give every
unconfigured service method `vi.fn().mockRejectedValue(new Error('mock not configured: <svc>.<method>'))`.
That default is deliberate and good — an awaited-but-unconfigured method fails loudly instead of
returning `undefined`. But it means **adding a new service call to a SHARED route retroactively changes
the behaviour of every pre-existing test in that route's suite**, in one of two ways:

- **Awaited read → unexplained 500.** Adding `await settingsService.get('library')` ahead of the write
  in `PUT /api/settings` made every existing PUT test return 500. Fix: add a category-resolving default
  in `beforeEach`, AFTER `resetMockServices(services)` (which re-applies the rejecting default):
  `(services.settings.get as Mock).mockImplementation((cat: string) => Promise.resolve(mockSettings[cat as keyof typeof mockSettings]))`.
- **Fire-and-forget call → an extra `warn` record.** `fireAndForget`
  (`src/server/utils/fire-and-forget.ts:9-10`) catches the rejection and logs it at `warn`. Any test
  asserting `expect(mockLog.spies.warn).toHaveBeenCalledTimes(1)` — the route-boundary-record
  convention — now sees 2. Fix: `mockResolvedValue(undefined)` for the new method in `beforeEach`;
  keep the rejection opt-in for the isolation test that actually wants it.

Mode 2 is the harder diagnosis: the failing assertion is about a completely unrelated log record, and
the error message says nothing about the new call. **Checklist when adding a service call to a shared
route:** grep that route's suite for (a) warn/error call-count assertions and (b) tests asserting a 2xx
without configuring the new dependency.

**2. `createMockDb`'s single `select` stub must be split by PROJECTION, not call order (#1975).** When
a route issues two `db.select` calls per request, discriminate them by the projection argument:
`resolveByPublicId` (`src/server/utils/public-id.ts:47`) calls `db.select({ id: t.id })` with a
projection; repository free functions like `findCompanionEbook` call `x.select()` with none.

```ts
db.select.mockImplementation((projection?: unknown) =>
  projection === undefined ? mockDbChain([observationRow]) : mockDbChain([{ id: rowid }]),
);
```

This is stateless, so it holds however many requests a single test issues. Both order-based
alternatives break in practice: `mockReturnValueOnce` queues survive `vi.clearAllMocks()` and leak into
the next test (`vitest-clearallmocks-once-queue`), and a call-index counter desynchronises the moment a
test sends a second request — which is every concurrency/saturation test. Reference: `setDb()` in
`src/server/routes/v1/companion-ebook.test.ts`, used by tests issuing up to 5 concurrent requests.
Applies to any v1 route that resolves a publicId and then reads a second table.
