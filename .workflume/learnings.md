<!--
TAG VOCABULARY — pick from this list; do not mint new tags casually.

Tags are matched against the CONCEPTS IN AN ISSUE, not against each other, so the test for a
new tag is "would someone plausibly type this word when describing the problem?" A rare tag is
fine (`xxe`, `dns`, `csrf` are each used once and each is a word an issue would contain). A tag
nobody would type is dead weight no matter how accurate it is.

Do NOT tag with: internal identifiers (`parseFolderStructure`, `resolveBookQualityInputs`),
coined phrases (`fold-lockstep`, `live-corpus-sweep`), editorial flavor (`silent-null`,
`evidence-discipline`, `gotcha`), or words too generic to select on (`testing`, `db`, `async`,
`validation`). Put those in the body, where they are searchable prose.

Max 5 tags per entry. Prefer the specific stack/domain tag over a generic testing one.

  stack     vitest drizzle zod fastify sqlite libsql react react-query react-hook-form
            typescript eslint node-fs undici sse epub xml css z-index useEffect
            useLayoutEffect dns csrf auth
  media     ffmpeg ffprobe music-metadata audio-tags round-trip
  domain    settings migrations import-staging title-matching search-ladder indexers
            metadata-providers filesystem logging folder-parsing cron caching
  testing   test-doubles test-fixtures test-observability mutation-testing e2e xxe
  platform  windows cancellation audit-sweep

Audited 2026-08-08: 264 tags -> 48. Rationale in .scratch/learnings-audit-2026-08-08.md.
-->

## sse-inject-helper-gap

**source:** #755
**added:** 2026-05-04
**files:** src/server/__tests__/search-grab-flow.e2e.test.ts, src/server/__tests__/sse-helpers.ts
**tags:** sse, fastify, e2e

---

Fastify's `app.inject()` cannot exercise SSE/streaming routes because Fastify hijacks the response on those handlers — the injection API never sees the streamed body. When migrating E2E tests from a non-streaming endpoint to an SSE replacement, the available workarounds are (a) call the underlying service method directly (preserves MSW/mocking assertions but bypasses the route handler) or (b) bind a real ephemeral port and parse the SSE event stream from a real HTTP client.

Observed in `src/server/__tests__/e2e-helpers.ts` during the #755 migration: three tests originally hit `GET /api/search?q=...` via `app.inject()` and were ported to call `e2e.services.indexer.searchAll()` directly against `/api/search/stream`. The route-layer coverage was lost as a tradeoff. See the explanatory comment in `src/server/__tests__/search-grab-flow.e2e.test.ts` (where `GET /api/search` is noted as retired in favor of the SSE surface, and the indexer service is exercised directly so the MSW capture still verifies the outgoing query params); `src/server/__tests__/sse-helpers.ts` documents why `app.inject()` hangs on `reply.hijack()` routes.

For true end-to-end SSE coverage in this harness, that helper now exists: `fetchSseEvents` in `src/server/__tests__/sse-helpers.ts` binds a real ephemeral port, opens a streaming HTTP request, and accumulates SSE `data:` frames — use it instead of re-deriving the pattern. The direct-service-call bypass (now `e2e.services.indexerSearch.searchAll()`) remains valid where MSW capture of outgoing query params is the point and route-layer coverage is an accepted tradeoff; document the bypass in the test either way.

## edit-mode-id-injection-on-form-test

**source:** #827
**added:** 2026-05-04
**files:** src/client/hooks/useConnectionTest.ts, src/client/hooks/useCrudSettings.ts
**tags:** react-hook-form, settings, react

---

When a settings form runs a server-side test (`onFormTest`) while editing an existing entity, it must send the entity id alongside the form data. The server uses that id to resolve sentinel placeholders for secret fields the client never sees in plaintext. Without it, the test runs against a partial payload and the server can't reconstruct the real credentials.

The injection is lifted into the hooks (shipped as #1057): `useConnectionTest` accepts an `entityId` and merges `{ ...data, id: entityId }` inside the test call, and `useCrudSettings` exposes `injectEditingId: true` to wire it. New edit forms should pass `injectEditingId` rather than hand-spreading the id in the card — the settings pages already do this; there are no remaining hand-rolled spreads.

Known exception: the import-list form does NOT need this — it routes through a saved-id test endpoint instead of the generic test-with-payload endpoint (`ImportListCard` uses no `injectEditingId`). Don't 'normalize' it into the injection pattern; that would break it. Originally surfaced in #827.

## ts-diagnostic-offsets-for-codemods

**source:** #940
**added:** 2026-05-04
**tags:** typescript

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
**files:** src/server/services/search-pipeline.test.ts
**tags:** typescript, test-fixtures

---

Fixture builders that accept `Partial<T>` and rely on callers passing `{ key: undefined }` to strip default fields break under `exactOptionalPropertyTypes` (eopt). TypeScript rejects object literals containing explicit `undefined` for optional properties when eopt is enabled.

Three viable patterns when you encounter or write such a builder:

1. **Destructure-and-omit at the call site** — instead of `makeResult({ score: undefined })`, build the override object without the key. Works but pushes complexity to every caller.
2. **Custom overrides type on the builder** — type the parameter as `{ [K in keyof T]?: T[K] | undefined }` instead of `Partial<T>`. Allows explicit `undefined` literals; localizes the workaround to the builder definition.
3. **Explicit-undefined-stripping helper** — a shared utility that accepts overrides including `undefined` and applies them with key deletion semantics.

First observed in `src/server/services/search-pipeline.test.ts` (`makeResult`) during #938. Option 2 (custom mapped type) is the adopted in-repo standard — see `MakeResultOverrides` at `search-pipeline.test.ts:45-47`. It keeps call sites idiomatic; reach for a centralized helper only if many builders end up sharing the same shape.

When reviewing or adding a fixture builder under eopt: check whether callers need to strip defaults; if so, do not use bare `Partial<T>` for the overrides parameter.

## lookup-callback-dual-shape

**source:** #966
**added:** 2026-05-04
**files:** src/core/utils/network-service.ts
**tags:** undici, dns

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
**files:** src/server/fastify-options.ts, src/server/__tests__/helpers.ts
**tags:** fastify

---

Fastify 5 defaults `routerOptions.maxParamLength` to 100 chars per dynamic path parameter. Anything longer (signed capability tokens, base64url payloads, content hashes, JWT-shaped strings) is rejected before the route matches. On fastify < 5.11 that rejection is a generic 404 'Route not found' with no warning, no log, and no validation error; fastify 5.11+ (find-my-way 9.7+) returns an explicit 414 URI Too Long instead, which is diagnosable — but either way the handler is never invoked; throws and console.logs inside it do not fire, and the cap still needs bumping for long-token routes.

**Pattern:** When introducing a route that takes variable-length encoded data in a path parameter, bump the cap on the Fastify constructor: `Fastify({ routerOptions: { maxParamLength: 2048 } })` (or whatever the real upper bound is). The production options live in `buildFastifyOptions()` (`src/server/fastify-options.ts`), consumed by `src/server/index.ts`. Mirror the change in any test-app constructor (`src/server/__tests__/helpers.ts:createTestApp` and per-test ad-hoc instances) — the cap is per-instance, not a runtime config.

**Why this is non-obvious:** the 404 looks like a routing bug. Common debugging instincts (add a log to the handler, throw inside the handler, check Zod validation, check the type provider) all return the same 404 because the request never reaches the handler. The fix is not in your code — it's in the constructor option.

**The deprecated form:** `Fastify({ maxParamLength: 2048 })` at the top level still works in Fastify 5 but emits FSTDEP022 and is removed in Fastify 6. Always use `routerOptions.maxParamLength`.

**Where to keep this in mind:** any feature that encodes data into the URL path — signed tokens, hashes, encoded ids, capability strings. Reference: `src/server/fastify-options.ts` (executable-proven by `fastify-options.test.ts`'s default-cap 414 repro) and `src/server/__tests__/helpers.ts` after #1017.

## drizzle-migration-prompt-hang

**source:** #1133
**added:** 2026-05-18
**files:** drizzle/, src/db/schema.ts
**tags:** drizzle, migrations

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
**tags:** zod, indexers

---

Request-body schemas for API-impersonation/compatibility surfaces (narratorr's Prowlarr/Readarr-compat routes in src/server/routes/prowlarr-compat.ts) must use Zod's default `.strip()` (i.e. NOT `.strict()`), and must additionally strip the impersonated product's echo-only fields out of any service-facing `settings` they translate to. Rationale: the impersonated product controls the payload and adds fields over time; `.strict()` 400s on every unanticipated field and breaks the integration, while `.strip()` silently drops unknown top-level keys before handler code runs (handlers read only named fields → no mass-assignment risk). `.passthrough()` is wrong — it carries attacker-controllable keys forward. Do NOT 'fix' a break by allowlisting the specific new field into the schema — that is whack-a-mole and has already regressed this exact surface twice (#733 introduced `.strict()`; an earlier `enableAutomaticSearch`/`enableInteractiveSearch` break was bandaged by allowlist; #1198 broke again on Prowlarr's `categories`/`minimumSeeders`/`seedCriteria.*`). Echo-only fields must also be filtered before they reach the strict per-adapter settings schemas (src/shared/schemas/indexer.ts `torznabSettingsSchema`/`newznabSettingsSchema`), which legitimately stay strict because narratorr owns that contract. Keep the strict instinct for request validators you own; relax it only for surfaces impersonating an external API. See src/server/utils/readarr-echo-fields.ts for the shared strip helper used by both the route and IndexerService.createOrUpsertProwlarr.

## drizzle-sqlite-text-enum-no-db-check

**source:** #1129, #1957
**added:** 2026-05-15
**files:** src/db/schema.ts
**tags:** drizzle, sqlite, migrations

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
**tags:** eslint

---

In this repo, logging a validation/parse failure from inside a React component's render body has two hard lint constraints: (1) eslint `no-console` allows only `console.warn`/`console.error` in client code (so `console.debug`/`log`/`info` fail lint; server/core have no-console off), and (2) `react-hooks/refs` forbids reading/mutating `ref.current` during render, so a `useRef`-based once-guard accessed in the render body fails too. The working once-guard is a `useEffect` keyed on the data identity: `useEffect(() => { const r = schema.safeParse(data); if (!r.success) console.warn('...', r.error); }, [data])` — it fires once per distinct payload (not per re-render) and keeps the warn out of render. See src/client/lib/eventReasonFormatters.tsx (HeldForReviewDetails) for the implementation and src/client/lib/sse/safe-parse-event.ts for the non-render warn precedent. Note: specs that recommend `console.debug` for render-body signals are not directly implementable here — translate them to the effect-keyed warn.

## import-cleanup-marker-aware-fs-mock

**source:** #1336  
**added:** 2026-06-12  
**files:** src/server/services/import.service.test.ts  
**tags:** vitest, test-doubles, import-staging

---

After #1336, the import failure-cleanup paths (`handleImportFailure` in import-steps.ts, `stagedAudioReplace`'s catch in import-staging.ts) decide whether to preserve `.import-bak` + the commit-pending marker by STATTING the marker on disk (`markerPresent(targetPath, log)`), not by the thrown error's type. Consequence for tests: any mocked `node:fs/promises` with a blanket `stat.mockResolvedValue({...})` makes `${targetPath}.import-commit-pending` read as present, so `preserveBackup` becomes true on every failure — silently flipping deletion assertions AND pushing `prepareImportSiblings` into its recovery branch. In mocked-fs import suites, default the marker stat to ENOENT (`mockImplementation` that rejects for paths ending in `.import-commit-pending`, resolves a directory otherwise) and only override to resolve in tests that specifically assert marker-present preservation. `markerPresent` also fails toward preservation on a non-ENOENT stat error, so a marker stat that rejects with e.g. EACCES is treated as present. Real-tmpdir suites (staged-audio-replace.test.ts) need no special handling — there's no marker on disk unless the test stages one. The marker-aware mock idiom is already in service throughout import.service.test.ts — copy it from there.

## folder-parser-dash-split-before-cleanname

**source:** #1331  
**added:** 2026-06-12  
**files:** src/server/utils/folder-parsing.ts  
**tags:** folder-parsing

---

`parseFolderStructure` in src/server/utils/folder-parsing.ts splits `Author - Title` shapes on the raw input (tryAuthorTitleForms) BEFORE cleanName runs, then cleans each half independently. Consequence: `cleanName(wholeString)` output does NOT equal `parseFolderStructure([wholeString]).title` for dash-bearing names — reason about parser behavior through the end-to-end parser, never the component cleaner. Historical instance: pre-#1332, a bracket-only right segment (`[tag]`) cleaned to '' and cleanNameWithTrace's raw fallback re-injected the RAW bracket as the title. #1332 guarded that fallback for pure release-tag inputs (`current || (isPureReleaseTagBracket(name) ? '' : name.trim())`), so the pure-tag case no longer leaks — but the fallback still re-injects raw text for any other input that cleans to empty, and the split-before-clean structure is unchanged. When fixing parser behavior, validate expectations end-to-end via `pnpm exec tsx` against `parseFolderStructure`, and diff against the relevant historical commit (e.g. `git show <merge>^:...`) to get true pre-fix behavior — don't infer it from the component cleaner or trust a spec's 'pre-fix was X' claim. This bit #1331: the spec's expected 'Wool Omnibus -' was the cleanName-of-whole value, not the actual pre-#1316 parser output.

## vimock-barrel-replace-drops-named-exports

**source:** #1404, #1963  
**added:** 2026-06-12  
**files:** src/client/hooks/useCrudSettings.ts, src/client/pages/book/BookPage.test.tsx  
**tags:** vitest, react-query

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

**The `vi.mock` family — nothing here is typechecked.** A mock factory's return value is unconstrained by `@types/*`, and this repo's doubles use `inject<T>()` / `as unknown as T`, which erase property checking. Five ways that drifts, each silent until runtime and each in its own entry because they bite different files: the factory does not intercept a same-module call ([[esm-same-module-vi-mock-bypass]]); it omits a schema table and crashes an unrelated suite at import ([[drizzle-schema-toplevel-deref-breaks-partial-mocks]]); it replaces a barrel and drops named exports, or preserves one and leaks real network calls ([[vimock-barrel-replace-drops-named-exports]]); its implementation is an arrow where production uses `new` ([[vifn-arrow-not-constructable]]); or its return SHAPE goes stale behind a compatibility wrapper ([[compat-wrapper-hides-stale-test-doubles]]). Deliberately not merged: the five have disjoint file scopes, so one entry would inject all of it whenever any one file is touched.

## marker-recovery-is-additive

**source:** #1418  
**added:** 2026-06-12  
**files:** src/server/utils/import-staging.ts  
**tags:** import-staging

---

The commit-pending recovery sequence (recoverInterruptedBackup in src/server/utils/import-staging.ts, reached via recoverInterruptedCommit in src/server/utils/recover-interrupted-commit.ts) is ADDITIVE: it renames files from `<target>.import-bak` into the target (overwriting only same-named files), then clears the backup and marker. It never deletes existing target files, so the top-level audio count after recovery is always >= the count before. Do not reason about recovery as 'swapping in' or 'replacing' the target's file set — that's what the #1287 staged swap (stagedAudioReplace/commitStagedImport) does, not bare recovery. Practical effect: a guard that re-checks a minimum-file-count AFTER recovery (e.g. the #1418 merge >=2 re-validation) is correct defense-in-depth but cannot be triggered by the real recovery flow when a pre-recovery validation already enforced that minimum; test such guards by simulating divergent pre/post-recovery readdir results in a mocked-fs suite rather than trying to arrange a real-tmpdir shrink.

## shared-test-double-defaults

**source:** #1470, #1960, #1975, #2074
**added:** 2026-07-28
**files:** src/server/__tests__/helpers.ts, src/server/routes/**/*.test.ts, src/shared/schemas/settings/create-mock-settings.fixtures.ts
**tags:** test-doubles, vitest, drizzle, test-fixtures

---

**A shared test double's default value IS production behaviour for every suite that uses it.** Four
ways that bites here, all of them silent: the suite that breaks is usually not the suite that changed.

**1. `mockDbChain()` returns `[]`, so a guarded write never matches (#2074).**
`mockDbChain(result = [])` (`src/server/__tests__/helpers.ts:248`) hands back an EMPTY array by
default. A guarded write — `db.update(t).set(s).where(and(eq(id), <precondition>)).returning({ id })`
branching on `rows.length === 0` — therefore ALWAYS takes the not-matched arm under a no-arg
`db.update.mockReturnValue(mockDbChain())`. Invisible whenever the production code's success
bookkeeping (counters, `log.info`) runs regardless of the guard's outcome.

`enrichment.ts` before #2069 was the worst version: `applyScalarWrite` returned a boolean meaning "a
unique-constraint race was recovered, `continue`", NOT "the write applied" — its own doc comment read
*"Returns false on the normal path (including a scalar stale-drop) so the caller falls through to the
success log."* The zero-row case logged at `debug` and returned `false`, structurally
indistinguishable from success, and the caller then ran `enrichedCount++` plus `'Book enriched
successfully'`. 36 tests asserted that log line against a write that had matched nothing; all 36 went
red once the guard's outcome gated the bookkeeping.

- A test whose subject is the SUCCESS path of a guarded write must seed a matching row: `mockDbChain([{ id: 1 }])`.
- Reserve `mockDbChain([])` for tests where the stale drop IS the assertion, and write the `[]` explicitly so the intent is on the page (`enrichment.test.ts:1168+`).
- When a write GAINS a precondition, grep the suite for no-arg `mockDbChain()` on `update`/`delete` stubs in the same change — the default silently flips every one of those to the drop path. Latent today in `discovery.service.test.ts`, `secret-migration.test.ts`, `blacklist.service.test.ts`.
- Never let a guarded write report through a boolean whose `false` is shared by "didn't match" and "nothing to report". Return a discriminated outcome and switch on it — the shipped fix is `EnrichmentWriteOutcome = 'applied' | 'stale' | 'unique-conflict'` with `if (written.outcome !== 'applied') continue;`. That is what turns this class from silent to loud.

**2. A guarded transition needs `.returning()` on the terminus (#1470).** `transitionBookStatus`
(`src/server/utils/book-status.ts`) and the symmetric `transitionDownloadState` compile to two
different SQL shapes. UNGUARDED is `db.update(t).set(s).where(eq(id))`, awaited directly. GUARDED
(`expected: { status: X }`) is `...where(and(eq(id), eq(status, X))).returning({ id })` and reads
`result.length > 0` to learn whether the precondition matched. So a transaction-spy mock building the
terminus as `where: vi.fn().mockResolvedValue({ rowsAffected: 1 })` works for unguarded writes and
throws `TypeError: returning is not a function` the moment a write becomes guarded — and that
TypeError reads like a behaviour failure, not a stale-mock failure.

When you add an `expected` guard, update the doubles in the same change: give the terminus a value
that is BOTH awaitable AND exposes `.returning()` (the `updateWhereTerminus()` thenable in
`import-queue-worker.test.ts`), and to assert guard semantics use a stateful mock returning `[{id}]`
on match / `[]` on miss keyed off a mutable tracked status (`makeGuardedTxUpdate`). Rollback mocks
that threw inside an async `where` must move the throw to `.returning()`. Discriminate `import_jobs`
writes (payload has `phase`) from book writes (no `phase`). The downloads axis has the same shape.

*Distinct from mechanism 1:* there `.returning()` exists and resolves, the write just never matched;
here it is ABSENT and throws.

**3. `createMockServices` defaults every unconfigured method to a REJECTING `vi.fn()` (#1960).**
`createMockServices` / `resetMockServices` (`helpers.ts:348-417`) give every unconfigured service
method `vi.fn().mockRejectedValue(new Error('mock not configured: <svc>.<method>'))`. That default is
deliberate and good — an awaited-but-unconfigured method fails loudly instead of returning
`undefined`. But it means **adding a new service call to a SHARED route retroactively changes the
behaviour of every pre-existing test in that route's suite**, two ways:

- **Awaited read → unexplained 500.** Adding `await settingsService.get('library')` ahead of the write in `PUT /api/settings` made every existing PUT test 500. Fix: add a category-resolving default in `beforeEach`, AFTER `resetMockServices(services)` (which re-applies the rejecting default).
- **Fire-and-forget call → an extra `warn` record.** `fireAndForget` catches the rejection and logs at `warn`, so any test asserting `expect(mockLog.spies.warn).toHaveBeenCalledTimes(1)` — the route-boundary-record convention — now sees 2. Fix: `mockResolvedValue(undefined)` for the new method in `beforeEach`; keep the rejection opt-in for the isolation test that wants it.

Mode 2 is the harder diagnosis: the failing assertion is about a completely unrelated log record and
the error says nothing about the new call. **Checklist when adding a service call to a shared route:**
grep that route's suite for (a) warn/error call-count assertions and (b) tests asserting a 2xx without
configuring the new dependency.

**4. `createMockDb`'s single `select` stub must be split by PROJECTION, not call order (#1975).** When
a route issues two `db.select` calls per request, discriminate by the projection argument:
`resolveByPublicId` (`src/server/utils/public-id.ts:47`) calls `db.select({ id: t.id })` with a
projection; repository free functions like `findCompanionEbook` call `x.select()` with none.

```ts
db.select.mockImplementation((projection?: unknown) =>
  projection === undefined ? mockDbChain([observationRow]) : mockDbChain([{ id: rowid }]),
);
```

Stateless, so it holds however many requests a test issues. Both order-based alternatives break:
`mockReturnValueOnce` queues survive `vi.clearAllMocks()` and leak into the next test
([[vitest-clearallmocks-once-queue]]), and a call-index counter desynchronises the moment a test sends
a second request — which is every concurrency test. Reference: `setDb()` in
`src/server/routes/v1/companion-ebook.test.ts`, used by tests issuing up to 5 concurrent requests.
Applies to any v1 route that resolves a publicId then reads a second table.

**5. A fixture factory built on a shared default must DEEP-clone it.** The mock-settings factory
deep-clones `DEFAULT_SETTINGS` via `structuredClone` so a test mutating the returned object cannot
pollute the shared default for later tests. A shallow `{ ...obj }` shares nested references and leaks
mutations across tests.

All five are instances of [[vacuous-assertion-observation-points]] — the observable could not see the
property the test claimed to prove.

## zod-type-provider-send-union-narrowing

**source:** #1452
**added:** 2026-06-14
**files:** src/server/routes/v1/actions.ts
**tags:** fastify, zod

---

fastify-type-provider-zod types FastifyReply.send() as the union of the schemas declared in the route's `response` map. So once a route (using withTypeProvider<ZodTypeProvider>()) declares its 200/201 success shape, `reply.status(400).send(envelope)` fails typecheck unless 400 is also declared in the response map. Two ways to satisfy it: (1) throw a typed error and let a setErrorHandler build the envelope via its own untyped reply (how the v1 READ routes avoid the issue — they throw V1NotFoundError → v1ErrorHandler), or (2) declare an error-envelope schema for every status the handler reply.send()s inline (how the v1 ACTION routes do it: an inline error-envelope schema for each status the route declares — the exact status set varies per route). Helper functions receiving a bare FastifyReply parameter are not subject to the narrowing. Approach (2) also fail-closes error-body serialization. Reference: src/server/routes/v1/actions.ts vs src/server/routes/v1/books.ts + _helpers.ts (v1ErrorHandler).

## fastify-swagger-servers-strips-path-prefix

**source:** #1454
**added:** 2026-06-14
**files:** src/server/routes/v1/openapi.ts
**tags:** fastify

---

@fastify/swagger (openapi mode) emits relative path keys in `app.swagger().paths` and puts any base/prefix in `openapi.servers[].url`. If you register routes under a URL_BASE prefix and set `openapi.servers = [{ url: urlBase }]`, the spec's path keys stay relative (`/api/v1/books`), and the full URL is `servers.url + path` (`/narratorr/api/v1/books`). This is correct OpenAPI semantics (clients combine server base + relative path) but surprises tests that expect prefixed path keys — assert `servers` reflects the prefix AND path keys are relative, not `spec.paths['/narratorr/api/v1/books']`. Mechanism: `stripBasePath: true` is the default (`@fastify/swagger/lib/mode/dynamic.js`), and `normalizeUrl` (`lib/spec/openapi/utils.js`) strips each `servers[].url` basePath from every route url before emission (`if (url.startsWith(basePath) && basePath !== '/') url = url.replace(basePath, '')`), so a route mounted at `/narratorr/api/v1/books` is rewritten to `/api/v1/books`. This is non-obvious enough that it tripped a PR reviewer into a BLOCKING false-positive (#1483 F1: "URL_BASE duplicated in operation URLs") — a v1 transform that returns the route url unchanged is correct precisely because swagger strips the prefix downstream; stripping again in the transform would be dead code. Ref: src/server/routes/v1/openapi.ts (registerV1OpenApi), src/server/routes/v1/openapi.test.ts ('URL_BASE honored' describe block).

## rhf-parent-reset-clobbers-child-seterror-on-mount

**source:** #1491
**added:** 2026-06-15
**files:** src/client/components/settings/ConnectorCardForm.tsx, src/client/components/settings/ConnectorCard.tsx
**tags:** react-hook-form, useEffect

---

React runs child effects before parent effects. If a child form component applies RHF setError() in a mount effect (e.g. mapping server test `fieldErrors` onto nested `settings.*` inputs) while the parent component resets the same form via form.reset() in its own mount effect, the parent reset wipes the child's errors because it runs second. This is invisible in production (the failing test result arrives after a user click, long after mount, so reset() has already run and its deps don't change), but it breaks component tests that pass the failing result as an initial prop. Fix in tests: deliver the result AFTER mount via a small stateful wrapper that setStates it in a useEffect, mirroring the real click-driven flow — do not pass it at initial render. Applies to any entity-edit card that pairs a parent reset() effect with child-applied field errors (currently ConnectorCard; the indexer/download-client/notifier cards would hit the same trap if they add fieldError mapping). See src/client/components/settings/ConnectorCard.test.tsx.

## sqlite-libsql-engine-facts

**source:** #1736
**added:** 2026-06-17
**files:** src/db/schema.ts, src/db/client.ts, drizzle/**, src/server/services/blacklist.service.ts, src/server/services/discovery.service.ts
**tags:** sqlite, libsql, drizzle, migrations

---

Engine behaviours that differ from what the schema or the docs imply.

**Foreign keys are ON by default under libSQL — the opposite of vanilla SQLite (#1736).**
`@libsql/client` (`src/db/client.ts` `createDb`) enables `PRAGMA foreign_keys` itself; a fresh
connection returns `foreign_keys=1` even though nothing in the codebase sets it. Verified empirically.
Three consequences. (1) Every `onDelete: 'set null' | 'cascade'` clause in `src/db/schema.ts` is
enforced at runtime — deleting a `books` row nulls `import_jobs.book_id` / `book_events.book_id` and
cascade-deletes `book_authors` / `book_narrators`, which is why `BookService.delete` deletes only the
`books` row and code can rely on FK set-null instead of manually nulling linkage columns. (2)
Inserting a child row referencing an already-deleted parent throws, so mind write ordering — record an
event with `bookId: null` after deleting the book, never the dead id. (3) Real-DB tests via
`createDb`/`runMigrations` enforce FKs the same way. Do not add a `PRAGMA foreign_keys=ON` thinking it
is missing, and do not assume schema FK clauses are inert.

**NULL ≠ NULL inside a UNIQUE index.** A nullable column does NOT prevent duplicate rows where that
column is NULL, so a unique constraint over a nullable column will not dedupe. Populate the column
before insert, or add a service-layer guard. Surfaced during the publicId work, where a nullable
unique column silently allowed dupes at the migration boundary.

**Bound-parameter cap applies to the WHOLE statement.** When building a dynamic `IN (...)` query,
chunk to stay under the cap and count ALL bound params — the WHERE clause AND the IN list, not just
the list length. The old "999" figure is stale; modern SQLite (≥ 3.32) and libSQL set
`SQLITE_MAX_VARIABLE_NUMBER` to 32766. The failure mode is unchanged: exceed it and the statement
errors at runtime.

## drizzle-enum-type-derivation

**added:** 2026-06-17
**files:** src/server/services/types.ts, src/db/schema.ts
**tags:** drizzle, typescript

---

Drizzle widens enum columns to `string` at the TS boundary. On READ, `typeof table.$inferSelect` re-widens enum columns — do NOT redeclare `type FooRow = typeof foos.$inferSelect` per file; import the canonical narrowed Row type from `src/server/services/types.ts` (`BookRow`, `DownloadRow`, `IndexerRow`, `BookEventRow`, etc.). A hand-rolled DB-shaped type that types an enum column as `string` is the same anti-pattern in different syntax — import the canonical type instead. On WRITE/derive, get the narrow union from `NonNullable<typeof table.$inferInsert['col']>`, never bare `string`.

## zod-field-authoring

**source:** —
**added:** 2026-06-17
**files:** src/shared/schemas/**, src/core/indexers/**, src/core/metadata/**, src/core/import-lists/**
**tags:** zod, indexers

---

Three field-level traps, each one where the obvious modifier does not do what its name suggests.

**`.default()` does not coalesce empty strings.** `z.string().default('x')` applies the default only
for `undefined`; an empty string `''` passes through unchanged. To coalesce empty or whitespace input,
use `.transform(v => v || default)` (trim first if needed), not `.default()`.

**`.min(1)` accepts whitespace.** `z.string().min(1)` accepts `'   '`. For user-facing text fields use
`.trim().min(1)` so a spaces-only value is rejected.

**`.optional()` rejects `null`.** It accepts `undefined` but rejects `null` (zod v4: *"Invalid input:
expected string, received null"*). Real external APIs — NYT, Audible, ABS, Hardcover, MAM, Audnexus —
return `null` for absent values, so ANY field parsed from an external response must use `.nullish()`,
which accepts both. Reserve `.optional()` for schemas we own (request validators, DB-derived shapes,
form data, settings) where we control the contract.

## zod-resolver-effects-divergence

**added:** 2026-06-17
**files:** src/client/components/**, src/client/pages/settings/**, src/shared/schemas/settings/strip-defaults.ts
**tags:** zod, react-hook-form

---

`z.preprocess()`, `z.transform()`, and `z.default()` create input ≠ output type divergence (zod v4: `ZodPipe`/`ZodTransform`/`ZodDefault` — the v3 `ZodEffects` class no longer exists); `zodResolver` requires input and output aligned and otherwise mistypes the form. Fix: omit `.default()` in form schemas (forms always pass explicit `defaultValues`), and use `setValueAs` in `register()` for coercion instead of `z.preprocess()`. Use the `stripDefaults()` helper (`src/shared/schemas/settings/strip-defaults.ts`) to remove defaults from a server schema before reusing it in a form.

## settings-field-dual-default

**added:** 2026-06-17
**files:** src/shared/schemas/settings/**
**tags:** settings, zod

---

A new settings field needs TWO edits: the Zod schema `.default(...)` AND `settingsRegistry.*.defaults` in `registry.ts` (from which `DEFAULT_SETTINGS` derives). `defineCategory` types `defaults` as `z.infer<S>`, so a schema-only addition is now a COMPILE ERROR at the registry until the defaults edit lands — the fix is to add the field to `defaults`, never to loosen the registry's types to make the error go away. At runtime the settings service DOES safeParse stored rows (zod fills `.default()`s there); `DEFAULT_SETTINGS` is the no-row / failed-parse fallback and what the mock factories clone, so both edits still matter.

## settings-from-entity-registry-overlay

**added:** 2026-06-17
**files:** src/client/components/settings/**
**tags:** settings, react-hook-form

---

A `settingsFromX` helper that derives form state from a stored entity must spread `<ENTITY>_REGISTRY[entity.type].defaultSettings` and then overlay the entity's non-null stored values — never enumerate every possible field across every adapter type. Strict per-type schemas (`.strict()`) reject foreign-type fields with `Unrecognized keys` (400); the overlay (not defaults alone) is what preserves valid non-default keys the UI actually persisted (e.g. MAM's `isVip` / `classname`). Component tests must assert the `onFormTest` payload's `settings` contains no foreign keys for the selected type.

## sse-setquerydata-not-invalidate

**added:** 2026-06-17
**files:** src/client/hooks/**
**tags:** react-query, sse

---

For high-frequency SSE/stream updates, patch rows in place with `setQueryData()`, not `invalidateQueries()` — invalidation refetches on every event and thrashes the UI.

## react-query-optimistic-cancel

**source:** #1963
**added:** 2026-06-17
**files:** src/client/hooks/**, src/client/pages/book/useCompanionEbookSelection.ts
**tags:** react-query, test-observability

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
**tags:** react

---

Module-level mutable state read by React components must be exposed via `useSyncExternalStore` with a subscribe/notify pair — a bare `let` won't trigger re-renders and tears across concurrent renders.

## derived-state-over-copied

**added:** 2026-06-17
**tags:** react, react-query

---

Prefer derived state to copied state: `override ?? queryDefault ?? fallback` instead of copying async query data into `useState`. Copying creates a race where the local copy goes stale relative to the query cache.

## backdrop-filter-stacking-context

**added:** 2026-06-17
**files:** src/client/components/**
**tags:** css, z-index

---

An element with `backdrop-filter` (e.g. glass-card containers) creates a stacking context that traps descendant z-index. Dropdowns/modals that must escape it have to render through a portal attached to `<body>`, not the nearest parent.

## dropdown-option-case-insensitive-dedup

**added:** 2026-06-17
**tags:** react

---

Deduplicate dropdown/filter options case-insensitively (a Map keyed by the lowercased value) — otherwise values differing only by case render as duplicate entries.

## stable-list-keys

**added:** 2026-06-17
**files:** src/client/lib/stableKeys.ts
**tags:** react

---

Use field-based React keys, not array indices. Append an index suffix only at actual collision points, via a dedup helper — index-only keys remount/reorder incorrectly when the list changes.

## spa-fallback-url-base-scope

**added:** 2026-06-17
**files:** src/server/server-utils.ts
**tags:** fastify

---

The SPA index.html fallback must reject any request whose path doesn't start with `URL_BASE` before serving index.html — otherwise unrelated paths get the SPA shell instead of a 404 when the app is mounted under a sub-path.

## fire-and-forget-preflight

**added:** 2026-06-17
**files:** src/server/services/**
**tags:** fastify, zod

---

When a service method kicks off a background job (`.start()`), do all pre-flight validation SYNCHRONOUSLY before creating the job — a throw inside the async work function is unreachable by the caller because the route already returned 202. Make the method `async`, validate first, then create the job.

## db-update-after-first-irreversible-fs-step

**added:** 2026-06-17
**files:** src/server/utils/import-staging.ts, src/server/services/import.service.ts, src/server/services/merge.service.ts, src/server/services/book-rejection.service.ts, src/server/services/bulk-convert.ts
**tags:** import-staging, filesystem

---

In a pipeline that mutates the filesystem, update the database immediately after the FIRST irreversible fs step, not at the end. Deferring the DB write opens a window where the files have moved but the DB still points at the old state if the process dies mid-pipeline.

## fk-restore-find-or-create

**added:** 2026-06-17
**files:** src/server/services/**, src/server/utils/find-or-create-person.ts
**tags:** sqlite, drizzle

---

When restoring records (backup import, re-import), find-or-create the related FK records too, not just the primary scalar columns — a restore that writes only the primary row leaves dangling FKs to authors/series/etc. that no longer exist.

## import-commit-atomic-rename

**added:** 2026-06-17
**files:** src/server/utils/import-staging.ts
**tags:** import-staging, filesystem

---

The import commit/rollback in `import-staging.ts` relies on `rename()` atomically replacing the destination file. Do NOT `unlink()` before `rename()`, and don't substitute copy+delete — either opens a data-loss window the rollback assumes cannot exist. (POSIX gives no ordering guarantee between an un-fsync'd write and the backup-out renames, which is why the commit guards before the destructive step.)

## variable-length-format-most-specific-first

**added:** 2026-06-17
**tags:** cron

---

When parsing a format with a variable field count, check the MOST specific shape first — e.g. a 6-part (seconds-precision) cron before a 5-part cron — otherwise the shorter pattern greedily matches and the extra field is mis-parsed.

## bitrate-bps-kbps-boundary

**added:** 2026-06-17
**files:** src/core/utils/**
**tags:** music-metadata

---

`music-metadata` returns bitrate in bps (128000); settings/schemas use kbps (128); the DB stores bps. Always convert at the call site with `Math.floor(bps / 1000)` — never compare raw bitrate values across this boundary.

## retention-lt-not-lte

**added:** 2026-06-17
**files:** src/server/jobs/**, src/server/services/event-history.service.ts
**tags:** cron

---

"Older than N days" means strictly-less-than: use `lt`, not `lte`, on the cutoff timestamp. `lte` includes the boundary day and deletes one day too much.

## vitest-clearallmocks-once-queue

**added:** 2026-06-17
**tags:** vitest

---

`vi.clearAllMocks()` only clears call history (`mockClear`); it does NOT drain `mockResolvedValueOnce` / `mockReturnValueOnce` / `mockImplementationOnce` queues or reset implementations. A `beforeEach(clearAllMocks)` mixed with per-test `*Once()` queueing leaks stale queued responses across tests (flaky pass/fail). Use `vi.resetAllMocks()` (or per-mock `mockReset()`) when `*Once()` queues are in play — it drains the queue AND restores the implementation.

## vitest-faketimers-react-query

**added:** 2026-06-17
**tags:** vitest, react-query

---

A full `vi.useFakeTimers()` deadlocks TanStack Query's internal `setTimeout`. In tests that mix polling hooks with Query, fake only what you need: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` and drive with explicit `vi.advanceTimersByTime()`.

## esm-same-module-vi-mock-bypass

**added:** 2026-06-17
**files:** src/core/utils/network-service.ts
**tags:** vitest

---

When an exported function calls another exported function from the SAME module (e.g. `fetchWithSsrfRedirect` → `fetchWithOptionalDispatcher` in `network-service.ts`), the inner call uses the local binding, not the module's export — so a `vi.mock` factory overriding the inner export will NOT intercept it (only external callers see the override). Workarounds, in order of preference: (1) mock at the OS boundary (`node:dns/promises`, `node:fs/promises`, `vi.stubGlobal('fetch', ...)`); (2) stub the entry point itself, not its inner deps; (3) replace the entry-point implementation in the mock factory. Do NOT add `__internal` indirection to production code just to enable mocking.

**The `vi.mock` family — nothing here is typechecked.** A mock factory's return value is unconstrained by `@types/*`, and this repo's doubles use `inject<T>()` / `as unknown as T`, which erase property checking. Five ways that drifts, each silent until runtime and each in its own entry because they bite different files: the factory does not intercept a same-module call ([[esm-same-module-vi-mock-bypass]]); it omits a schema table and crashes an unrelated suite at import ([[drizzle-schema-toplevel-deref-breaks-partial-mocks]]); it replaces a barrel and drops named exports, or preserves one and leaks real network calls ([[vimock-barrel-replace-drops-named-exports]]); its implementation is an arrow where production uses `new` ([[vifn-arrow-not-constructable]]); or its return SHAPE goes stale behind a compatibility wrapper ([[compat-wrapper-hides-stale-test-doubles]]). Deliberately not merged: the five have disjoint file scopes, so one entry would inject all of it whenever any one file is touched.

## serialize-error-catch-binding-tracing

**source:** #1974
**added:** 2026-06-17
**files:** src/server/services/companion-ebook-open.test.ts
**tags:** eslint, logging

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
**tags:** cancellation

---

Node 24's `AbortSignal.timeout(ms)` schedules on an internal native timer, NOT the patchable `globalThis.setTimeout` (verified: a wrapped `globalThis.setTimeout` is not invoked when `AbortSignal.timeout` is created, and the signal still aborts with `TimeoutError`). Consequence for testing retry adapters that pair `fetchWithTimeout` (`src/core/utils/network-service.ts` — built on `AbortSignal.timeout`) with their own `setTimeout` backoff: `vi.spyOn(globalThis, 'setTimeout')` can capture the adapter's exact backoff delay AND redirect it to fire immediately (`return original(fn, 0)`) while the per-call request timeout keeps working against real MSW responses. This gives deterministic exact-delay assertions (honored `Retry-After`, fallback default, max-clamp, caller-abort-during-backoff) with no `vi.useFakeTimers` / `advanceTimersByTimeAsync` / MSW interleaving fragility. Exemplar: `src/core/download-clients/retry.test.ts` (503 retry suite; `attribution.test.ts` was removed with the earwitness cut, #1596). Exception/guardrail: this works ONLY because `AbortSignal.timeout` is native — a hand-rolled `AbortController` + `setTimeout` timeout WOULD be captured by the spy, so the pattern breaks for clients not built on `fetchWithTimeout`.

## music-metadata-common-shapes-and-native-freeform

**source:** #1671  
**added:** 2026-06-29  
**files:** src/server/services/retag-plan.ts  
**tags:** music-metadata, audio-tags

---

music-metadata's `common` (ICommonTagsResult) returns these as `string[]` — read `?.[0]`: subtitle, publisher, description, genre, composer, label. These are scalars: artist, album, albumartist, grouping, asin (string), year (number), date (string). Freeform/custom tags (e.g. `series`, `series-part`) written via ffmpeg `-metadata key=value` do NOT appear in `common` at all — they only surface in `metadata.native` keyed by format, as `{ id, value }` arrays, with ids like `TXXX:series` (ID3v2), `----:com.apple.iTunes:series` (MP4), or a bare `series`; TXXX `value` can be a `{ description, text }` object rather than a plain string. Any tag-readback (populate_missing field-awareness, dedup, enrichment) must therefore handle: (1) array-vs-scalar per common field, and (2) a native-frame scan for freeform fields with no common mapping. retag-plan.ts splits this into readCommonCoreTags/readCommonAbsTags (common) + readNativeSeriesTags/readNativeFreeform (native), matching id by exact-equal or `:<key>` suffix, case-insensitive. Prior art for native ASIN scanning lives in src/core/utils/audio-scanner.ts (scanNativeForAsin).

## book-duration-minutes-vs-quality-seconds

**source:** #1797
**added:** 2026-07-02
**files:** src/core/utils/quality.ts, src/server/services/book-list.service.ts, src/server/services/match-job.helpers.ts
**tags:** ffprobe

---

`books.duration` (DB column) is stored in MINUTES (Audible `runtime_length_min`); `books.audioDuration` is stored in SECONDS. The quality chain — `calculateQuality(sizeBytes, durationSeconds)`, `compareQuality`, and the MB-per-hour grab floor / quality tiers in `src/server/services/search-pipeline.ts` — is entirely SECONDS-based. Passing raw `book.duration` into that chain inflates MB/hr 60× and makes absolute thresholds (grabFloor, `NARRATOR_QUALITY_FLOOR_MBHR`) inert while leaving relative ranking unaffected (the 60× cancels within one book), so the bug is easy to miss. The single JS normalization home is `resolveBookQualityInputs(book)` in `src/core/utils/quality.ts`, precedence `audioDuration ?? duration*60`. Every grab/retry/RSS path and the display path must funnel duration through it; the display path already sends true seconds from the client (`SearchReleasesModal.tsx` now routes through `resolveBookQualityInputs`, not a manual multiply). Guard against reintroduction: `grep -rn "duration \* 60" src` (excluding tests/comments) must return exactly three production hits — `quality.ts` (the JS normalization home) plus `match-job.helpers.ts` (two hits: `meta.duration * 60` converting provider-metadata minutes to seconds for duration verification; `BookMetadata` has no `audioDuration`, so that shape can't route through the helper). Any NEW hit needs the same kind of written justification. When writing fixtures, remember a `duration` literal that looks like seconds (e.g. `36000`) in a minutes column is 600 hours, not 10 — pair `_SIZE = mbPerHour*hours*MB` fixtures with `duration` in minutes (`hours*60`).

**Note (triage-verified, #1804):** there is also a deliberate normalization home the grep-guard does not catch — the library list-sort path re-expresses the same conversion in SQL as `${books.duration} * 60` at `src/server/services/book-list.service.ts:355` (a Drizzle order-by can't call the JS helper), and it's DRY-3-commented there. The guard counts only the JS `duration * 60` literals; the SQL twin is expected and must be kept in sync with the helper's precedence.

## new-books-column-breaks-inline-fixtures

**source:** #1711
**added:** 2026-06-30
**files:** src/server/__tests__/factories.ts, src/server/services/types.ts
**tags:** drizzle, test-fixtures

---

Adding a nullable column to the `books` table (e.g. #1711 `edition_label`) breaks every hand-built `BookRow`/`BookWithAuthor` object literal in tests, because Drizzle's `$inferSelect` types a nullable column as a REQUIRED `string | null` property (plain nullable columns are not optional at the type level). The canonical fixture is `createMockDbBook` in `src/server/__tests__/factories.ts` — update it first — but several suites inline their own book literals that each need the new field: `quality-gate.service.test.ts`, `quality-gate.helpers.test.ts`, and `import-list.service.test.ts`. When adding a books column, grep for `productionType:`/`enrichmentAttempts:` to locate inline literals and run `pnpm typecheck` to enumerate the rest. The canonical narrowed Row types live in `src/server/services/types.ts`.

**Note (triage-verified, #1718):** the canonical `createMockDbBook` factory is NOT a drop-in for every suite — `quality-gate`'s `baseBook` is a SUPERSET shape (it carries `narrators`/`language`/`rating`/`tags` the DB-row factory lacks), so it genuinely can't delegate to the factory and the inline-literal ripple there is unavoidable, not merely un-DRY debt. Related: `drizzle-enum-type-derivation` (same `$inferSelect` territory, different lesson).

## ffprobe-mm-disjoint-duration-lies

**source:** #1846
**added:** 2026-07-08
**files:** src/core/utils/audio-probe.ts
**tags:** ffprobe, music-metadata

---

The scanner's two duration sources fail in disjoint ways, so neither is trustworthy alone. ffprobe's MP3 `format=duration` = filesize ÷ header bitrate: a file with a garbage Xing/Info header bitrate (e.g. The Rise of Endymion 001/118 at 827/746 bps) makes ffprobe report ~7.7–8.6 h for 4:00 files, inflating a book from ~30 h to ~46 h and raising a false duration-mismatch review flag. music-metadata derives MP3 length from the Xing frame count and reads those correctly, but historically halved ~1.7% of 64-bit-atom M4Bs (fixed in music-metadata v11.13.0) and returns no duration for version-1 `tkhd` M4Bs (ffprobe reads those). #1846 made music-metadata primary (free — already parsed for tags — and now trustworthy) with ffprobe as fallback/arbiter, gated by `isPlausibleDuration(duration, fileSize)` in src/core/utils/audio-probe.ts: implausible iff duration/fileSize non-finite-or-≤0, or implied bitrate `fileSize*8/duration` < 8000 bps AND duration > 1800 s (duration-gated floor so short low-bitrate files like e2e/assets/silent.m4b pass), or implied bitrate > 10_000_000 bps. When neither source is plausible the file's duration is omitted (never resurrect a known lie). The guard catches only gross lies — a subtle 2× halving inside the bitrate band is undetectable by bitrate alone; a downstream duration-mismatch comparison is the backstop where one exists. Constants are bps/seconds — never compare against kbps (see bitrate-bps-kbps-boundary).

## zod-type-scoped-settings-transform

**source:** #1879
**added:** 2026-07-17
**files:** src/shared/schemas/import-list.ts
**tags:** zod

---

Per-adapter settings schemas that must emit ONLY the effective type's own keys (no stale foreign key from a prior type) should strip via a `.transform()` chained after `.superRefine()`, not a plain strict object (which keeps every present declared key). The server resolver (`validateSettingsPerType`, src/shared/schemas/import-list.ts) replaces `data.settings` with the schema's parsed output, so the transform's per-branch object becomes what is persisted. Zod runs a `.transform()` only when the preceding `.superRefine()` produced no issues (verified empirically on zod 4.4.1), so non-null assertions inside the transform for fields the refine guarantees present are safe. Declare the output as an explicit single wide optional-field type (not `z.infer`, which yields a discriminated union the registry factory can't index). Keep the discriminant (`listType`) optional with an omitted→default branch for backward compatibility. Prior art: `hardcoverSettingsSchema` (#1879). Related: settings-from-entity-registry-overlay, compat-surface-zod-strip-not-strict.

## drizzle-schema-toplevel-deref-breaks-partial-mocks

**source:** #1894
**added:** 2026-07-21
**files:** src/server/services/import-submission-report.service.ts
**tags:** drizzle, vitest

---

A module-level constant that dereferences Drizzle schema columns (e.g. `const PROJ = { disposition: importSubmissionItems.disposition }`) is evaluated at import time. Any suite that `vi.mock`s `db/schema` with a partial factory omitting that table will then crash on load of ANY module in the import graph — the error is `No "<table>" export is defined on the "@db/schema.js" mock` (the specifier follows however the suite mocks it — `@db/schema.js` post-alias-conversion), thrown from the const's line, not from the test. Existing services avoid this by only referencing tables inside method bodies (evaluated at call time). Build such column projections lazily (a function returning the object, called at query time). Symptom is invisible to typecheck and to the module's own focused tests; it only appears when an unrelated suite that partial-mocks the schema pulls the module into its graph — so validate with the full `vitest run`, not just the changed files. Seen: top-level `REPORT_ITEM_PROJECTION` in import-submission-report.service.ts vs the partial db/schema mock in tagging.service.test.ts (#1894).

**The `vi.mock` family — nothing here is typechecked.** A mock factory's return value is unconstrained by `@types/*`, and this repo's doubles use `inject<T>()` / `as unknown as T`, which erase property checking. Five ways that drifts, each silent until runtime and each in its own entry because they bite different files: the factory does not intercept a same-module call ([[esm-same-module-vi-mock-bypass]]); it omits a schema table and crashes an unrelated suite at import ([[drizzle-schema-toplevel-deref-breaks-partial-mocks]]); it replaces a barrel and drops named exports, or preserves one and leaks real network calls ([[vimock-barrel-replace-drops-named-exports]]); its implementation is an arrow where production uses `new` ([[vifn-arrow-not-constructable]]); or its return SHAPE goes stale behind a compatibility wrapper ([[compat-wrapper-hides-stale-test-doubles]]). Deliberately not merged: the five have disjoint file scopes, so one entry would inject all of it whenever any one file is touched.

## react-query-mutation-callbacks-post-unmount

**source:** #1905
**added:** 2026-07-21
**files:** src/client/hooks/useReplaceGrab.ts, src/client/components/SearchReleasesModal.tsx
**tags:** react-query

---

TanStack Query v5's `useMutation({ onSuccess, onError, onSettled })` callbacks fire even after the component that called `mutate()` has unmounted — they are captured into the Mutation instance at build/mutate time and `mutation.execute()` invokes them regardless of whether the observer was removed. **This is the opposite of the `mutate(vars, { onSuccess })` form**, whose callbacks ARE skipped after unmount (`mutationObserver.js` gates them on `this.#mutateOptions && this.hasListeners()`); the docs describe that second form, so the two look contradictory unless you know which one you're holding. Consequence: unmounting a component (including a keyed remount on an id change) does NOT cancel a pending mutation's hook-level follow-up side effects. Any lifecycle-local effect (toast, modal close, setState on the unmounted tree's owner, confirm dialog) must be guarded — the established pattern here is a monotonic generation ref captured in `onMutate` and re-checked in the callbacks (see src/client/hooks/useReplaceGrab.ts), suppressing lifecycle-local effects for a stale generation while leaving unconditional cache invalidations in place. When the teardown is a keyed remount or close, advance that generation on a SYNCHRONOUS seam (a `useLayoutEffect` cleanup, which runs before the next instance is interactive), not a passive `useEffect` cleanup (which runs after the new instance has committed, leaving a stale-callback window). Verified in src/client/components/SearchReleasesModal.book-change.test.tsx. Related: rtl-layout-vs-passive-seam-testing (how to write a test that actually proves the seam).

## rtl-layout-vs-passive-seam-testing

**source:** #1905
**added:** 2026-07-21
**files:** src/client/components/SearchReleasesModal.book-change.test.tsx
**tags:** useLayoutEffect

---

React Testing Library's `render`/`rerender` wrap updates in `act`, which flushes passive effects synchronously before returning. Therefore a test that settles a held promise AFTER `rerender()` cannot distinguish a `useLayoutEffect` cleanup from a `useEffect` cleanup — the guarded state (e.g. a generation ref) is already advanced by the time the awaited callback runs, so the test passes for both seams and provides no protection. To prove a teardown runs on the synchronous (layout) seam, force the observation into the pre-passive window: (1) SYNCHRONOUS THENABLE — for a continuation attached directly to a promise, stub the awaited call to return a hand-rolled thenable whose `.resolve()` invokes queued `.then`/`.catch` synchronously, and trigger `.resolve()` from a sibling probe's `useLayoutEffect` setup (keyed alongside the swapped subtree) so the continuation runs in the layout phase; assert on the count of ALL constructed side-effect instances, not just live ones (a passive cleanup can construct-then-close within the same commit). (2) EFFECT-ORDERING MARKERS — when the continuation is inherently async (react-query awaits its mutationFn so its callbacks always run post-passive), technique 1 won't work; wrap the teardown hook via `vi.mock(m, importOriginal)` (memoize the wrapper to keep identity stable so the layout effect doesn't re-run), push a marker from the teardown and another from the incoming component's `useLayoutEffect` setup, and assert order `[teardown, interactive]` — React runs all layout cleanups before all layout setups, and a passive cleanup reverses that order. Non-negotiable: confirm each such test FAILS when the production seam is temporarily reverted to the passive form. Example: src/client/components/SearchReleasesModal.book-change.test.tsx (#1905).

## fetch-status-classification-for-cached-outcomes

**source:** #1942
**added:** 2026-07-25
**files:** src/core/utils/network-service.ts, src/core/metadata/audnexus.ts
**tags:** metadata-providers

---

Any adapter whose outcome gets CACHED must classify the response deliberately; the shortcuts in the uncached adapters are unsafe there.

- **`response.ok` is not `status === 200`.** The Fetch Standard defines `ok` as 200-299, so a null-body 202/204/206 passes `if (response.ok)` and reaches the JSON parser. Gate a definitive/cacheable branch on `response.status === 200` exactly.
- **Never fold all non-OK statuses into a 'not found'.** `audnexus.ts` `fetchJsonDetailed` does `if (!response.ok) return { kind: 'not_found' }`, which is fine for a throwaway result but would cache a temporary 401/403/408/auth-proxy error as a permanent absence. Map only the statuses the upstream API DOCUMENTS as absence (Audnexus: 400 and 404); everything else is transient.
- **3xx never arrives as a status.** `fetchWithTimeout` (src/core/utils/network-service.ts) sets `redirect: 'manual'` and throws for 300-399 before returning, so redirects surface via the pre-header catch. No 3xx arm is needed — but that catch must classify as transient, not as a miss.
- **Split at the body boundary.** `fetchWithTimeout` returns the Response with its `AbortSignal.timeout` still attached, so the body stream can reject after headers. `response.json()` reads AND parses in one call, conflating 'the exchange never completed' with 'the body arrived and is garbage'. Do `await response.text()` (rejection → transient) then `JSON.parse` (failure → invalid-record).
- **Bytes arriving is not authority.** This boundary explicitly expects HTML interstitials, rate-limit pages, and upstream shape changes. If the cached verdict is about a specific entity, require an identity predicate (`body.asin === requestedAsin`) AND a shape predicate (the expected collection is present) — an OR admits both wrong-entity records and error envelopes.

Reference implementation and full status/body test matrix: `AudnexusProvider.getChapterRuntime` / `classifyChapterBody` in src/core/metadata/audnexus.ts, tests in audnexus.test.ts ('getChapterRuntime — chapter-runtime adapter (#1942)'). Related: [[zod-field-authoring]] (optional external fields alone cannot prove a record is genuine).

## windows-hostile-test-primitives

**source:** #1959, #1976, #1989
**added:** 2026-07-27
**files:** src/server/**/*.test.ts, src/server/__tests__/**/*.ts, src/core/**/*.test.ts, src/core/__tests__/**/*.ts, src/db/**/*.test.ts, src/shared/**/*.test.ts
**tags:** windows, vitest, filesystem, libsql

---

**Scope note.** The `files` list above is deliberately broad: it covers every server, core, db and
shared test PLUS the test-infrastructure files under `__tests__/` (`e2e-helpers.ts`, `windows-fs.ts`,
`epub-archive.fixture.ts`), because that is where these traps are actually written. It was originally
scoped to the four directories where one batch's failures happened to land, which silently excluded
`src/server/routes/**` and `src/server/__tests__/**` — the latter is where e2e suites live, and it
missed the very next one written. Scope this by where the trap *applies*, not where it last bit.
Client tests are excluded on purpose: jsdom touches no filesystem.

Five filesystem primitives behave differently on Windows and will fail a suite that passes on the
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

**5. Nine characters are ILLEGAL in Windows filenames: `< > : " / \ | ? *`** (plus trailing dots
and spaces). A fixture whose *name* contains one — a real temptation for "awkward basename"
round-trip fixtures, where `"` is exactly the kind of awkwardness you want — fails at
file-CREATION with `ENOENT`/`EINVAL`, taking the whole suite down. Discovered by recurrence:
#2022's adversarial fixture `'A Book (50%) "done" ✓.epub'` shipped green from the Linux pipeline
and failed Todd's `pnpm verify` at creation, in THIS entry's own `files` scope, after the entry
already existed. Substitute a legal same-hazard character (apostrophe for double quote); spaces,
`%`, parens, and non-ASCII glyphs are all fine.

**Separately and already known:** `path.join()` yields backslashes on Windows. Never assert a
hardcoded-separator path — normalize the actual with `.split('\\').join('/')`, or use
`expect.stringContaining()`. Production code that persists paths (DB, API responses) normalizes to
POSIX because the app runs in Docker.

## max-lines-counts-code-not-raw-lines

**source:** #1989
**added:** 2026-07-27
**files:** eslint.config.js, src/**/*.ts
**tags:** eslint

---

`max-lines` (400) and `max-lines-per-function` (150) are configured with `skipBlankLines: true,
skipComments: true` (eslint.config.js:190-191) — they count **code lines only**. Files in this repo
run 40-50% comment density, so raw size is roughly double the counted size: `validate.ts` at ~759 raw
lines counts well under the 400 cap and passes cleanly (the exact figure drifts; the ratio is the point).

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

**source:** #1992, #1993, #2002, #2012, #2020, #2032, #2017, #2082
**added:** 2026-07-28
**files:** src/**/*.test.ts, src/**/*.test.tsx
**tags:** mutation-testing, test-observability

---

**An assertion is only as strong as its observation point.** One slate produced this defect seven
times in seven different media, every time with a green pre-existing test: the observable the test
watched could not see the property the test claimed to prove, so it passed against broken production
code.

**The closing step is non-negotiable: reproduce the counterfactual.** Break production exactly as the
assertion claims to prevent, and confirm the new test fails while the pre-existing ones stay green.
If the old tests also fail, the new one may be redundant. If nothing fails, the test proves nothing.
When nothing reds, suspect a redundant production path before blaming the observable — see
[[symmetric-mutation-cannot-observe-shared-derivation]] arm B.

The seven shapes. Four are medium-specific and live in the two entries below, scoped so they only
reach the dispatches they apply to; three cannot be narrowed by path and stay here.

- *Issuance ≠ persistence*, *route-status flattening hides a deleted guard*, *a same-turn `stop()`
  test must gate PRE-lock setup* → [[observation-points-server-writes-and-routes]]
- *react-query withholds the error until the retry ladder ends* → [[observation-points-react-query-error-state]]

**5. Aborting a Transform discards already-pushed chunks (#1992).** `callback(err)` inside
`_transform` destroys the stream and drops chunks it had `push()`ed but the consumer had not pulled.
A "N chunks reached the sink before the abort" assertion reads 0 whenever the source feeds
synchronously, since under `pipeline` the source drains into the transform before the sink's
`for await` begins. Source-side counters lie the other way (a Readable buffers to highWaterMark,
16 KiB). The transform's own running counter is the observable, and the raised error carries the same
total.

**6. `@ts-expect-error` is satisfied by ANY error on the next line (#1993).** A negative type test
that supplies a WRONG VALUE for a field does not pin that field's requiredness — make the field
optional and the assignment still errors on the value, the directive stays used, and no TS2578 fires.
To pin requiredness, OMIT the field. The union analogue: instantiating one arm leaves the others
unpinned — use a plain positive assignment per arm (deleting an arm then fails TS2322), plus
`@ts-expect-error` on a cross-arm property access and a bogus-discriminant negative to pin the closed
set. A type-only module has no runtime surface, so none of this is judgeable by reading: mutation-
verify with `pnpm exec tsc --noEmit` and confirm a non-zero exit. **Strip ANSI codes before grepping
tsc output** (`sed -e 's/\x1b\[[0-9;]*m//g'`) or `grep 'error TS'` silently matches nothing.

**7. Under Vitest, a dynamic import's `Object.keys()` is SOURCE order (#2002).** A native ESM module
namespace sorts its own string keys (ECMA-262 §10.4.6.1), so `Object.keys(ns)` is lexicographic.
Under Vitest it is not — `await import()` resolves through Vite's SSR transform to an ordinary object
in `export`-statement order. When pinning a module's public surface, `.sort()` before comparing: it is
ordering-agnostic and asserts exactly the property under test. A source-text scan that greps `^export`
is legitimately in file order, so a suite using both must keep the two orderings distinct.

Related: [[serialize-error-catch-binding-tracing]] carries the logging instance;
[[react-query-optimistic-cancel]] the `invalidateQueries` instance;
[[migrated-db-assertions-through-drizzle]] the ORM-vs-DDL instance.

## observation-points-server-writes-and-routes

**source:** #2012, #2017, #2032, #2082
**added:** 2026-07-28
**files:** src/server/**/*.test.ts
**tags:** drizzle, test-doubles, test-observability, fastify

---

The server-side arms of [[vacuous-assertion-observation-points]] — read that entry's rule first; this
one carries the three mechanisms that only bite server suites.

**1. Issuance ≠ persistence (#2017, #2082).** A Drizzle chain mock's `where()` body runs
SYNCHRONOUSLY as the statement is built, so tracing inside it records when the write was *issued* —
drop the `await` on the caller and the trace is unchanged. Gate the terminus instead, and it must be
both awaitable and `.returning()`-capable ([[shared-test-double-defaults]]):

```ts
const settle = () => gate.then(() => { trace.push('persisted'); });
return {
  then: (res, rej) => settle().then(() => ({ rowsAffected: 1 })).then(res, rej),
  returning: vi.fn().mockImplementation(() => settle().then(() => [{ id: 1 }])),
};
```

Then: await issuance → assert the follow-up has NOT started → release → assert it has. Three
siblings. Call counts are **order-blind** (`3 renames, 1 sweep` reads the same whichever ran first —
hold the final iteration pending instead). **Hard-coded post-state** reports the post-condition
regardless of when the dependent code ran — use one shared mutable state object that the production
write itself advances, and make the pre-condition genuinely able to fail. And a payload-only `set()`
assertion **misses the WHERE**: capture `setMock.mock.results[0].value.where`, so the filter half of
the write is asserted too.

**3. Route-level status flattening masks guard removal (#2032).** Where routes collapse every
rejection into one response on purpose (a bare 404, a single `UNAVAILABLE_BODY`) — because the
distinction would leak an existence oracle — a route-status assertion **cannot attribute a red to a
specific guard**, and stays green after that guard is deleted. Three such mutations were verified
green-under-removal. Two observables that work: assert the persisted `validationCode` (poll the state
endpoint until it settles; seed a deliberately stale `mtimeMs`/`ctimeMs` or the unchanged-check
short-circuits first), or make the fixture valid on every other axis so removing the guard yields a
200 rather than a differently-caused 404. Pick the observable BEFORE writing the fixture — a fixture
that trips a second guard identically is indistinguishable from one that trips the intended guard.

**4. A same-turn `stop()` test must gate PRE-lock setup (#2012).** Per-book methods register their run
promise synchronously before the first `await`, and `stop()` drains that set — but every locked pass
also re-checks `stopping` as its first statement inside the lock. So gating a collaborator called
*inside* the lock is vacuous: the gate never fires and the assertion fails against CORRECT code. Park
the run on its pre-lock setup instead, which leaves it observable only through the registration —
precisely the property under test. The complementary gated-in-flight case proves a different half;
neither substitutes for the other.

## observation-points-react-query-error-state

**source:** #2020
**added:** 2026-07-28
**files:** src/client/**/*.test.tsx, src/client/**/*.test.ts
**tags:** react-query, test-observability

---

The client-side arm of [[vacuous-assertion-observation-points]] — read that entry's rule first.

**react-query holds the error until the retry ladder ends.** TanStack Query v5 keeps a failed fetch in
`failureReason`/`failureCount` and promotes it to `state.error` only once retries are exhausted, so a
test waiting on the fetch mock's CALL COUNT asserts before the error exists — it passed for two
different wrong error-path implementations, including an any-4xx generalisation of a 409-only rule.

Watch the query state, not the mock:
`await waitFor(() => expect(client.getQueryState(queryKeys.X(id))?.status).toBe('error'))`.

Easy to miss because `renderWithProviders` sets `retry: false`, but a QUERY-level `retry` predicate
overrides the client default. Pass `retryDelay: 0` to keep the ladder fast — that changes how long a
retry waits, never whether one happens. `failureCount` starts at 0 against a default of three retries,
so a `failureCount < 3` predicate yields FOUR requests.

## epub-stack-type-declaration-gaps

**source:** #1987, #1988, #1989
**added:** 2026-07-28
**files:** src/core/epub/xml.ts, src/core/epub/zip-source.ts, src/core/epub/validate.test.ts
**tags:** epub, typescript

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
**tags:** epub, xml

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
**tags:** drizzle, libsql, sqlite, migrations

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
**tags:** libsql, drizzle

---

**The fact.** A single `@libsql/client` connection — which is what `createDb` (`src/db/client.ts`)
hands out, one per process — permits only ONE transaction at a time. Two overlapping raw
`db.transaction(...)` calls on the shared handle do not queue: the later one rejects with
`LibsqlError: SQLITE_BUSY: database is locked`. This is a connection-level constraint rather than lock
contention, so no `busy_timeout` or retry-on-busy setting avoids it. Verified empirically on
@libsql/client 0.17.3 / libsql 0.5.29 / drizzle-orm 0.45.2: four concurrent `db.transaction` calls
each doing select → await → insert yield 1 fulfilled and 3 `SQLITE_BUSY` rejections.

**What to do about it — do NOT hand-roll a serialization lane.** `createDb` monkey-patches
`db.transaction` to route through `runSerializedTransaction` (`src/db/serial-transactions.ts:85`), so
**the exclusion is enforced by the connection itself, automatically, for every service** — concurrent
per-item passes queue with no caller opt-in, and so does any other service's transaction. The
reconciler documents exactly this at `companion-ebook-reconciler.ts:626` ("Nothing here serializes the
transaction, deliberately"). A per-service promise-chain lane on top of that is redundant.

Two things that follow:

- **Nesting throws.** Opening `db.transaction` while a transaction is already open on that connection
  rejects with `NestedTransactionError` — use the `tx` handle the callback receives, or
  `tx.transaction()` for a savepoint. The tracking is a per-context Map of connection → mutable
  open-marker (#2008), not a single value, because a transaction on connection A may legitimately
  contain one on connection B.
- **Keep the surrounding work outside the transaction.** Serialization applies to the transaction
  only; discovery, validation, and pre-scan reads stay concurrent under whatever `Semaphore` bound the
  service uses. Widening the transaction throws away the concurrency the bound exists to provide.

**Diagnosis note (still useful for any un-serialized path).** A `SQLITE_BUSY` rejection is raised
inside the losing task, so a service that catches per-item errors reports it as an ordinary item
failure. The symptom presents as nondeterministic missing writes, not an obvious driver error — reach
for this explanation whenever a newly-concurrent write path starts dropping records. Related:
[[sqlite-libsql-engine-facts]], [[shared-test-double-defaults]].

## filehandle-stream-close-ownership

**source:** #1974
**added:** 2026-07-28
**files:** src/server/utils/companion-ebook-stream.ts, src/server/routes/companion-ebook.ts
**tags:** node-fs, fastify

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
tests: `streamCompanionEbook` in `src/server/utils/companion-ebook-stream.ts`, pinned by
`companion-ebook.test.ts` ('closes the handle exactly once on success') and the real-socket
`companion-ebook-stream.test.ts` (client abort, post-headers read failure).

## rate-limit-gate-fails-open-on-nan-window

**source:** #1944
**added:** 2026-07-28
**files:** src/server/services/metadata.service.ts, src/core/metadata/**
**tags:** metadata-providers

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
**tags:** react-query

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

## createtestapp-omits-auth-plugin

**source:** #2034  
**added:** 2026-07-30  
**files:** src/server/__tests__/helpers.ts  
**tags:** fastify, csrf, test-fixtures, auth, vitest

---

`createTestApp` (`src/server/__tests__/helpers.ts:74-85`) registers only `errorHandlerPlugin` and `registerRoutes` — NOT `authPlugin` (its doc comment now warns about exactly this). So through the shared route-test app, `request.user` is never set, the `/api/*` authentication hook never runs, and `enforceCsrf` (`src/server/plugins/auth.ts:34-40`) never runs. A non-safe method missing `X-Requested-With: XMLHttpRequest` returns its normal 2xx, not 403.

**The trap:** a CSRF assertion written against `createTestApp` in the loose form (`expect(res.statusCode).not.toBe(403)`) passes vacuously — the gate it claims to exercise is not installed. Only the strict form (`expect(res.statusCode).toBe(403)`) fails loudly enough to reveal the gap. `enforceCsrf` is reached solely from `auth.ts:254`, gated on `status.mode === 'basic'` AND `request.user` being populated by `handleBasicAuth`, so both the plugin and a credentialed request are required.

**The recipe** for auth/CSRF cases in a route suite: use the shared `createAuthTestApp` / `stubAuthService` helpers (`src/server/__tests__/helpers.ts:109-206`, added by #2053) — they install the real `authPlugin` over the same scaffolding, and the registration order they encode (cookie → errorHandler → authPlugin → routes) is load-bearing. Do NOT hand-roll the instance; the three suites that used to are all migrated to the helper.

Because `BASE_PUBLIC_ROUTES` (`auth.ts:17-23`) is module-private, "this route is not public" is assertable only as a 401 on an uncredentialed request. Worked references: `src/server/routes/system.test.ts:1067-1109`, `src/server/routes/auth.test.ts:820`, `src/server/routes/companion-ebook.test.ts:1803-1856`.

Related: [[vacuous-assertion-observation-points]] — a distinct mechanism (the harness omits the middleware entirely, rather than the observation point being unable to see a wired property), so it may belong as a further section of that entry.

## vifn-arrow-not-constructable

**source:** #2065
**added:** 2026-08-04
**files:** src/server/services/backup.service.test.ts, src/server/services/backup.service.ts
**tags:** vitest, test-doubles

---

Under vitest 4.1.10, `@vitest/spy` dispatches `new` through `Reflect.construct(implementation, args, new.target)` (`@vitest/spy@4.1.10/dist/index.js:309`) — `vi.fn` passes the implementation straight through instead of wrapping it in a constructable function. Consequences:

- `new (vi.fn(() => ({ ... })))()` throws `"() => ({...}) is not a constructor"`.
- `vi.fn(function () { return { ... } })` **is** `new`-able and evaluates to the returned object (a constructor returning an object overrides `this`).

**When this bites:** any dependency migration that turns a factory function into a class. A `vi.mock` factory for that module must change its *implementation shape*, not merely its exported key. Renaming `default` to `TheClass` while leaving an arrow implementation compiles, type-checks, and fails only at runtime — `@types/*` declarations do not constrain a `vi.mock` factory's return value, so typecheck is blind to it.

Worked instance (#2057): `archiver@8.0.0` is `"type": "module"` and `index.js` exports only `{ Archiver, ZipArchive, TarArchive, JsonArchive }` — no default — so `archiver('zip', opts)` became `new ZipArchive(opts)` (`src/server/services/backup.service.ts:108`). The hoisted factory at `src/server/services/backup.service.test.ts:16` needed:

```ts
vi.mock('archiver', () => ({
  ZipArchive: vi.fn(function () {
    /* ... return an archive-shaped object ... */
  }),
}));
```

**Do not treat the rename as done.** Per `vacuous-assertion-observation-points`, the only evidence the double is genuinely constructable is the counterfactual: revert `function ()` to `() =>` and confirm the suite goes red with "is not a constructor" (11 tests, in that suite's case). A double that is never actually driven through `new` by the code under test will stay green either way — and that green is exactly the signal you cannot trust.

**The `vi.mock` family — nothing here is typechecked.** A mock factory's return value is unconstrained by `@types/*`, and this repo's doubles use `inject<T>()` / `as unknown as T`, which erase property checking. Five ways that drifts, each silent until runtime and each in its own entry because they bite different files: the factory does not intercept a same-module call ([[esm-same-module-vi-mock-bypass]]); it omits a schema table and crashes an unrelated suite at import ([[drizzle-schema-toplevel-deref-breaks-partial-mocks]]); it replaces a barrel and drops named exports, or preserves one and leaks real network calls ([[vimock-barrel-replace-drops-named-exports]]); its implementation is an arrow where production uses `new` ([[vifn-arrow-not-constructable]]); or its return SHAPE goes stale behind a compatibility wrapper ([[compat-wrapper-hides-stale-test-doubles]]). Deliberately not merged: the five have disjoint file scopes, so one entry would inject all of it whenever any one file is touched.

## execfile-mock-dual-callback-shape

**source:** #2071
**added:** 2026-08-04
**files:** src/core/utils/audio-processor.test.ts, src/core/utils/audio-probe.ts, src/core/utils/audio-processor.ts, src/core/utils/cover-art.ts
**tags:** vitest, node-fs, ffprobe

---

A file-wide `vi.mock('node:child_process')` has to serve every `execFile` consumer, and this repo has two incompatible consumer styles. `promisify(execFile)` callers — `getFileDurations` (`src/core/utils/audio-processor.ts:20,531`) and `detectCoverArtSource` (`src/core/utils/cover-art.ts:9,70`) — need the trailing callback invoked as `cb(null, { stdout, stderr })` (the mock has no `util.promisify.custom` symbol, so promisify resolves with the first callback value). Raw-`execFile` callers — `runFfprobeJson` in `src/core/utils/audio-probe.ts:38`, which backs `getFFprobeDuration` / `getFFprobeStreamDuration` / `getFFprobeStreamInfo` — wrap it themselves and destructure positionally, needing `cb(null, stdoutString, stderrString)`.

Getting it wrong is silent, not loud: handing the object form to a raw caller makes `JSON.parse(stdout)` see `[object Object]`, which throws into `runFfprobeJson`'s single `catch` (audio-probe.ts:44-46) and returns `null` — the module's intended graceful-null contract. Downstream, a null probe reads as 'unreadable source', a legitimate state, so every assertion stays green while the code path under test never runs. #2068 hit exactly this: the stream-copy branch would have been unreachable in the whole suite.

Pattern: dispatch on argv **and** branch the callback shape per arm (`installExecFileDispatcher`, `src/core/utils/audio-processor.test.ts:172-209`, is the reference). Dispatch on the right key: the `show_entries` value alone is ambiguous — `format=duration` is issued by both a promisified caller (`-of default=noprint_wrappers=1:nokey=1`) and a raw one (`-of json`). Every `runFfprobeJson` caller passes `-of json`, so that flag is the reliable positional-vs-object discriminator. Then add a positive assertion that the new probe parsed non-null fields (see `parses the stream probe into non-null technical fields (mock-shape regression)`) — without it a shape regression is indistinguishable from a source set that was genuinely ineligible, which is `vacuous-assertion-observation-points` in a new medium.

## round-trip-fixture-discipline

**source:** #2072, #2081, #2086
**added:** 2026-08-04
**files:** src/core/utils/audio-processor.roundtrip.test.ts, src/server/services/tagging.roundtrip.test.ts, src/core/utils/audio-processor.ts, src/core/utils/encode-strategy.ts
**tags:** ffmpeg, ffprobe, round-trip, test-fixtures

---

Three questions to answer, in this order, before trusting a real-media round-trip assertion: did it
run at all, did the fixture force the branch you meant, and can the observable see the property.

**1. Did it run? The suites are capability-gated and skip SILENTLY (#2086).** They do not fail and
they do not announce themselves in a full-suite summary.

| File | Line | Gate |
|---|---|---|
| `audio-processor.roundtrip.test.ts` | `:83`, `:330` | `!FFMPEG_PRESENT` (probe: `ffmpeg -version` AND `ffprobe -version`, `:27-37`) |
| `tagging.roundtrip.test.ts` | `:82` | `!hasFfmpeg8` (the xHE-AAC/USAC floor, #1679) |
| `tagging.roundtrip.test.ts` | `:212`, `:303` | `!hasAnyFfmpeg` |

Measured with no ffmpeg on PATH: `Test Files 2 skipped (2) / Tests 23 skipped (23)`, **exit 0**. Folded
into a 6500-test `pnpm verify` that is indistinguishable from having proved something. `verify`
inherits the caller's PATH, so in an agent container without ffmpeg a green `run-verify` receipt
carries **zero** evidence for any AC whose proof lives in these files — which is most merge/tag/encode
issues. GitHub CI is in the same position (the test job installs no ffmpeg); the ffmpeg-8 guarantee
that IS enforced covers the shipped runtime image only, not the environment vitest runs in. Todd's own
machine has ffmpeg 8.1 on PATH and executes all 23, which is exactly why the gap is invisible from the
human side. Before claiming a real-media AC is proved, run the file explicitly and read back the
EXECUTED count — `Tests N passed` with N > 0, never `N skipped` — and say in the hand-off whether it
ran. A self-contained static ffmpeg satisfies the probe; the merge suites gate on PRESENCE only, so a
6.0 static build suffices (the ffmpeg-8 floor is scoped to `tagging.roundtrip.test.ts:82` alone).

**2. Did the fixture force the branch? (#2072)** The familiar failure is the observation point; the
other is the **stimulus** — the fixture is shaped so production takes a *different* branch than the
test claims, and the assertion then measures a value the fixture already had. `isCopyEligible`
(`encode-strategy.ts:166-176`) selects `-c:a copy` for mp3 output when every source is mp3 with a
present, set-wide-equal `sampleRate` and `channels` and no usable `config.bitrate` — exactly what
`keepOriginalBitrate` produces. A case meant to prove 22.05 kHz MP3 legalization built its fixtures
with `-c:a libmp3lame` at 22 050 Hz, textbook copy-eligible: `libmp3lame` was never invoked, the
`<= 160 kbps` read-back observed the fixture's own rate, the suite passed 8/8 and stayed green when
`selectMp3Table` was mutated to always return the MPEG-1 table.

Two defenses, use both. **Force the branch structurally** — `pcm_s16le` `.wav` can never copy into
mp3, so the run must encode; prefer that over an input that merely happens to be ineligible today.
**Assert a branch-exclusive side effect** — only the encode path calls `legalize()`, so a chain-step
notice (`mp3-table`, `evidence-cap`, `aac-max`, `mp3-table-minimum`) is something the copy branch
structurally cannot satisfy. Note the near-miss: copy is NOT "always `notices: []`" (a
present-but-unusable `config.bitrate` puts an `unusable-target` notice on the copy path), so assert
the specific chain step, not merely non-empty warnings. Recipe: run the fixture through the decision
function directly (`collectSourceEvidence` then `resolveEncodeStrategy` under `pnpm exec tsx`), print
the resolved mode, then mutate the production rule the test names and confirm THIS test reds.

Related trap: an encoder silently rewrites your fixture's parameters. `-b:a 8k` at 44.1 kHz does not
yield an 8 kbps file (measured on ffmpeg 6.0: LAME clamps to 32 kbps, 44 100 Hz retained), and
`-b:a 320k` at 22 050 Hz is silently re-rated to 160 kbps. Always probe the fixture you generated
rather than trusting the flags you passed it.

**3. Can the observable see it? (#2081)**

*`format=duration` on an m4b cannot see audio truncation.* The MP4 container duration is the max TRACK
duration, and the chapter text track written via `-map_chapters` spans the full generated timeline
regardless of what audio was muxed. A merge that maps the wrong audio input (`-map 2:a` instead of
`-map 0:a`) still reports full length, so a container-level duration assertion passes against exactly
the defect it claims to prevent. Measured on ffmpeg 6.0 with three 3 s parts: correct output
`format=duration` 9.024 / `a:0` stream duration 9.023991; truncated output 9.000 / 3.000000. The audio
stream's own duration is the oracle:
`ffprobe -v quiet -select_streams a:0 -show_entries stream=duration -of json`. (Production keeps both
entries distinct: `getFFprobeDuration` vs `getFFprobeStreamDuration`.)

*Size the duration tolerance to the encoder's padding and state it as an explicit band.* AAC
priming/padding is version- and bitrate-dependent: measured 0.024 s under `-c:a copy` but 0.042 s at
`-b:a 64k` on the same fixture. `toBeCloseTo`'s window is `10**-precision / 2`, so the DEFAULT
precision 2 is 0.005 — five to eight times tighter than the padding, an instant flake — and precision
1 leaves 8 ms of headroom a different ffmpeg major will eat. Prefer an explicit
`> total - 0.5 && < total + 0.5` band: it states the intended tolerance instead of encoding it in a
precision digit nobody converts correctly, and half a second still separates a 9 s whole from a
truncated 3 s part.

*A positional `-t` binds to the NEXT `-i`, not the previous one.*
`['-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','6','-i',cover]` applies `-t 6` to the cover and
leaves `anullsrc` unbounded — the process runs forever and the only symptom is a vitest timeout with
no error output. Harmless with a single input, fatal the moment a second `-i` appears. Put the
duration inside the filter: `anullsrc=r=44100:cl=mono:d=6`, `sine=frequency=440:duration=3`,
`color=c=red:s=64x64:d=1`.

Related: [[vacuous-assertion-observation-points]] (the general form), [[ffprobe-mm-disjoint-duration-lies]]
(the production-scanner duration lie, a different mechanism).

## json-parse-error-echoes-source

**source:** #2076
**added:** 2026-08-04
**files:** src/server/utils/cleared-fields.ts, src/server/utils/parse-phase-history.ts, src/server/utils/serialize-error.ts, src/server/services/quality-gate.service.ts, src/server/utils/cleared-fields.test.ts

**tags:** logging, zod

---

**The fact.** V8's `JSON.parse` SyntaxError message can quote the offending source back. Measured on Node 24: non-echoing shapes exist (`'{oops'` → `Expected property name or '}' in JSON at position 1`; `'[1,2,'` → `Unexpected end of JSON input`) but most malformed input echoes (`'{"a": bad}'` → `Unexpected token 'b', "{"a": bad}" is not valid JSON`). The quoted window is the entire string for short inputs and truncates for longer ones to roughly ten characters either side of the failure point with `...` elision (`{"seriesName": operator-typed-secret-value-here}` → `..."iesName": operator-t"...`).

**Why it matters.** `serializeError` (`src/server/utils/serialize-error.ts`) copies `message` AND `stack`, redacting only URLs. So the reflexive `log.warn({ id, error: serializeError(err) }, 'unparseable ...')` at a persisted-JSON read boundary reproduces the stored column in logs. Any "never log the stored value" rule is violated by that line — and the `narratorr/no-raw-error-logging` lint rule will not save you: it polices Pino serialization shape only, and its autofix pushes you *into* this leak.

**Zod is the second vector.** A `ZodError` message renders the `received` values, so `serializeError(result.error)` on the schema-validation arm leaks parsed content even when `JSON.parse` succeeded. Log `error.issues.map((i) => i.path.join('.'))` instead — paths carry no values (#1404).

**The rule.** At a persisted-JSON read boundary, log the row identifier and nothing derived from the payload; a bindingless `catch { }` makes that structural. The identifier is the whole diagnostic need: it says which row to inspect out of band. Repo precedent: the quality-gate reason parser (`quality-gate.service.ts`) has always done this; `parseClearedFields` (`cleared-fields.ts`) and `parsePhaseHistory` (`parse-phase-history.ts`) were both fixed to match in #2069.

**Testing it.** A single malformed input is not enough — pick one at random and you will often pick a non-echoing shape and certify a guarantee that does not hold (`{oops` did exactly this). Cover several inputs, assert on the WHOLE serialized payload (`JSON.stringify(payload)`) rather than known keys, since the value escaped through a NESTED `error.message`/`error.stack`. Do not hard-code a sentinel: V8 truncates its echo window, so a sentinel longer than the window passes for the wrong reason. Derive the asserted fragment from the engine's actual message (`longestEchoedFragment` in `cleared-fields.test.ts`) and guard the premise — assert the fragment is non-trivial, so the case fails loudly if V8 ever stops echoing rather than going quietly green. Related: `serialize-error-catch-binding-tracing`.

## caller-owned-tx-drops-post-commit-effects

**source:** #2077
**added:** 2026-08-04
**files:** src/server/services/book.service.ts, src/server/jobs/enrichment.ts, src/server/services/enrichment-orchestration.helpers.ts
**tags:** drizzle

---

**The trap.** When a service method gains a caller-owned-transaction option (`update(id, data, { tx })`), that arm must return BEFORE the wrapper's post-commit side effects — logs, telemetry, hydration — because the owner may still roll back and stranding them is exactly what the split exists to prevent. That suppression is the visible half of the change and it gets implemented and tested. The invisible half: every caller that switches from the self-managed arm to `{ tx }` silently LOSES those effects. The write itself still lands, so every write-shaped assertion stays green and nothing at the call site fails.

**Measured instance (#2069, F21 → F5 — since fixed).** `BookService.update`'s tx arm (`book.service.ts:469-472`) correctly skips the wrapper's `log.info('Book updated')` and `trackUnmatchedGenres` (`:481-487`); the `tx?: DbOrTx` doc comment states the arm is deliberately side-effect-free. Two background jobs — `src/server/jobs/enrichment.ts` and `src/server/services/enrichment-orchestration.helpers.ts` — moved their genre fill to `{ tx }` for atomicity and neither re-ran the telemetry after committing, so `unmatched_genres` silently stopped receiving enrichment-sourced observations. Caught only by diffing the new call sites against the base branch; both now defer the effect correctly and are the reference shape below.

**The rule.** Suppressing the effect is half the change; handing it back is the other half. Have the transaction RETURN what actually landed so the owner can sequence the effect after its own commit:

```ts
const committed = await db.transaction(async (tx) => {
  ...
  const genresWritten = await writeArrays(..., tx);   // null when nothing landed
  return { applied: true, genresWritten };
});
if (committed.genresWritten) {
  await svc.trackUnmatchedGenres(committed.genresWritten).catch(nonFatal);
}
```

`null` must cover every not-landed case — suppressed by a guard, stale-dropped, or nothing to fill — or the owner reports an effect for a write that never happened. Live shapes: `applyEnrichmentWrites` returns `{ outcome, filledGenres, genresWritten }`; `applyAudnexusEnrichment`'s transaction returns `{ applied, genresWritten }`.

**Checklist when adding a `{ tx }` option:** enumerate every post-commit effect the self-managed arm performs; for each new `{ tx }` call site, diff against the base-branch call and decide per effect whether it is handed back or genuinely not needed — and assert the not-needed ones (e.g. "a narrators-only write records no genre telemetry", `enrichment-orchestration.helpers.test.ts:843-852`).

**Testing.** Assert ordering against the TRANSACTION'S RESOLUTION, never statement issuance: `db.transaction.mockImplementation(async (cb) => { const r = await cb(db); order.push('tx-committed'); return r })` then expect `['tx-committed', 'effect']` (`src/server/jobs/enrichment.test.ts:1743-1761`). Pair each positive control with a rollback negative whose failure lands AFTER the effect-producing write was issued — a rollback that never reaches the write cannot distinguish a deferred effect from a pre-commit one. Prefer observing the committed artifact (the actual table row) over a call on a mock. Related: [[libsql-transactions-serialized-at-the-connection]], [[vacuous-assertion-observation-points]] (§1, issuance ≠ persistence).

## connector-names-not-unique-or-immutable

**source:** #2095
**added:** 2026-08-04
**files:** src/server/services/health-check.service.ts, src/db/schema.ts, src/client/pages/settings/HealthDashboard.tsx, src/server/services/health-check.service.test.ts
**tags:** drizzle, sqlite, settings

---

`indexers.name` (src/db/schema.ts:314) and `downloadClients.name` (:330) are `text('name').notNull()` with no `.unique()` and no unique index, and both are mutable via `IndexerService.update()` / `DownloadClientService.update()`, which accept a `Partial<New*>` including `name`. Any server-side state keyed on a connector's display name therefore has three defects at once: two same-named connectors merge into one entry, a rename restarts the entry, and a rename after a side effect fired can re-fire it.

Key on the row id instead. Both tables use `integer PRIMARY KEY AUTOINCREMENT` (drizzle/0000_baseline.sql:271, :151); AUTOINCREMENT — unlike a bare rowid alias — guarantees ids are monotonic and never reissued, so a deleted-and-recreated connector always gets a fresh key and cannot inherit a deleted one's state. That is also what makes pruning stale entries unnecessary for correctness.

The canonical shape is `trackingKey()` in src/server/services/health-check.service.ts:89: `${target.kind}:${target.id}` for connector targets, falling back to `checkName` for singleton checks (whose names are fixed literals). Note the split of concerns — `checkName` is fine to CLASSIFY on (`isNetworkBackedCheck` prefix-matches `indexer:` / `download-client:`, which are server-constructed, so a user-supplied name cannot escape one) but never to identify with.

Two traps when applying this:
- Do NOT copy `HealthDashboard.cardKey` (src/client/pages/settings/HealthDashboard.tsx:43-50) wholesale. Its connector arm is right, but its non-connector arm returns `${target.kind}:${target.path}`, which collides `library-root` with `disk-space` — both build `{ kind: 'route', path: '/settings' }` (health-check.service.ts:384, :405).
- Test BOTH connector kinds. Mutation-verified in src/server/services/health-check.service.test.ts (`tracking identity (AC 2.1-2.5)` block, :1599-1736): keying by `checkName` turns 6 tests red, but dropping ONLY the `download-client` arm turns exactly one red — every indexer-based identity test passes with that arm missing.

Related: [[stable-list-keys]] is the client-side instance of the same 'a field-based key still collides' failure.

## degenerate-full-form-under-lossy-fold

**source:** #2103, #2110, #2113
**added:** 2026-08-04
**files:** src/core/utils/title-variants.ts, src/core/utils/title-variants.test.ts, src/server/services/series-title-match.ts
**tags:** title-matching

---

An asymmetric matching rule of the form "a FRAGMENT of one title may match the COMPLETE other title,
but fragment≡fragment never matches" is only sound while the normalizer cannot turn a complete title
INTO one of its own fragments. A lossy character-class normalizer breaks that precondition, so the
rule's safety is a property of the PAIR (rule + normalizer), not of the rule.

Concretely: `normalizeTitleForVariantMatch` (`title-variants.ts:93-105`) strips everything outside
`[a-z0-9' ]` after an NFD fold that only rescues DECOMPOSING letters — ß/ø/æ stay unfolded per the
#1547 scope pin, and no non-Latin script survives at all. `"World of Warcraft: Перед бурей"`
normalizes to exactly `world of warcraft`: a bare franchise prefix wearing the costume of a complete
title, which the asymmetric rule then legally matched against the `prefix(1)` of every sibling in the
franchise. That rewrites `books.series_name`/`series_position` on the wrong book — data corruption,
not a cosmetic miss.

**Detection is by character survival, not structure and not tokens.** `hasDegenerateFullForm`
(`:256-260`) asks whether the LOSSLESS normalization retains any character the ASCII fold would drop:
`/[^a-z0-9' ]/.test(normalizeTitleLosslessly(title))`, with an empty FULL form excluded (the G5
empty-variant guard owns that case). Two earlier shapes shipped and both were wrong, which is the
reusable part. A STRUCTURAL test ("qualifying colon boundary whose tail vanished") had to enumerate
every shape the erased content could take and missed each one it was not told about
(`"World of Warcraft (Перед бурей)"`). A TOKEN test ("does some whole token normalize to nothing?")
missed MIXED tokens — `"…: A前夜"` and `"…: A後夜"` both reduce to `world of warcraft a`, each tail a
single token whose scalar form is the non-empty `a`. Partial loss is loss. Characters are the
granularity at which the fold actually discards information, so that is where the question belongs.

**The gate is two-sided and FULL≡FULL is NOT exempt.** In `explainShapePairing`
(`series-title-match.ts:204-237`, rows 4-8): the derived arm refuses a degenerate TARGET *and* a lossy
OFFERED variant (`findDerivedOffer`, `:133-136` — `"…: Тревелер (Traveler)"` must not claim a bare
`"World of Warcraft"` through a fragment whose distinguishing characters the fold ate, #2110); and
equal FULL forms with either side degenerate demand agreement under `normalizeTitleLosslessly` before
pairing (`explainEqualFulls`, `:240-260`). A book genuinely titled `"World of Warcraft"` still matches
its own copy — via that lossless equality, not via an ungated arm. Position rescue is untouched
(evaluated first and independently, `:311-313`), so a degenerate title is never made unmatchable.

**The lossless twin must be bounded as carefully as the lossy one (#2113).** A normalizer that claims
to preserve identity must not inherit an unqualified combining-mark strip from its lossy twin. `NFD` +
an unqualified U+0300–036F strip is script-agnostic, and outside Latin the thing it deletes is often a
letter, not an accent: Cyrillic й decomposes to и + U+0306, so `'…: май'` and `'…: маи'` fold together
— through exactly the arm whose purpose is refusing that. A keep class that omits `\p{M}` compounds
it, turning Devanagari matras, Arabic harakat and Hebrew niqqud into word-fragmenting spaces
(`'किताब'` → `'क त ब'`), producing false pairs AND false refusals.

So `normalizeTitleLosslessly` (`title-variants.ts:181-194`) strips only when the preceding base is
Latin — `.replace(/(\p{Script=Latin})[\u0300-\u036F]+/gu, '$1')` — keeps `\p{M}` in the class, and
puts `.normalize('NFC')` at the very END, after the whitespace collapse and trim. That trailing NFC is
load-bearing, not cosmetic: the pipeline decomposes, so without recomposing, an ordinary composed test
literal never equals the function's output. Vietnamese tone marks (U+0323 in `'Sạch'`) are inside the
band and correctly still fold.

**The trap: do NOT widen that strip to `(\p{Script=Latin})\p{M}+`.** It passes every in-block fixture
— accent-drift tolerance, the Cyrillic refusals, the Devanagari refusals — while breaking the lockstep
premise the degeneracy detector rests on. `hasDegenerateFullForm` compares this fold's output against
`[a-z0-9' ]` to decide what the SCALAR fold discarded, and the scalar's diacritic step is also
U+0300–036F-bounded. A mark outside the band on a Latin base (U+1DC0, U+20DD) is therefore NOT removed
by the scalar either — it falls through to `[^a-z0-9' ]+` and fragments the word. `'Sa᷀ga: Book One'`
scalar-folds to `'sa ga book one'`; keeping the mark here yields `'sa᷀ga book one'` and a correct
`degenerateFull: true`, stripping it yields `'saga book one'` and a genuinely lossy title silently
trusted as complete. Mutation-verified: the widened strip fails exactly one test
(`'flags an out-of-block combining mark on a Latin base (AC9)'`) and leaves the rest green. **When two
folds must agree about what was lost, any asymmetry in their character bands is a silent divergence —
pin the boundary with a fixture on each side of it.**

Corollary, decided in #2110 and not to be relitigated without new corpus evidence: optional
pointing/vocalization is NOT equivalent to its unpointed spelling (`'סֵפֶר'` ≠ `'ספר'`,
`'كِتاب'` ≠ `'كتاب'`). "Pronunciation aid" vs "identity-bearing vowel" is not decidable from
`\p{Mn}`/`\p{Mc}` — Devanagari matras span both, and any rule equating pointed with unpointed would
also have to fold the Devanagari refusal case. In a matcher a false refusal costs a missing badge
(other signals still rescue it); a false pair puts a wrong badge on a different book. Same posture the
module already takes on non-decomposing ß/ø/æ.

Two transferable lessons. (1) When designing any "one side must be the whole thing" rule, ask what the
normalizer can destroy — then gate every arm that leans on completeness, including the symmetric one.
(2) This class is structurally invisible to a hand-written fixture corpus, because authors write test
titles in the script they think in; it took the live-library sweep (633 books) to surface it. That is
the concrete argument for keeping a real-corpus check as a merge requirement.

Verified non-vulnerable rather than assumed: `src/shared/dedup.ts` (`normalizeTitleCore` at `:51-63`
does no character-class strip, and `titlesMatchForDedup` at `:119` already blocks two subtitled titles
via `hadSubtitle`), `match-validation.ts` (token-set containment; an empty significant-token set
returns false by design at `:108`), `series-normalize.ts` (`:6`) and `hardcover-series-resolver.ts`
(lossy ASCII keys but exact-equality only, no prefix arm).

## fs-spy-over-importactual

**source:** #2107
**added:** 2026-08-04
**files:** src/server/services/merge-boot-recovery.test.ts, src/server/utils/paths.ts
**tags:** vitest, test-doubles, node-fs

---

When a suite must exercise REAL filesystem semantics (symlink resolution, recursive delete, ENOENT classification) *and* inject specific errno failures from a D6-style taxonomy, mock `node:fs/promises` partially and default the mocked functions to the real implementations:

```ts
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  readdir: vi.fn(), rm: vi.fn(), realpath: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (readdir as Mock).mockImplementation(actualFs.readdir as never);
  (rm as Mock).mockImplementation(actualFs.rm as never);
  (realpath as Mock).mockImplementation(actualFs.realpath as never);
});

// then, per test:
(rm as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })));
```

Everything not named in the factory (`mkdir`, `writeFile`, `symlink`, `stat`) stays real through the spread. Two rules make it hold:

1. **Establish the real implementation in `beforeEach`.** The factory's `vi.fn()`s are constructed with NO implementation, so an unarmed call returns `undefined` instead of doing fs work. (Note: it is *not* `vi.clearAllMocks()` that removes it — `mockClear` preserves implementations and does not drain `*Once` queues; see `vitest-clearallmocks-once-queue`. `beforeEach` is simply the only place with access to the `actualFs` handle in a readable form.)
2. **Use the `actualFs` handle for every fixture and assertion call.** The imported binding is the spy — an existence check written as `await readdir(dir)` will consume a `mockImplementationOnce` rejection armed for the code under test, and the test passes for the wrong reason. Reference: the `exists()` helper, `seedBook`/`seedStaging`, and the `afterEach` teardown in `src/server/services/merge-boot-recovery.test.ts` all go through `actualFs`.

Spying `realpath` also reaches `src/server/utils/paths.ts`, which imports it from the same module — that is how `assertRealPathInsideLibrary`'s ENOENT-swallow vs non-ENOENT-propagate split gets separate coverage from one suite.

**Prove it isn't vacuous.** The pattern's whole value is that the real-fs assertions *can* fail; close with the counterfactual (e.g. swap `assertRealPathInsideLibrary` for the lexical `assertPathInsideLibrary` and confirm the symlink-escape test goes red). See `vacuous-assertion-observation-points`.

Related but distinct: `import-cleanup-marker-aware-fs-mock` (defaulting a *fully* mocked `stat` so a marker doesn't read as present) and `windows-hostile-test-primitives` (the `symlink()` capability probe and tolerant tmpdir teardown these fixtures still need).

## sqlite-covering-index-forces-scan-order

**source:** #2115
**added:** 2026-08-04
**files:** src/server/services/series-title-match-blast-check.test.ts, src/server/services/series-card.integration.test.ts
**tags:** sqlite, libsql

---

To prove an `ORDER BY` is load-bearing you must make the planner return rows in a DIFFERENT order without it — otherwise rowid order satisfies the assertion and the test passes against the unordered code. Which index achieves that depends on the query's shape:

- **Constrained query** (`WHERE col IN (…)`): a NARROW index on the filtered column is enough — the plan flips to `SEARCH … USING COVERING INDEX (col=?)` and rows arrive in `col` order. This is what `series-card.integration.test.ts` uses for `loadLibraryBooksForSeriesNames`.
- **Unconstrained query** (`SELECT … FROM t`, no WHERE): a narrow index does NOTHING — SQLite keeps `SCAN t` because a non-covering index scan is never cheaper than the table scan. You need an index COVERING every referenced column before the plan becomes `SCAN t USING COVERING INDEX` and the order changes. This is what `series-title-match-blast-check.test.ts` needs for the blast-check replay loader.

Measured (drizzle-orm@0.45.2 + @libsql/client, migrated schema, ids ascending while `series_name` collation descends), query `SELECT id, title, series_position, series_name FROM books`:

```
no index                                                    → SCAN books                      → [1,2,3]
CREATE INDEX ON books (series_name)                         → SCAN books                      → [1,2,3]
CREATE INDEX ON books (series_name, title, series_position) → SCAN books USING COVERING INDEX → [3,2,1]
```

Three indexed columns cover a four-column projection because `id` is the rowid, which every SQLite index carries implicitly — so "covering" means covering the non-rowid columns.

Related trap: a rowid-only projection (`SELECT id FROM books`) stays in rowid order even under the covering index, so the no-ORDER-BY probe must mirror the production query's full projection.

**Always assert the reordering as an explicit precondition** (`expect(await idsWithoutOrderBy()).toEqual([…non-ascending…])`) rather than trusting the index to bite. Without it the case silently degrades to the vacuous form when a schema or projection change stops the index covering — the general failure mode catalogued in [[vacuous-assertion-observation-points]]. Filtering a loaded list in JS preserves order, so pinning the loader's order pins every derived pool; assert a filtered subset too, and make its members collate opposite to their ids or that assertion survives the mutation the first one catches.

## regex-v-flag-needs-es2024-target

**source:** #2097  
**added:** 2026-08-07  
**files:** src/core/metadata/hardcover-member-dedup.ts  
**tags:** typescript

---

The repo's `tsconfig.json` pins `target: "ES2022"`, and TypeScript gates the regex `v` (unicodeSets) flag on `es2024` or later: `/[\p{L}--\p{Script=Latin}]/v` fails typecheck with `TS1501: This regular expression flag is only available when targeting 'es2024' or later`. This is a COMPILE-time gate and is independent of the runtime — `engines.node` is `>= 24.10` and Node executes the flag fine.

The error message suggests raising the target, which is the wrong move — one tsconfig compiles client, server, core and db, so a language-level bump for one predicate has repo-wide reach. Write the set difference as a per-code-point scan with two separate property escapes instead. `isScriptCleanTitle` (src/core/metadata/hardcover-member-dedup.ts, #2097) is the reference implementation: hoisted `const ANY_LETTER = /\p{L}/u` and `const LATIN_LETTER = /\p{Script=Latin}/u`, then `for (const char of title) if (ANY_LETTER.test(char) && !LATIN_LETTER.test(char)) return false`. Two details matter — `for…of` over a string iterates code points, so astral letters are tested whole rather than as surrogate halves; and neither regex carries `g`, so there is no `lastIndex` carried between calls.

Same applies to any other `v`-only syntax (nested classes, string properties, `\q{…}`), not just set difference.

## staged-metadata-authors-min-one

**source:** #2158  
**added:** 2026-08-07  
**files:** src/core/import-staging/schemas.ts  
**tags:** zod, import-staging, test-fixtures

---

`stagedBookMetadataSchema` (`src/core/import-staging/schemas.ts`) declares `authors: z.array(stagedAuthorRefSchema).min(1).max(64)`, and `stagedImportItemSchema` refines `metadata` to it. So for any staged import item, `item.metadata?.authors?.length` is either `undefined` (metadata absent) or `>= 1` — **never 0**. Any precedence rule phrased as "only when the provider supplied no authors" is therefore reachable ONLY via the metadata-absent path, which is usually a different branch in the consuming code.

The fixture trap (measured on #2158): a test meant to prove "a multi-author OPF must not override the folder author" built its item WITHOUT `metadata`. That routes through the synthesize-from-scratch branch, never reaches the guarded overlay write, and stays green under the exact mutation it exists to catch (making the `metadata.authors` write unconditional). The branch that actually needs forcing is `buildBookCreatePayload`'s multi-author preference in `enrichment-orchestration.helpers.ts` — `(meta?.authors && meta.authors.length > 1)` wins outright over `item.authorName` — so the fixture needs a provider match carrying **exactly one** author alongside **two** OPF `aut` creators. See 'AC10 headline' in `import-submission-runner.integration.test.ts`.

General rule: before writing a fixture for an "only when X is absent" branch, check whether the schema permits X to be absent at all in the shape you are building — an absent *field* and an absent *parent object* are usually two different code paths, and only one of them is the branch under test. Related: [[round-trip-fixture-discipline]] (arm 2), [[vacuous-assertion-observation-points]].

## variant-tag-not-slice-under-first-wins-dedup

**source:** #2138  
**added:** 2026-08-07  
**files:** src/server/services/search-query-ladder.ts  
**tags:** title-matching, search-ladder

---

`titleVariants` (src/core/utils/title-variants.ts) dedups on `normalizeTitleForVariantMatch(text)` with FIRST occurrence winning, iterating n descending and pushing `prefix(n)` before `suffix(n)`. So a variant's TAG is a promise about which slice it names; the TEXT is not. Any admission, floor or ordering policy that reasons about segment position must key on the tag.

The two readings — "tag is `suffix(1)`" vs "this slice equals the last effective segment" — coincide whenever a `suffix(1)` is emitted at all, and diverge exactly where dedup reassigned the text. Both divergences are real library shapes and both are pinned in `search-query-ladder.test.ts`:

- **Collapsed anchors.** `"Star Wars: The High Republic: Star Wars"` — at n=1, `prefix(1)`='star wars' is pushed first, so the identical `suffix(1)` is never emitted. A slice-based exemption admits a bare `star wars` query: the pure-franchise rung the segment budget exists to suppress.
- **Leading punctuation-only segment.** `"---: Alpha: Beta: Gamma"` — the tail text 'gamma' is emitted under `first+last`, whose slice `['', 'gamma']` carries the normalization-empty segment. A slice-based exemption consulted before the empty-slice rejection admits a one-element garbage floor `['gamma']`.

This is why `isBudgetExempt(tag)` in `src/server/services/search-query-ladder.ts` is tag-keyed, and why the empty-slice rejection (step 1) stays strictly ahead of the budget exemption (step 2) in `admitVariants`. Making the exemption slice-based AND moving it before step 1 reds five tests, including the pre-existing `#2133 AC43` first+last pin.

**Corollary, measured on #2138:** step 1 is unreachable for `suffix(1)` in particular. Its slice is one element, and if that element normalizes empty the generator's own empty-`raw` guard never emits the variant — so the rejection reduces to that upstream guard. Keep step 1 regardless: it still binds `first+last`, `prefix(n)` and `suffix(n>1)`, where slices genuinely can carry an empty segment. Don't "simplify" it away on the grounds that one tag can't reach it.

General form: when a generator deduplicates its own output, downstream policy may only trust the labels the generator assigns, never re-derive position from the payload.

## compat-wrapper-hides-stale-test-doubles

**source:** #2104  
**added:** 2026-08-07  
**files:** src/server/services/indexer-search.service.ts  
**tags:** vitest, test-doubles

---

When you widen a service method's return type (e.g. `T[]` → `{ results: T[]; succeeded: number }`) and keep the old method as a compatibility wrapper, production callers migrate but TEST DOUBLES do not — and in this repo they are built with `inject<T>()` / `as unknown as T`, both of which erase property checking, so `pnpm typecheck` cannot see the drift.

The damage is worse than a plain stale mock when the new field encodes a DEGRADED state. `#2104` added `IndexerSearchService.searchAllWithStatus`, whose `succeeded` count exists to tell a real, answered zero apart from a total indexer outage. Roughly ten suites still mocked `searchAll`, so the destructured `succeeded` was `undefined` and every one of them silently exercised the outage branch — the exact condition the field was introduced to detect. Several tests still PASSED, because 'outage' and 'genuine zero' both resolve to `no_results` on the auto-grab path; the only reason the drift surfaced at all is that a handful of call-count assertions changed.

Practical rule: treat widening a service return shape as a two-part change — migrate the callers AND sweep the doubles in the same commit. Grep for the old method name across `*.test.ts` before declaring it done (`grep -rn '\.searchAll\b' src/`), and give the suite a single `withStatus(results)` helper so the envelope is spelled once rather than at ~30 call sites. If the new field has a value that means 'degraded', prefer a shape where the STALE value is impossible rather than merely wrong — e.g. return a discriminated union, or have the wide method throw on a missing count — so a forgotten double fails loudly instead of quietly taking the sad path.

Related: [[shared-test-double-defaults]] carries the Drizzle-shaped instances of the same family (a stale test double's default selecting a degraded branch); this entry is the service-return-shape instance, and its distinguishing feature is that the compatibility wrapper is precisely what keeps the compiler quiet.

**The `vi.mock` family — nothing here is typechecked.** A mock factory's return value is unconstrained by `@types/*`, and this repo's doubles use `inject<T>()` / `as unknown as T`, which erase property checking. Five ways that drifts, each silent until runtime and each in its own entry because they bite different files: the factory does not intercept a same-module call ([[esm-same-module-vi-mock-bypass]]); it omits a schema table and crashes an unrelated suite at import ([[drizzle-schema-toplevel-deref-breaks-partial-mocks]]); it replaces a barrel and drops named exports, or preserves one and leaks real network calls ([[vimock-barrel-replace-drops-named-exports]]); its implementation is an arrow where production uses `new` ([[vifn-arrow-not-constructable]]); or its return SHAPE goes stale behind a compatibility wrapper ([[compat-wrapper-hides-stale-test-doubles]]). Deliberately not merged: the five have disjoint file scopes, so one entry would inject all of it whenever any one file is touched.

## raw-output-pins-incidental-whitespace

**source:** #2109  
**added:** 2026-08-07  
**files:** src/core/utils/title-variants.ts  
**tags:** title-matching, test-fixtures

---

When a function's docblock promises RAW / unnormalized output, its incidental formatting — whitespace-run width in particular — becomes part of the observable contract, because callers and tests are entitled to read it literally. A rewrite of an upstream helper that is provably equivalent AFTER normalization can therefore still be a breaking change.

Concrete instance (#2109): `titleSegments` (src/core/utils/title-variants.ts) is documented as returning "RAW segment text, unnormalized", and `title-variants.test.ts` pins `[..., ' Light of the Jedi  ']` down to the two trailing spaces. `stripParentheticals` was replaced by a depth-counting scan to handle unbalanced and nested groups (which its `\([^)]*\)` regex could not match) and to remove a quadratic backtracking path. The regex emitted ONE space per balanced group; a scan emitting one space per CHARACTER is identical after `normalizeTitleForVariantMatch` but fails that fixture. The spec's AC1 described the per-character form while AC4 froze every behavioural fixture — the two collided, and the per-character phrasing turned out to be a description of the algorithm rather than of anything observable.

The fix: track a `runEmitted` flag so one CONTIGUOUS stripped run contributes exactly one space. That is byte-identical to the regex form for every balanced, non-nested input, so no existing corpus moves, while the unterminated-group and nested-group defects are still fixed. It is safe here specifically because the only production consumer of the raw list — `admitVariants` in `src/server/services/search-query-ladder.ts` — normalizes each segment immediately, and every `Variant.raw` is whitespace-collapsed.

General rule: before rewriting a helper that feeds a raw-output export, grep that export's consumers and its test fixtures. If the fixtures pin whitespace, preserve the run structure rather than the per-character mechanism — and if a spec's AC describes the mechanism in a way that contradicts a fixture freeze, the fixture is the contract and the AC is describing the implementation. Sibling raw/normalized pair with the same exposure: `cleanNameWithTrace` in src/server/utils/folder-parsing.ts.

## security-fixture-absent-resource-negative

**source:** #2158  
**added:** 2026-08-07  
**files:** src/server/utils/opf-reader.test.ts  
**tags:** xxe, xml

---

**A negative assertion about EXTERNAL content cannot prove a security invariant, because the fixture is inert wherever that external content is absent.**

An XXE regression test written as `expect(title).not.toContain('root:')` passes for at least four different reasons, only one of which is the intended one:

1. the parser correctly refused to resolve the entity (intended);
2. the parser resolved it, but `/etc/passwd` does not exist on this host — **every Windows dev box and most distroless/hardened containers**, i.e. exactly where [[windows-hostile-test-primitives]] already warns the Linux pipeline is blind;
3. the parser resolved it to content that happens to lack those substrings;
4. the parser dropped the entity, or expanded it only partially.

A size threshold (`length < 1000`) for a billion-laughs payload has the same defect: one expansion step satisfies it.

**Assert the exact literal reference instead.** Measured on the pinned stack, `cheerio.load(xml, { xmlMode: true })` returns entity references verbatim — `&xxe;` stays `"&xxe;"`, `&lol8;` stays `"&lol8;"` — so `expect(parseOpf(xml)?.title).toBe('&xxe;')` is available and fails for every one of modes 2–4. It also fails closed for an entity-dropping parser when the title is the document's only usable field, since the reader then returns `null`.

Cover all three vectors the `core/epub/xml.ts` module doc names: `SYSTEM` file entity, parameter entity declaring a general entity (`<!ENTITY % pe "<!ENTITY leaked 'expanded'>">%pe;` → `&leaked;`), and billion-laughs. Prior art in the repo, correct since #1987: `src/core/epub/xml.test.ts`. `src/server/utils/opf-reader.test.ts` now matches it (#2158/#2160 F2).

Keep a wall-clock bound only as an explicitly-labelled *liveness* guard — a fully-expanding parser would hang the run rather than fail it — never as the correctness control. Validate any such fixture by simulating the parser swap (substitute the entity at the `load` call site with resolved / innocuous / dropped / partially-expanded text) and confirming every row reds. Related: [[vacuous-assertion-observation-points]] (this is its stimulus-side twin — the observation point is fine, the *assertion* is too weak), [[htmlparser2-no-attribute-normalisation]] (measure the parser, don't infer from the spec).

## symmetric-mutation-cannot-observe-shared-derivation

**source:** #2133, #2060  
**added:** 2026-08-07  
**files:** src/server/services/search-query-ladder.ts, src/client/pages/library-import/useLibraryImport.ts  
**tags:** mutation-testing, search-ladder

---

Two ways the mutation you ran fails to isolate the property you claim. Both produce a confident,
wrong red-set prediction that survives spec review.

**A — shared derivation, mutated symmetrically (#2133).**

`countOccurrences(text, segment)` in `src/server/services/search-query-ladder.ts` serves BOTH `anchorFloor` (how many copies of each anchor the canonical title demands) and `passesSegmentFloor` (how many the release supplies). Mutating it is therefore SYMMETRIC — the demanded count and the measured count move together, the check stays self-consistent, and any test asserting "the book still matches its own release" stays GREEN.

Measured on #2133: changing the scan restart from `at + segment.length + 1` to `+ 2` reds 6 tests, and all six are SIBLING-side (`Alpha: Beta Gamma: Delta` and `Alpha: Gamma` now pass, plus the AC9 property, the AC9(c) self-pass table, and the auto-path sibling-hold regression). To pin the own-side property you must mutate ONE side only — inline the broken scan inside `passesSegmentFloor` and leave `anchorFloor` correct; that asymmetric variant reds exactly the own-title rows.

Two rules follow. (1) Choosing which mutation to run is part of the assertion design: a shared-derivation invariant needs an ASYMMETRIC mutation, and a spec naming a symmetric one will over-predict its red set. (2) Never predict a red set by reading — run the mutation and record what actually failed. The #2133 spec predicted observations that did not fire at all, and had additionally attributed them to the wrong fixture: `"Star Wars: The High Republic: Star Wars"` looks like the repeated-anchor case, but its two occurrences are separated by an intervening segment, so the shared-delimiter rule never touches it; only `"Alpha: Beta Gamma: Gamma"` has genuinely adjacent occurrences.

**B — redundant sites, mutated one at a time (#2060).**

When two production sites are INDEPENDENTLY SUFFICIENT to produce the asserted outcome, mutating either one alone leaves the suite green — the other still produces it. `ImportRow.matchGeneration` is stamped at four sites per hook (`useLibraryImport.ts`, `useManualImport.ts`); the Restart regressions exercise a timeline where a Restart is ALWAYS followed by a match merge, so the `handleRestartMatch` stamp and the `mergeMatchResults` stamp are each enough on their own to make `isLiveTarget` reject the held response.

Measured against the full client project (287 files / 5912 tests): dropping the restart stamp — green. Forwarding `r.matchGeneration` instead of a fresh generation at restart — green. Dropping the `stampRow` wrapper at the merge — green. Dropping restart AND merge together — red. #2060's spec asserted the second of those would red, and that survived eight spec-review rounds before first execution falsified it.

Procedure: before mutating, trace every write that can produce the asserted post-state ALONG THE TEST'S TIMELINE, not just the one the spec names. If more than one exists, mutate them as a set — and separately cover each site with a test whose timeline reaches only that site (here, a merge with no preceding Restart). Note the observation point was never the problem: the test reds correctly once both stamps go.

Sibling: [[vacuous-assertion-observation-points]] — that one is about watching the wrong OBSERVABLE, this one is about applying the wrong MUTATION.

## abort-verdict-not-error-shape

**source:** #2080  
**added:** 2026-08-08  
**files:** src/core/utils/cover-art.ts  
**tags:** cancellation

---

**A catch-and-degrade block is a cancellation sink.** Best-effort code that swallows an error and returns a fallback (`return null` / `return false` / push a warning) swallows cancellation on the same path. Where the block runs BEFORE the main work the cost is a lost feature; where it runs AFTER it reports SUCCESS for a cancelled operation — in #2080 a degraded cover-reattach returned a successful result that flowed into `removeSourceFiles`, deleting the sources of a merge the operator had just cancelled.

Shape for every such catch: existing cleanup first (the partial temp file must still go), then `if (signal?.aborted) throw error;`, then today's degradation return.

**Key the verdict on `signal.aborted`, never on the error.** One cancellation produces at least three error shapes: a pre-spawn guard's own `Error('Processing aborted')`, `Error('ffmpeg exited with code null')` when the abort listener SIGTERMs a running child, and `AbortError`/`ABORT_ERR` from an aborted `execFile`. Only the first is recognisable by message, and the second is textually identical to an ordinary encode failure — so any message/name/instanceof check passes one case and silently degrades the other two.

**Swallow-and-continue loops are the same defect with a worse symptom.** A loop that treats each item's error as "skip this one" will, under an already-aborted signal, fail every remaining item instantly and return an empty result — cancellation reading as a legitimate "nothing found" while the caller proceeds. The abort check must sit inside the per-item catch, not only around the loop.

Keep a control test proving a genuine failure under a LIVE (un-aborted) signal still degrades; without it, a rethrow-on-every-error regression is invisible. Related: [[symmetric-mutation-cannot-observe-shared-derivation]] — prove each rethrow by reverting one at a time.

## zod-entry-catch-preserves-record-predicate

**source:** #2168  
**added:** 2026-08-08  
**files:** src/core/metadata/audnexus.ts  
**tags:** zod, metadata-providers

---

When a Zod schema gates a CACHED definitive-vs-transient classification, adding per-entry parsing to one of its arrays narrows the record predicate unless each entry carries a fallback. `z.array(z.unknown())` accepts any element; `z.array(z.object({...}))` rejects the WHOLE body on one malformed element — and in a cached adapter that reclassifies a genuine record as `invalid_record`, which is transient, never settled, and therefore re-requested on every lookup forever. The derived value it was added for is lost too.

Use a per-entry `.catch()`:

```ts
const entrySchema = z.object({ title: z.string().nullish(), lengthMs: z.number().nullish() })
  .passthrough()
  .catch({});
```

Verified on zod 4.4.3: a bare string, a bare number, `null`, or `{ lengthMs: 'oops' }` each become `{}` while well-formed entries parse normally, so the outer authority predicate admits exactly the same set of bodies as before. The consumer must then narrow (never coerce) the fields — a `{}` entry simply fails whatever check it feeds.

The rule: a malformed ELEMENT is a data-quality problem that should degrade the derived value; only a malformed RECORD should change whether the response was authoritative. Those two decisions belong in different places.

## ugrep-nul-fixtures-hide-files

**source:** #2075  
**added:** 2026-08-08  
**tags:** audit-sweep

---

*(No `files:` scope on purpose — this is a tooling rule that applies to any sweep, not to one code path.)*

`grep` on the pipeline image is **ugrep 7.5.0**, not GNU grep. A file containing NUL/control bytes is classified as binary and yields **zero matches, exit 1, and no notice** unless `-a`/`--text` is passed — under `-r`/`-l` there is not even a "Binary file … matches" line. The file is silently absent from the result set.

Measured: `grep -rl --include=*.ts -a "import" src` → 1085 files; the same search without `-a` → 1083. The two that drop out both write raw control bytes into a test string literal instead of using escapes. Both are valid UTF-8, so this is triggered by the control bytes, not by an encoding error.

**The rule.** Any grep whose *absence of hits* is load-bearing — an audit-completeness sweep, a refactor site inventory, a "no remaining callers" claim — must pass `-a`. A plain `grep -rn` returning nothing is not evidence that nothing matches. When authoring a binary fixture, write it with `'\^@\^A'`-style escapes: the runtime string is byte-identical and the source file stays plain text, so it remains visible to every tool.

This is an environment fact about the pipeline image; re-verify it if the base image changes. Related: [[vacuous-assertion-observation-points]] — same shape, an observable that cannot see the property being claimed.
