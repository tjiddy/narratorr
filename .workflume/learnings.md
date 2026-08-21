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

**source:** #1992, #1993, #2002, #2012, #2020, #2032, #2017, #2082, #2210
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
verify with `pnpm exec tsc --noEmit` and confirm a non-zero exit. Never infer that verdict from a
grep over the output: strip ANSI first (`sed -e 's/\x1b\[[0-9;]*m//g'`) and preserve the producer's
status (`PIPESTATUS[0]` in bash, or redirect then inspect). A failed `tsc` can otherwise produce no
matching `error TS` text while the pipeline reports only grep's status.

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
**files:** src/core/utils/title-variants.ts, src/core/utils/title-variants.test.ts, src/server/services/series-title-match.ts, src/server/utils/series-name-targets.ts, src/server/utils/series-normalize.ts
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

**A second mechanism in the same family, found later (#2175).** The prefix/fragment arm is not the
only way a lossy fold does damage: a fold that can EMPTY a string collapses every emptying input into
one bucket. `normalizeSeriesName` keeps only `[a-z0-9]`, so `'Dozory'` in Cyrillic, CJK titles, `'!!!'`
and `''` all fold to `''` — and keying a candidate POOL on that puts every non-Latin-script series in
the library together, which on the bind path becomes a durable cross-series rewrite of
`books.series_name`. The fix is two arms, always a union and never a mode switch: the normalized
equivalence class for names whose fold survives, and byte-identical spelling only for names that fold
to empty (`buildSeriesNameTargets` / `seriesNameMatchesTargets`, `src/server/utils/series-name-targets.ts`).

This is invisible to the degeneracy audit above, which asks what the fold DISCARDS from one title —
not what two titles collapse ONTO. Any equality or pooling decision built on a lossy fold needs both
questions asked.

`hardcover-series-resolver.ts` survives this one too, by construction rather than luck: the normalized
retry is gated on `normalizedName.length > 0`, `searchSeries` falls back to the raw name via
`normalizedName || opts.seriesName`, and `scoreCandidate` runs a dice coefficient on RAW names behind
a separate author-overlap gate — so it never compares two empty folds.

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

**source:** #2115, #2175
**added:** 2026-08-04
**files:** src/server/services/series-title-match-blast-check.test.ts, src/server/services/series-card.integration.test.ts
**tags:** sqlite, libsql

---

To prove an `ORDER BY` is load-bearing you must make the planner return rows in a DIFFERENT order without it — otherwise rowid order satisfies the assertion and the test passes against the unordered code. Which index achieves that depends on the query's shape:

- **Equality-constrained query** (`WHERE col IN (…)`): a NARROW index on the filtered column is enough — the plan flips to `SEARCH … USING COVERING INDEX (col=?)` and rows arrive in `col` order.
- **Range query** (`IS NOT NULL`, `>`, `<`, `BETWEEN`): treat it like the unconstrained case. A non-covering index is still not cheaper than the table scan; only an index covering the projection reliably changes the order. `IS NOT NULL` appears as `col>?` in the plan.
- **Unconstrained query** (`SELECT … FROM t`, no WHERE): a narrow index does NOTHING — SQLite keeps `SCAN t` because a non-covering index scan is never cheaper than the table scan. You need an index COVERING every referenced column before the plan becomes `SCAN t USING COVERING INDEX` and the order changes. This is what `series-title-match-blast-check.test.ts` needs for the blast-check replay loader.

Measured (drizzle-orm@0.45.2 + @libsql/client, migrated schema, ids ascending while `series_name` collation descends), query `SELECT id, title, series_position, series_name FROM books`:

```
no index                                                    → SCAN books                      → [1,2,3]
CREATE INDEX ON books (series_name)                         → SCAN books                      → [1,2,3]
CREATE INDEX ON books (series_name, title, series_position) → SCAN books USING COVERING INDEX → [3,2,1]
```

Three indexed columns cover a four-column projection because `id` is the rowid, which every SQLite index carries implicitly — so "covering" means covering the non-rowid columns.

Measured after #2175 changed `loadLibraryBooksForSeriesNames` to `WHERE series_name IS NOT NULL`:

```
CREATE INDEX ON books (series_name)                                        → SCAN books                                      → [1,2,3]
CREATE INDEX ON books (series_name, title, series_position, user_cleared_fields) → SEARCH books USING COVERING INDEX (series_name>?) → [3,2,1]
```

The narrow index that worked for the old `IN (…)` query left the ordering fixture vacuous. The
series-card test now uses the four-column covering index and asserts the unordered probe is actually
non-ascending before it tests production's `ORDER BY`.

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

## removequeries-mounted-observer-refetch

**source:** #2220
**added:** 2026-08-10
**files:** src/client/pages/activity/useImportHistoryDeletion.ts, src/client/hooks/useImportReport.ts, src/client/pages/activity/ImportHistorySection.delete.test.tsx
**tags:** react-query, test-observability, vitest

---

`queryClient.removeQueries()` is an eviction, not a tombstone. If a component still observes that
key, it can immediately recreate the query and refetch; a read double that keeps resolving then
re-seeds the cache. With `staleTime: 0` and `refetchOnMount: 'always'`, an assertion that
`getQueryData(key)` stays undefined races that refetch.

Model the deletion in the double: when the mutation resolves, make subsequent reads return the same
404 as the server. Increasing `waitFor`'s timeout cannot fix a resolving refetch. Afterward, mutate
away the eviction and confirm the test still reds; otherwise the 404 double may be proving the
server model while the cache assertion proves nothing. Related: [[react-query-mutation-callbacks-post-unmount]], [[observation-points-react-query-error-state]].

## recording-identity-production-veto-after-duration

**source:** #2219
**added:** 2026-08-10
**files:** src/core/utils/recording-identity.ts, src/server/services/metadata-recording-collapse.ts, src/server/services/metadata.service.test.ts
**tags:** title-matching, metadata-providers

---

`resolveRecordingIdentity` intentionally treats two positive durations as authoritative: its duration
branch returns before the abridged/unabridged conflict check. Supplying `productionType` therefore
adds no veto on a path that already requires positive runtimes.

A caller that requires both runtime corroboration and a production-form veto must enforce the latter
as a stricter admission rule, as `metadata-recording-collapse.ts` does. Do not reorder the shared
primitive or relax the duration requirement to obtain that result; #1728 and #1854 deliberately
settled the opposite policy for the primitive. Pin the stricter behavior at the caller—an assertion
against `resolveRecordingIdentity` cannot detect a missing caller-side veto.

## ffprobe-show-entries-nested-sections

**source:** #2210
**added:** 2026-08-10
**files:** src/server/services/tagging.roundtrip.test.ts, src/core/utils/audio-processor.roundtrip.test.ts
**tags:** ffprobe, round-trip, audio-tags, test-observability

---

`ffprobe -show_entries` silently returns empty objects when a nested block is requested as a scalar
stream field. Measured on ffprobe 7.0.2, `stream=disposition` yields `{"streams":[{}]}` with exit 0;
the correct selector is `stream_disposition=attached_pic`. The same section split applies to
`stream_tags=<key>`. A negative assertion using the wrong selector will pass against every file.

Use the existing `hasAttachedPic` helpers in the two scoped round-trip suites. Separately, ffprobe
cannot observe the movement atoms `©mvn`/`©mvi` or ID3 `MVNM`/`MVIN`; assert those through
`readExistingTags`/music-metadata or a raw mutagen dump. Keep ffprobe for properties it can observe:
chapters, audio-stream duration, decodability, and attached-picture disposition. Related: [[round-trip-fixture-discipline]].

## shared-suite-state-inflates-counterfactual

**source:** #2206
**added:** 2026-08-10
**files:** src/server/__tests__/books.e2e.test.ts
**tags:** e2e, mutation-testing, test-observability

---

In a suite whose cases share one database or fixture set, an absolute total in a later case depends on
every earlier case. Under a production counterfactual, a supposed control can therefore red because
an earlier case changed—not because its own guarded behavior broke—and inflate the observed red set.

Assert the delta across the case's own action: read the count before, perform the action, and compare
after. Use a separate app/DB when the case needs a fixed initial shape. This is the over-reporting twin
of [[symmetric-mutation-cannot-observe-shared-derivation]]: run the mutation, but attribute each red to
the assertion that actually changed.

## connected-client-server-vitest-harness

**source:** #2200
**added:** 2026-08-10
**files:** src/client/__tests__/series-add-all-connected.test.tsx, src/client/lib/api/client.ts, src/server/__tests__/e2e-helpers.ts
**tags:** vitest, fastify, react-query, e2e

---

A component suite with `@/lib/api` mocked and a server suite using `app.inject()` can both stay green
while their request path or body contract is broken. Close that seam in Vitest by rendering the real
component in the client/jsdom project and routing relative `/api` fetches into a real
`createE2EApp()` instance. Return a real `Response`, record the literal request, and route non-`/api`
URLs separately for the server's outbound provider calls.

This harness checks the client path/body, route, persistence, and cache/UI reconciliation in one
process, and unlike `e2e/**/*.spec.ts` it runs under `pnpm verify`. It is not a browser/CORS test.
Reference: `series-add-all-connected.test.tsx`. Related: [[vimock-barrel-replace-drops-named-exports]].

## e2e-harness-cannot-gate-inprocess-guard

**source:** #2200
**added:** 2026-08-10
**files:** src/server/__tests__/series-add-all.e2e.test.ts, src/server/routes/books-series-add-all.test.ts, src/server/services/series-add-all.service.test.ts
**tags:** e2e, vitest, fastify, test-observability

---

An in-process concurrency guard's refusal branch exists only while another request is suspended in
the guarded region. A real-services E2E harness has no controllable collaborator there, so two
`Promise.all` requests may serialize and return 200/200; requiring 200/409 is a scheduling test.

Split the proof. E2E should accept either admission outcome and assert the durable row set both paths
must produce. A mocked-service route or service suite should gate an awaited collaborator, wait until
the first request is inside the guard, then issue the second and assert the refusal. Delete the guard
as a counterfactual: the deterministic suite must red; the E2E suite need not. Related: [[observation-points-server-writes-and-routes]].

## eslint-rule-test-harness

**source:** #2182
**added:** 2026-08-10
**files:** eslint-rules/, vitest.config.ts, eslint.config.js
**tags:** eslint, vitest, typescript

---

Local ESLint rules remain CommonJS `.cjs`, but Vitest RuleTester suites use ESM `.test.js` under this
repository's `"type": "module"` package. Import the rule as the default export, wire
`RuleTester.describe`/`RuleTester.it` to Vitest, and use `typescript-eslint`'s exported parser; the
standalone `@typescript-eslint/parser` package does not resolve from the repo root under this pnpm
layout.

The server project must explicitly include `eslint-rules/**/*.test.js`. Do not include the legacy
`.test.cjs` scripts until they are converted—they register no Vitest tests. The directory is ignored
by ESLint and outside the TypeScript project, so run its suites directly. For parent-walking rules,
remember that the typescript-eslint AST erases parentheses; there is no `ParenthesizedExpression`
node to step through. Reference: `no-unstamped-match-generation.test.js`.

Covers UNTYPED rules only. A rule that reads the type checker adds two failure modes that this
wiring does not — see [[typed-ruletester-program-hazards]] before writing one.

## swallowed-throw-type-via-reducer-spy

**source:** #2062
**added:** 2026-08-10
**files:** src/core/utils/audio-processor.test.ts
**tags:** vitest, test-observability

---

When production catches a typed error and reduces it to `{ success: false, error: string }`, the
result cannot prove which error class was thrown. If the catch delegates to an imported reducer such
as `getErrorMessage`, a passthrough `vi.mock` spy on that reducer preserves behavior while exposing
the original caught value for `toBeInstanceOf`.

Restore the real passthrough implementation in `beforeEach`; `vi.clearAllMocks()` clears history but
does not restore implementations. Use the spy for the negative control too so unrelated failures are
proved not to be the typed guard. This is a test-only observation seam, not permission to branch on
error identity in production; see [[abort-verdict-not-error-shape]].

## typed-ruletester-program-hazards

**source:** #2235, #2239
**added:** 2026-08-11
**files:** eslint-rules/no-direct-duplicate-check.cases.js, eslint-rules/no-direct-duplicate-check.test.js, eslint-rules/no-direct-duplicate-check.single-run.test.js
**tags:** eslint, typescript-eslint, ruletester, vitest, type-aware-lint

---

A RuleTester suite for a type-aware rule is backed by a TypeScript program that every case shares.
Two distinct defects fall out of that, one a crash and one silent. Both are live; neither fix
dissolves the other. Extends [[eslint-rule-test-harness]], which covers untyped-rule wiring only.

**1 — Crash under CI-inferred single-run parsing. Use `parserOptions.projectService: true`, never
`parserOptions.project`.** typescript-eslint's `inferSingleRun()` returns true when
`process.env.CI === 'true'`. In single-run mode `parser.ts` counts `parseAndGenerateServices` calls
per `filePath` and, from the second call for a path onwards, discards the project program for a
one-file `createIsolatedProgram` built from that case's `code` alone. Correct for ESLint's autofix
cycle; wrong for RuleTester, where cases deliberately share one `filename`. In the isolated program
the case's relative imports resolve to nothing, the module symbol has no backing source file, and
TypeScript throws `TypeError: Cannot read properties of undefined (reading 'includes')` from
`getSpecifierForModuleSymbol` to `normalizeSlashes`. Only cases that reach the checker crash, so the
failing set is a confusing subset. Symptom shape: green on every dev machine, red only on CI —
reproduce in seconds with `TSESTREE_SINGLE_RUN=true pnpm exec vitest run <file>`.
`disallowAutomaticSingleRunInference: true` is NOT the fix: `inferSingleRun()` reads the explicit
`TSESTREE_SINGLE_RUN` env var *before* that flag, so it greens CI while leaving the crash one
environment variable away. `projectService: true` is, because the isolated-program fallback is gated
on `!parseSettings.projectService`.

To keep that defect reachable without a CI runner, split the suite three ways: a non-collected
`*.cases.js` exporting the case set as a callable, an ambient `*.test.js` that sets NO env var (so
it still exercises the long-running path), and a `*.single-run.test.js` that assigns
`process.env.TSESTREE_SINGLE_RUN = 'true'` at module top. An explicit value wins ahead of every
other signal, so one file cannot both force single-run and observe the ambient mode — the split is
what makes both modes real. Vitest's default `forks` pool with `isolate: true` gives each file its
own process; restore the prior value in a top-level `afterAll` anyway, and use `delete` when it was
undefined (assigning `undefined` to `process.env.X` stores the STRING `'undefined'`).

**2 — Silent disarm by fixture redeclaration. `projectService` does not fix this** — the language
service keeps the program FRESH, not IMMUTABLE, so it still adopts each case's `code` for its
filename. Mutations persist across cases in declaration order (all of `valid[]` before all of
`invalid[]`), so a case that redeclares a SHARED fixture module with fewer members erases them for
every later case. The symptom is a subset of invalid cases reporting 0 errors, which reads as the
rule's type resolution being wrong for some call shapes rather than as fixture corruption. In #2235
an exemption case inlined a shortened `class BookService`; every later case resolving `findDuplicate`
through it got an undefined symbol, while `create`/`createResolved` kept working because the inlined
class happened to declare them. Fix: feed the fixture's own source back verbatim
(`readFileSync(fixturePath, 'utf8')` as that case's `code`) instead of inlining a redeclaration, and
put the call the exemption exists for INTO the committed fixture file.

Two companion constraints for typed suites. Each case's `filename` must exist on disk and be included
by the fixture tsconfig — a virtual filename fails to parse, and if the rule bails when
`parserServices` are absent the case silently passes as valid, so always assert that at least one
invalid case actually reports. And a backslash-separated filename cannot be a RuleTester case at all
on Linux: test separator-agnostic exemption matching by calling `rule.create({ filename,
sourceCode: {} })` directly and asserting the returned visitor is `{}` for an exempt path and
`['CallExpression']` otherwise — which requires the rule to do its exemption check BEFORE its
parserServices check.

Reference: `eslint-rules/no-direct-duplicate-check.*` and `eslint-rules/fixtures/no-direct-duplicate-check/`.

## eslint-linttext-project-service-cost

**source:** #2253
**added:** 2026-08-11
**files:** eslint-rules/config-import-bans.test.js
**tags:** eslint, typescript-eslint, vitest

---

`ESLint#lintText` runs the full parser pipeline, so a repo-wide `parserOptions.projectService: true`
makes the FIRST lint of any path inside the TS project build the whole program — 5,939ms measured
here, against 15ms for a repeat lint of the same path. The cost is parser-level, not rule-level:
`ruleFilter` alone still cost 6,510ms. A syntactic rule such as `no-restricted-imports` needs none of
it. This is what made a 15s default timeout fail on a Windows dev machine while passing on CI.

For a test that lints synthetic source against the real config, use a dedicated instance and change
nothing in `eslint.config.js`:

```js
new ESLint({
  cwd: REPO_ROOT,
  ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
  overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: false } } },
})
```

The two options are co-required in that direction: `projectService: false` WITHOUT the rule filter
throws `Error while loading rule '@typescript-eslint/return-await': You have used a rule which
requires type information`, because that rule is type-aware and configured for `src/server/**`. Keep
`calculateConfigForFile` on a second, override-free instance so resolved-options assertions still
read exactly what `pnpm lint` reads.

Narrowing a lint this way is also how a fixture goes vacuous, so the message helper must fail loudly
rather than return `[]`. Filtering by `ruleId` drops fatal parse errors (`ruleId: null, fatal: true`)
on the floor, and an ignored path yields either a null-ruleId warning (default `warnIgnored`) or zero
results (`warnIgnored: false`). Guard on `results.length !== 1` AND on any `ruleId === null` message
before filtering; every negative case asserting `toHaveLength(0)` depends on it. Keep the `ruleId`
filter even under `ruleFilter` — redundant there, load-bearing without it, since `no-unused-vars` is
globally enabled.

The repo's only consumer of the `ESLint` Node API; the other suites use `RuleTester`, see
[[eslint-rule-test-harness]] and [[typed-ruletester-program-hazards]]. Distinct from
[[vacuous-assertion-observation-points]]: there the observable was too weak, here the lint never ran.

## key-absence-needs-tohaveproperty

**source:** #2243
**added:** 2026-08-11
**files:** src/server/routes/books.test.ts, src/server/services/book-intake/add-book.test.ts
**tags:** vitest, test-observability, test-doubles

---

**`expect.not.objectContaining({ k: expect.anything() })` does not prove key absence.**
`expect.anything()` refuses null/undefined, so for an actual value of `{ k: undefined }` the inner
`objectContaining` fails and `.not` inverts it to a PASS — indistinguishable from the omitted-key
case. `toHaveBeenCalledWith(exactObject)` is no better: it uses the `toEqual`-family recursive
equality, which treats `{a:1}` and `{a:1,b:undefined}` as equal (only `toStrictEqual` separates them).

When the contract is "this key must not be on the payload", capture the argument and assert on the
property directly:

```ts
const createInput = () => (services.book.create as Mock).mock.calls[0]![0] as Record<string, unknown>;
expect(createInput()).not.toHaveProperty('productionType');   // sees present-but-undefined
```

Verified under Vitest 4.1.10: given `fn({ a: 1, productionType: undefined })`,
`not.objectContaining({ productionType: anything() })` passes, `toHaveBeenCalledWith({ a: 1 })`
passes, and only `toHaveProperty('productionType')` sees the key. Mechanism:
`ObjectContaining.asymmetricMatch` is `hasProperty(other, k) && equals(other[k], sample[k])`, and
`hasProperty` is true for a present-undefined key.

This matters wherever omission and an explicit value mean different things —
`buildDuplicateCandidate` (`src/server/services/book-intake/candidate.ts`) keeps omission
distinguishable from null because `DuplicateCandidate` types the three states apart
(`src/server/services/book-dedup.ts`). The containment matcher is still fine when the contract is
about the VALUE ("never a real productionType here") rather than the key. An instance of
[[vacuous-assertion-observation-points]].

## e2e-fetch-stub-serves-new-provider

**source:** #2231
**added:** 2026-08-11
**files:** src/server/__tests__/e2e-helpers.ts
**tags:** e2e, vitest, test-observability, metadata-providers

---

`createE2EApp` builds a real `MetadataService` with every provider in
`METADATA_SEARCH_PROVIDER_FACTORIES`, whether or not the suite wanted one. So a suite whose only
network stub is a URL-agnostic `globalThis.fetch` handler is one code change away from serving a
provider it was never written for. The moment the route under test starts calling `resolveBook`,
`AudibleProvider.searchBooks` gets the Hardcover GraphQL body, `BookMetadataSchema` drops every entry
via `logParseDrop`, and `resolveBook` returns null. Null means genuine miss, not provider failure, so
the row is created with `enrichmentStatus: 'failed'` rather than `'pending'`
(`src/server/services/book-add-resolved.ts`). There is no throw and no warn naming the cause — the
symptom is a durable-field assertion in a distant test, which reads as a bug in the new feature.

When a change gives a service a new outbound provider call, stub that provider in the same commit as
the app-level suites: `vi.mock('@core/index.js', ...)` replacing `METADATA_SEARCH_PROVIDER_FACTORIES`
and `AudnexusProvider` (the shape `series-add-all-enrichment.integration.test.ts` uses), or branch the
fetch stub on the host (`url.includes('api.audible')`) where the point of the suite is that nothing
else is mocked. Prefer a stub that returns a real match over one returning `{ books: [] }`: an empty
window and a wrong-payload window are the same observable, so an empty default cannot tell you the
stub is wired at all.

Same trigger, second mechanism: `RequestThrottle`'s `DEFAULT_THROTTLE_MS` is 200ms
(`metadata.service.ts`), so an inline per-item resolve adds 200ms per item to a request that used to
be instant. A `waitFor` polling for only the first created row then reads the database mid-batch —
poll for the complete expected row set. Related: [[vimock-barrel-replace-drops-named-exports]],
[[connected-client-server-vitest-harness]].

## ruletester-single-fix-pass

**source:** #2191
**added:** 2026-08-12
**files:** eslint-rules/no-raw-error-logging.test.js
**tags:** eslint, ruletester, autofix, vitest

---

`RuleTester` applies exactly ONE fix pass: `Linter.verify` once, then `SourceCodeFixer.applyFixes`
once, with overlapping fix ranges from later reports discarded and never retried. `eslint --fix` and
editors use `Linter.verifyAndFix`, which loops up to 10 passes until output stabilizes. A green
`output` assertion therefore pins single-pass semantics, NOT that the rule's autofix is safe.

This bites any rule where several reports on one file emit fixes that overlap — the norm when each fix
also inserts a shared import. `eslint-rules/no-raw-error-logging.cjs`'s `checkObjectArg` reports per
matching property, and each fix rewrites the property plus calls `buildImportFixes`. For
`log.error({error: e, err: e},'x')` RuleTester yields `{error: serializeError(e), err: e}` (second fix
dropped), while `verifyAndFix` converges to `{error: serializeError(e), error: serializeError(e)}` — a
duplicate key, a TS compile error. Pinned as case `C19`; case `C18` pins the same mechanic across two
separate log calls.

When authoring cases: capture `output` from a real run rather than hand-writing it (a wrong `output`
surfaces as an assertion diff carrying the actual string, the cheapest way to read the true value), and
when a rule's fixes can overlap, check the converged result with `new Linter().verifyAndFix(...)` before
treating the autofix as safe. Extends [[eslint-rule-test-harness]] and
[[typed-ruletester-program-hazards]].

That convergence check has its own false-green — a flat config with no matching `files` glob lints
nothing and returns the input verbatim. Read [[flat-config-files-gate-verifyandfix]] before writing one.
And if the fix must coordinate edits across several reports, [[eslint-coordinated-fix-single-report]]
covers why declining the later reports does not converge either.

## onmutate-reads-generation-after-pending-commit

**source:** #2227
**added:** 2026-08-12
**files:** src/client/components/import-report/ImportAttentionBanner.tsx, src/client/components/SeriesCard.tsx, src/client/hooks/useReplaceGrab.ts, src/client/pages/activity/useImportHistoryDeletion.ts, src/client/pages/book/useCompanionEbookSelection.ts
**tags:** react-query, test-observability, useLayoutEffect

---

query-core v5 dispatches `{ type: 'pending' }` BEFORE awaiting `options.onMutate` (`Mutation#execute`
in `build/modern/mutation.js`). A generation ref read inside `onMutate` therefore reflects the state
AFTER the pending re-render has committed.

Consequence for verifying the post-unmount guard from
[[react-query-mutation-callbacks-post-unmount]]: the natural counterfactual — move the advance from the
`useLayoutEffect` CLEANUP into its SETUP with no dep array — does NOT red a suite. The per-commit
counter has already ticked by the time `onMutate` reads it, so both forms agree at settlement. Verified
on #2227: that mutation left all 22 cases green. **A verification step that only tries this
counterfactual reports a false all-clear.**

The two forms diverge only when a commit lands between `onMutate` and settlement — a real production
window wherever the component re-renders on a timer (the import attention banner polls every 3s, so a
discard failure would be silently swallowed under the per-commit form). The discriminating probe: hold
the mutation's promise, force a commit with `act(() => { qc.setQueryData(key, ...) })` on a test-owned
QueryClient, then settle and assert the live-lifecycle effect still fires. With that case present the
setup-form counterfactual reds. Example: `ImportAttentionBanner.test.tsx` ('a discard failing after a
poll re-renders the mounted banner still surfaces the error').

Applies to all five genRef sites listed in `files`. A different axis from
[[rtl-layout-vs-passive-seam-testing]], which is layout vs passive cleanup; this is cleanup vs setup,
and is observable where the seam axis is not.

## drizzle-tx-statements-bypass-client-spy

**source:** #2194
**added:** 2026-08-12
**files:** src/server/services/series-card.integration.test.ts
**tags:** drizzle, libsql, test-observability, statement-counting

---

Drizzle's libsql session dispatches every prepared query as
`this.tx ? this.tx.execute(stmt) : this.client.execute(stmt)` (drizzle-orm 0.45.2,
`libsql/session.js:123/:134/:162`), and `LibSQLSession.transaction` (`:61`) gets that handle from
`await this.client.transaction()`. A spy on `db.$client.execute` therefore captures statements issued
on a `tx` handle **zero** times.

Consequence: any query-count, argument, or ordering assertion about work inside a transaction is
vacuous against a client-only spy — it reads the same number before and after the change it claims to
pin. Measured on #2194's bind path: with the transaction handle instrumented, pool statements are
`['tx1','tx1','client']` before the fix and `['tx1','client']` after; with only `client.execute`
patched, both report `['client']`.

The working observation point (`spyStatements`, `series-card.integration.test.ts`): patch
`client.execute` AND `client.transaction`, wrapping each returned handle's `execute` by instance
assignment — that shadows `Sqlite3Transaction.prototype.execute` and needs no prototype surgery. Tag
each capture with a scope (`'client'` vs `tx<n>`) and expose the transaction open count. Both extras
earn their place: the scope tag separates an in-transaction read from a post-commit render read that
would otherwise inflate the total, and the transaction count catches work that migrates OUT of the
transaction into a post-commit reconcile, which no per-statement count would notice.

Do not open a nested `db.transaction` to observe the outer one — `runSerializedTransaction` rejects
re-entry with `NestedTransactionError`.

Close the loop the way [[vacuous-assertion-observation-points]] demands: switch the new instrumentation
OFF and confirm the assertion then cannot distinguish fixed from unfixed code. On #2194 that check is
what established the pre-existing helper had been blind all along — so treat any older statement-count
assertion over a transactional path as unproven until re-checked.

## setquerydata-notify-is-a-macrotask

**source:** #2275
**added:** 2026-08-12
**files:** src/client/components/import-report/ImportAttentionBanner.test.tsx
**tags:** react-query, test-observability, vitest

---

Driving a poll in a test by writing to the query cache does not re-render on the same turn. TanStack
Query v5's `notifyManager` schedules observer notifications with `setTimeout(cb, 0)`, so immediately
after `act(() => qc.setQueryData(key, next))` the query state and `observer.getCurrentResult()` already
hold the new value while the DOM still shows the previous one. An extra microtask
(`await act(async () => {})`) does not close the gap; `await act(async () => { await new Promise((r) =>
setTimeout(r, 0)); })` does.

Why it bites: `waitFor`/`findBy*` on a positive observable poll across timer turns and therefore mask
the delay, but a bare negative assertion (`expect(screen.queryByTestId(x)).not.toBeInTheDocument()`)
does not retry — it reads the pre-commit render and passes vacuously, **including against the broken
production code it was written to catch.** This is the react-query-cache instance of
[[vacuous-assertion-observation-points]]: the observation point is a render that has not happened yet.

Pattern: wrap the commit in a helper that settles it, and still pin a positive observable of the NEW
state before asserting any absence.

```ts
async function pollAttention(qc: QueryClient, next: AttentionResponse) {
  act(() => { qc.setQueryData(attentionKey, next); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
```

Known exception that hides the trap: a commit of the SAME data identity followed by an awaited
`findBy*` never observes the gap. Related: [[removequeries-mounted-observer-refetch]],
[[vitest-faketimers-react-query]] (if you fake timers instead, fake only `setInterval`/`clearInterval`
— faking `setTimeout` deadlocks this same notify path).

## flat-config-files-gate-verifyandfix

**source:** #2261
**added:** 2026-08-12
**files:** eslint-rules/no-raw-error-logging.test.js
**tags:** eslint, autofix, ruletester, vitest

---

`Linter.verifyAndFix` is the right way to check a widened ESLint fixer's real convergence (see
[[ruletester-single-fix-pass]]), but under ESLint 10's flat config it silently lints NOTHING unless the
config's `files` globs match the filename you pass. **The check that exists to catch a false-green is
itself capable of false-greening.**

A config object with no `files` key defaults to JS extensions only (`**/*.js`/`**/*.mjs`/`**/*.cjs`).
Pass `'file.ts'` and `verify()` returns one severity-1
`{ ruleId: null, message: 'No matching configuration found for file.ts.' }` while
`verifyAndFix().output` returns the input verbatim — no throw, no error-severity message. A convergence
assertion comparing two such outputs passes against a rule that never executed.

Two distinct instances, both hit in #2261:

1. Add an explicit `files: ['**/*.ts']` to the inline config.
2. Even then, an ABSOLUTE filename outside the base path matches no glob. The RuleTester cases in these
   suites use `/project/src/server/services/a.ts`; copying that filename into a `verifyAndFix` check
   makes it inert. Use a cwd-relative path (`src/server/services/a.ts`). `computeImportPath` resolves
   to the same `'../utils/serialize-error.js'` either way, so the pinned output is unaffected.

RuleTester applies no such filtering, which is why a case is green there and dead here — the two
harnesses are not interchangeable. Always assert the converged text contains the fix's marker (e.g.
`toContain('serializeError(e)')`) BEFORE asserting any equality between converged outputs; that one
line is what separates 'converged correctly' from 'never ran'. Extends [[ruletester-single-fix-pass]]
and [[eslint-rule-test-harness]].

## eslint-fixer-canonical-import-lookup

**source:** #2260
**added:** 2026-08-12
**files:** eslint-rules/no-raw-error-logging.cjs
**tags:** eslint, typescript-eslint, scope-manager, autofix

---

A fixer that inserts an import must answer 'is it already there?' — and both obvious answers are wrong.
A substring scan over `sourceCode.getText()` matches comments and string literals, so the rewrite lands
with no import and the file stops compiling. A name-equality scope lookup is just as leaky: it admits
`const x = 1`, `import type { x }`, `import { type x }`, `import * as x`, `import x from`,
`type x = …`, and a same-name import from a different module.

The rule cannot tell a usable helper from an unusable one without a type checker. It does not need to:
the only binding it ever has a reason to reuse is the exact import it would otherwise write. Recognise
that one shape; treat everything else as unfixable and report without a fix (an `'error'`-level report
still exits `eslint --fix` non-zero and names the line).

Resolve from `context.sourceCode.getScope(reportNode)` walking `.upper`, first scope declaring the name
wins. Canonical requires `variable.defs.length === 1` plus all six of:

```js
def.type === 'ImportBinding' &&
def.node.type === 'ImportSpecifier' &&
def.node.imported.type === 'Identifier' &&
def.node.imported.name === HELPER &&
def.node.importKind === 'value' &&      // `import { type x }` marks the SPECIFIER
def.parent.importKind === 'value' &&    // `import type { x }` marks the DECLARATION
def.parent.source.value === computeImportPath(context.filename)  // the exact string we'd insert
```

The two `importKind` flags are load-bearing in OPPOSITE directions — checking one side lets the other
through — and were verified against typescript-eslint 8.65's scope manager. Comparing `source.value` to
the computed path means an equivalent-but-differently-spelled path (extension omitted, path alias)
lands on the safe side. `import { x as alias }` binds `alias`, so no variable named `x` is in scope at
all: that is the insert case, and the resulting two specifiers for one symbol under different local
names are legal. Non-import defs carry `def.parent === null`, so check `def.type` before dereferencing
it.

Reference: `classifySerializer` in `eslint-rules/no-raw-error-logging.cjs`; the fifteen-shape table and
its drop-one-discriminator counterfactuals in the suite. Extends [[eslint-rule-test-harness]].

## eslint-coordinated-fix-single-report

**source:** #2260
**added:** 2026-08-12
**files:** eslint-rules/no-raw-error-logging.cjs
**tags:** eslint, autofix, ruletester

---

When one rule reports several times over the same node set and the edits must be coordinated (fold two
properties into one, rewrite A and delete B), the coordinated edit must be emitted as ONE report's fix
array. Two tempting shapes both fail:

1. **Each report fixes itself.** `RuleTester` hides it — one `verify` + one `applyFixes`, overlapping
   fixes from later reports silently discarded — while `verifyAndFix` loops up to 10 passes and lands
   them all. This is how `log.error({error: e, err: e},'x')` converged to a duplicate `error` key (see
   [[ruletester-single-fix-pass]]).
2. **First report fixes, later reports report with `fix: null`.** This does NOT converge, verified by
   mutation in #2260: on pass 2 the already-rewritten property no longer matches (its value is now a
   `CallExpression`), the previously-skipped property becomes the *first* match, it gets the fix, and
   the duplicate returns. Both source orders and the non-adjacent case reproduce it.

The shape that works: keep one report per offending node (the developer still sees every one), and
attach to the FIRST report a fix array performing the whole coordinated edit — rewrite the survivor,
`removeRange` the extras, plus any shared insertion. `mergeFixes` sorts a report's fixes by range and
asserts non-overlap, so order is free but overlap throws.

Removing a property must take exactly one separator with it. Prefer the PRECEDING comma
(`sourceCode.getTokenBefore(prop)`): a bare `fixer.remove(prop)` on a middle property leaves
`{a, , b}`, which does not parse, and the trailing comma leaves the removed property's leading
whitespace behind as a double space. When the removed node is always a later match, an entry always
precedes it, so the preceding comma is always available.

And cap the coordination: if the rule can prove at most two nodes are ever fixable together, destructure
`const [first, extra] = matches` rather than looping — three independent removal ranges can select the
same separator twice. Reference: `checkObjectArg`/`removeProperty`. Extends
[[ruletester-single-fix-pass]].

## sibling-hook-cleanup-seam-probe

**source:** #2267
**added:** 2026-08-12
**files:** src/client/hooks/useGenerationGuard.test.tsx, src/client/hooks/useGenerationGuard.ts
**tags:** useLayoutEffect, test-observability, react-query

---

React unmounts layout effects in hook-declaration order (`commitDeletionEffects` walks the effect list
forward), so a custom hook's internal `useLayoutEffect` cleanup runs BEFORE the consuming component's
own. That makes the consumer's layout cleanup a pre-passive observation point for state the hook guards
— a third seam-proving technique alongside the two in [[rtl-layout-vs-passive-seam-testing]], and the
one to reach for when the teardown lives inside the hook rather than in the component.

Shape: render a keyed pair swapping the guard host for a sibling probe. The host calls the hook and,
from its own `useLayoutEffect` cleanup with a constant dep array, pushes a marker derived from the
hook's liveness predicate; the incoming sibling pushes a marker from its `useLayoutEffect` SETUP.
Assert `[teardown, interactive]`. No `vi.mock(m, importOriginal)` wrapper and no memoized-identity dance
are needed, because the probe observes the teardown's effect rather than intercepting the teardown.

Non-negotiable detail: capture the guarded context from OUTSIDE the host, after mount settles (a
module-level box the test writes). A capture taken during render makes the probe blind to the
setup-form defect, since a per-commit advance has already ticked past a render-time capture.

Unlike the two axes described in [[onmutate-reads-generation-after-pending-commit]] and
[[rtl-layout-vs-passive-seam-testing]], this single probe discriminates BOTH. Measured on #2267 against
the full client project (292 files / 6073 tests), `useGenerationGuard.test.tsx` T8 reds under the
passive form (`useEffect(() => retire, [retire])`) AND under the setup form
(`useLayoutEffect(() => { retire(); })`).

**The coverage consequence, also measured: once a teardown mechanism is single-homed in a hook, the
passive-form mutation reds ONLY that hook's seam probe — nothing else in 6073 client tests.** The three
sites relying solely on the hook's internal unmount retire (`SeriesCard`, `ImportAttentionBanner`,
`ImportHistorySection`) all stay green, because RTL's `act` flushes passive effects before the awaited
settlement. `SearchReleasesModal.book-change.test.tsx` F4 and `CompanionEbookSection.test.tsx`'s seam
case stay green too — they probe the CALLER-owned reset, which remains wired into a caller
`useLayoutEffect`. So the hook's own probe is the sole protection for the seam across every consumer:
treat deleting or loosening it as removing the guarantee, not as trimming a redundant test.

## no-restricted-imports-covers-export-from

**source:** #2258
**added:** 2026-08-12
**files:** eslint.config.js
**tags:** eslint, no-restricted-imports

---

`no-restricted-imports` with `importNames` enforces on `export { x } from '...'` re-export specifiers,
not just imports — so a ban that removes a symbol from a barrel also blocks re-adding the barrel line,
with no source-text greppability fallback needed (#2258 pre-authorized one and did not use it).

The matched identifier is the SOURCE-side name. Measured against the real config with ESLint's Node
API, for a ban on `parseAddBookConflict` from `**/add-book-conflict.js`:

| specifier | reports |
|---|---|
| `export { parseAddBookConflict } from` | yes |
| `export { parseAddBookConflict as parseIt } from` | yes |
| `export { somethingElse as parseAddBookConflict } from` | no |
| `export * from` | yes |
| `import { parseAddBookConflict as p } from` | yes |

Renaming on re-export therefore does NOT bypass the ban, and `export *` is caught bluntly (it cannot be
resolved to names, so it is reported whenever importNames are restricted) — relevant if a barrel ever
wants a star re-export of a module carrying a banned symbol. Aliasing an UNRELATED export to the banned
name is not reported, which is correct: nothing banned is being re-exported.

Verify a claim like this with a fixture rather than reasoning about it; see
`eslint-rules/config-import-bans.test.js` for the harness, and
[[eslint-linttext-project-service-cost]] for the ESLint instance that makes such fixtures cheap and
non-vacuous.


## staged-item-mirrors-provider-proposal

**source:** #2296  
**added:** 2026-08-13  
**files:** src/server/services/import-opf-overlay.ts  
**tags:** import-staging, opf-overlay, field-precedence

---

**A staged import item carries a copy of the provider's proposal at the TOP LEVEL, and the top level wins.** For an untouched scan row the client replaces `edited` wholesale from the best match (`mergeMatchIntoRow` → `buildEditedFromBestMatch`, gated on `!row.userEdited && row.edited.metadata === undefined`) and `toConfirmItem` emits the result as top-level `item.seriesName`/`item.seriesPosition`/`item.narrators` ALONGSIDE `item.metadata`. Server-side, `resolveImportSeries` (`src/server/services/resolve-import-series.ts:21-29`) returns on a nonblank `item.seriesName` before it consults `metadata.seriesPrimary`, and the narrator path behaves the same way.

Consequence: **any rule about who wins a staged field has two write sites, not one.** A fix applied only to the metadata overlay is inert for every bulk re-import — the user-visible outcome is unchanged while every metadata-level assertion turns green. This has now bitten twice: #2158 (narrators) and #2296 (series).

The established shape, both in `src/server/services/import-opf-overlay.ts`:
- A named predicate classifies the top-level value as an untouched provider mirror by exact-after-**trim**, case-**sensitive** equality (`sameNarrators`, `mirrorsProviderSeries`). Case-insensitive or normalized comparison is NOT the convention here.
- **Identity is the name alone for series.** `buildEditedFromBestMatch` sets `seriesPosition: primary?.position ?? fallback.seriesPosition`, so a mirrored row can legitimately carry the provider's NAME with the FOLDER's position. Requiring the whole pair to match misreads that hybrid as curation and leaves the bug live for every provider series with no index.
- **Classify BEFORE the metadata overlay runs.** `overlayOntoMatch` reassigns `metadata.seriesPrimary`; comparing against the post-overlay value makes every item look non-mirrored. This is the single most likely way to ship a green-but-inert fix, and it is invisible to metadata-level tests.
- **Delete, don't blank.** `ImportConfirmItem.seriesPosition` is `number | undefined` (`library-scan.service.ts:58-70`); when the replacement has no index, remove the key rather than leaving the old number. Assert with `not.toHaveProperty`, not `toEqual` — see [[key-absence-needs-tohaveproperty]].

**Accepted ambiguity, deliberately:** when a folder or user genuinely asserts the same value the provider returned, it is indistinguishable from the mirror on the wire and the sidecar wins. Resolving it exactly would need a provenance discriminator on `stagedImportItemSchema`, which is `.strict()` and whose payloads are persisted in `import_submission_items.item_payload` — rejected as disproportionate in #2296.

**Fixture rule:** write the regression in the shape the client actually submits (top-level pair present AND equal to the provider's), and corroborate that shape with a client-seam test through the real `mergeMatchIntoRow`/`buildEditedFromBestMatch`/`toConfirmItem` — otherwise the server fixture asserts a payload nobody has proven the client produces. An instance of [[vacuous-assertion-observation-points]]; see also [[staged-metadata-authors-min-one]] for the companion fixture trap on the metadata side.


## utf8-readfile-not-byte-preserving

**source:** #2297  
**added:** 2026-08-13  
**files:** src/server/utils/opf-entry-policy.ts  
**tags:** node-fs, encoding, file-copy

---

`fs.readFile(path, 'utf-8')` is NOT byte-preserving: each maximal invalid UTF-8 subsequence decodes to U+FFFD, which re-encodes to 3 bytes. Measured on Node 24, the 10-byte buffer `41 42 C3 28 A0 A1 43 44 45 46` comes back as 16 bytes after a `Buffer.from(buf.toString('utf-8'), 'utf-8')` round trip. Any backup, copy, or archive path that decodes to a string and writes the string back silently produces a file that never existed — and it does so specifically for truncated/malformed inputs, which are usually the ones worth preserving.

Pattern: read once with **no encoding**, derive the string from the Buffer for whatever inspection the code needs, and write the **Buffer**. This costs no extra syscall. Prior art: `readOpfEntry` in `src/server/utils/opf-entry-policy.ts` returns `{ bytes, text: bytes.toString('utf-8') }`; the text feeds the marker check and both parses, the Buffer feeds `metadata.opf.bak` and nothing else.

The write-side sibling: `copyFile` opens the destination `O_TRUNC` and writes through to the existing inode, so a hard-linked peer of the destination is rewritten. Use a born-hidden sibling temp + `rename` (`replaceFileAtomically`, `src/server/utils/atomic-file-replace.ts`) whenever the destination may already exist — rename swaps the directory entry, so other names for the old inode keep their bytes.

Both properties need byte-level counterfactuals; a string comparison or a call-count assertion passes against the broken implementation. See `src/server/utils/opf-writer.fs.test.ts` ('backs up BYTES, not a decoded string' and 'replaces a hard-linked metadata.opf.bak rather than writing through it', the latter gated on a `link()` capability probe per `windows-hostile-test-primitives`).


## import-list-sync-swallows-setup-errors

**source:** #2304  
**added:** 2026-08-13  
**files:** src/server/services/import-list.service.ts  
**tags:** import-list, secret-codec, test-observability

---

`ImportListService.syncDueLists` catches per list and only logs (src/server/services/import-list.service.ts:156-175), so a test-harness setup error is indistinguishable from an empty sync: no provider fetch, no rows, no throw.

The specific trap: `syncList` starts with `decryptRow`, which calls `getKey()` (src/server/utils/secret-codec.ts). `getKey()` throws unless `initializeKey` has run, so any suite constructing a real `ImportListService` needs `_resetKey(); initializeKey(randomBytes(32));` in `beforeEach`. `import-list.service.test.ts:90-96` does this; `routes/health.test.ts` added it for the #2304 manual-run tests.

General rule for any service with a per-item containment catch: when a run produces nothing, assert on the mocked logger's `error`/`warn` calls before re-reading production code — the contained message names the cause that the return value cannot.


## map-network-error-drops-transport-code

**source:** #2312  
**added:** 2026-08-13  
**files:** src/core/utils/map-network-error.ts  
**tags:** undici, network-service, error-classification

---

**Current state (since #2312): the error `mapNetworkError` returns carries `code`** — via a `withCode()` `Object.assign` — and its timeout/abort arm is tagged `ETIMEDOUT`. Do not re-derive this as a bug; it is fixed.

The history is the reason the rules below exist. `mapNetworkError` (`src/core/utils/map-network-error.ts`) sits on the throw path of every `fetchWithTimeout` caller, and it previously returned a code-less `new Error(friendlyMessage)`: it read `cause.code` only to pick the message from `CODE_MAP`, then discarded it, and its DOMException arm returned a bare `Error('Request timed out')`. No consumer downstream could then classify a network failure by structure — the only identity left was the message text, which is exactly what a structural classifier must not key on (see `abort-verdict-not-error-shape`).

Two rules follow:

- **Read the code, not the message,** when deciding anything about a network failure. `describeTransportError` in `src/core/utils/failure-classification.ts` is the canonical extractor: own `.code` first, then `.cause.code` (undici wraps real failures in `TypeError: fetch failed`), then the DOMException name.
- **Any future rewrite of an error inside a shared helper must preserve `code`.** The loss is silent — the resulting error reads perfectly well in a log line, so a classifier degrading to its default is indistinguishable from a failure that genuinely had no identity. Pinned by the `structural code preservation` block in `map-network-error.test.ts`; mutation-check it by deleting the `withCode` call and confirming `failure-descriptor.test.ts`'s transport-code case reds.


## derived-empty-key-must-be-null

**source:** #2305  
**added:** 2026-08-13  
**files:** src/shared/dedup.ts  
**tags:** dedup, slugify, drizzle, sqlite, identity

---

**When a derivation's output is BOTH persisted to a nullable column and used to build the query that reads it back, its 'no value' result must be `null`, not `''`.** In-memory predicate code almost always tests the key with truthiness, so `''` and `null` are indistinguishable there and the logic reads correct. A database does distinguish them: a row stored with `''` is invisible to `WHERE col IS NULL`, so the write path and the read path silently disagree and the record is written once and never found again.

Concrete instance (#2305): `resolveAuthorSlug` (`src/shared/dedup.ts`) returned `slugify(authorName)` for any non-empty name, and `slugify` (`src/shared/utils.ts`) reduces whitespace-only or punctuation-only names to `''`. `ImportListExclusionService.recordExclusion` stored that `''` in `import_list_exclusions.author_slug`; `candidateFilter` in the same service saw the same falsy value and narrowed on `author_slug IS NULL AND title = ?`. `matchesLibraryIdentity` would have matched the pair, but the row was never fetched, so a deleted import-list book with such an author came back on every subsequent sync. Fixed with `slugify(name) || null`.

Two checks worth running whenever a shared derivation gains a persisting caller:
1. Does the function have more than one 'absent' representation? Grep its branches — here the explicit-`authorSlug` branch already normalized `'' → null` and only the derived branch did not, which is the asymmetry that hid the bug.
2. Is there a `WHERE <col> IS NULL` (Drizzle `isNull(...)`) anywhere keyed on the same derivation? If so, the write must produce `NULL` for exactly the inputs the read treats as null.

A mocked-DB test cannot catch this — the predicate alone always answers correctly. It needs a real migrated database that round-trips the value. Related: [[sqlite-libsql-engine-facts]] (a different NULL mechanism — uniqueness), [[migrated-db-assertions-through-drizzle]] (why the real-DB round trip is the only observation point that works).


## parsefloat-grouped-number-truncation

**source:** #2316  
**added:** 2026-08-14  
**files:** src/core/indexers/mam-helpers.ts  
**tags:** indexers, number-parsing, mam

---

`parseFloat` parses the longest valid numeric prefix and stops silently at the first invalid character: `parseFloat('1,008.8') === 1`. Any provider value rendered for humans may carry thousands separators, so parsing it with bare `parseFloat` yields a number ~1000x too small with no error — and a downstream threshold then discards it while behaving perfectly correctly on the wrong input. #2316: every MAM size in the 1,000.0–1,023.9 MiB band parsed to ~1/1000th and was dropped by the `below-min-size` gate (src/server/services/search-pipeline.ts:127-133) under the default 50 MB minimum, surfacing to the operator as an ordinary 'No releases found'.

The fix has three parts, and the middle one is the non-obvious one:

1. **Validate the grouping before stripping it.** Unconditional `.replace(/,/g, '')` turns a decimal comma `'1,5 GiB'` into 15 GiB — tenfold wrong, in the opposite direction. Require a well-formed English grouping: `/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/`.

2. **Gate that validation on the separator's presence, not on every token.**

   ```ts
   if (!token.includes(',')) return token;   // byte-identical to the pre-fix path
   return ENGLISH_GROUPED.test(token) ? token.replace(/,/g, '') : undefined;
   ```

   Testing the regex against every token also rejects inputs the old parser accepted loosely — `'-5 MiB'` (`-5`) and `'1.5abc MiB'` (`1.5`) — which are unrelated to the bug and fail open at the size gates either way. Tightening them is a separate change with its own blast radius. The `includes` guard makes 'no comma-free input changes behaviour' a structural property of the code rather than something only the test suite asserts; `mam-helpers.test.ts` pins both loose values specifically so a future unconditional-validation rewrite reds.

3. **Return `undefined`, never `0`, for anything unparseable.** Both size gates short-circuit on `!r.size || r.size <= 0` and keep the result, so an absent size fails open. A wrong positive number does not.

Keep this provider-scoped — MAM renders English-locale numbers (`,` groups, `.` is the decimal point). Do not generalize it into a locale-aware parser.

Audited at the time: `parseSize` (src/core/indexers/abb.ts:355) is the only other human-readable size parser, and its upstream regex `([\d.]+)` at abb.ts:326 cannot match a comma, so ABB already yields no size and fails open. Newznab/Torznab transport bytes numerically. Related: when a parse can silently mangle a value, carry the provider's raw string into the diagnostic log next to the parsed number (`SearchResult.rawSize`, added in the same issue) — without it, diagnosing this required a screenshot of the provider's web UI to establish what the API had returned.


## mock-db-tx-handle-is-the-db

**source:** #2329  
**added:** 2026-08-14  
**files:** src/server/__tests__/helpers.ts  
**tags:** drizzle, test-doubles, test-observability, transactions

---

`createMockDb()` (`src/server/__tests__/helpers.ts`) implements `transaction` as `async (cb) => cb(db)`, so the `tx` a collaborator receives IS the db object. Any assertion of the form `expect(dep.method).toHaveBeenCalledWith(id, db)` therefore cannot distinguish "ran inside the caller's transaction" from "ran directly on this.db", and stays green after the transaction is deleted.

Measured on #2329: removing `this.db.transaction(...)` from `BookDeletionService.commitDeletion` reds four tests — two `expect(db.transaction).toHaveBeenCalledTimes(N)` assertions, a post-commit ordering test, and a sequencing test — while the executor-identity assertions on the very same lines stay green.

What to use instead, in increasing strength:
1. **Transaction call counts.** N items must open N transactions, and a loop that wraps them opens N+1 — this is also how AC13-style "the loop opens no transaction of its own" claims are pinned (a nested one would throw `NestedTransactionError` against a real connection, but not against the mock).
2. **Resolution-ordering.** `db.transaction.mockImplementation(async (cb) => { const r = await cb(db); order.push('tx-committed'); return r })`, then assert `['tx-committed', 'effect']` — the shape [[caller-owned-tx-drops-post-commit-effects]] prescribes for deferred effects.
3. **A DB-backed suite for rollback.** No mock can observe a rollback; it records that a statement was issued, not whether it survived. `src/server/services/book-deletion.service.integration.test.ts` is the reference — real migrated libSQL, assertions on committed rows.

Keep the identity assertion if you like — it documents intent — but never let it be the only thing standing between the suite and a deleted transaction. Related: [[drizzle-tx-statements-bypass-client-spy]] (same blind spot, real connection), [[observation-points-server-writes-and-routes]] (issuance ≠ persistence), [[shared-test-double-defaults]].


## posix-resolve-ignores-backslash

**source:** #2301  
**added:** 2026-08-14  
**files:** src/server/utils/path-identity.ts, src/server/utils/path-write-lock.ts, src/server/utils/claim-lock.ts  
**tags:** node-path, path-normalization, windows, cross-platform, locking

---

`path.resolve` treats `\` as an ordinary character on POSIX, so it cannot collapse `..` segments spelled with backslashes: on Linux `resolve('/library\A\..\Y')` returns the input unchanged, while `resolve('/library/A/../Y')` returns `/library/Y`.

**Rule: fold separators BEFORE resolving.** The canonical transform for path identity in this repo is

```ts
normalize(resolve(p.split('\\').join('/'))).split('\\').join('/')
```

fold → resolve → fold. The trailing fold only makes the output platform-stable for messages and logs (`resolve` emits backslashes on Windows); equality holds either way once both sides go through the same function. `computeFolderTarget` (`src/server/utils/rename-target.ts:30`) already used this order; `canonicalPath` (`src/server/utils/path-identity.ts`) is the shared implementation and `claimLockKey` (`src/server/utils/claim-lock.ts`) is exactly it — ownership identity and lock identity must be the same function, or two operations the ownership check says contend can enter separate critical sections.

**`withPathWriteLock` canonicalizes its own key**, so that property now holds by construction rather than by every caller remembering. It did not originally: it keyed on the exact string handed to it while three spellings of one file reached it (`claimLockKey`, `sidecarLockKey`'s bare `resolve(join())`, and tagging's raw `books.path`), which gave one file two chains and silently disabled mutual exclusion — visible only on Windows, where the spellings stop coinciding. `withPathWriteLocks` canonicalizes *before* its dedup and sort, or two callers spelling one pair differently sort into opposite acquisition orders and deadlock. Do not add a fourth key transform; call the primitive with whatever you have.

**Testing it is not obvious.** A `/library/A/../Y` fixture is vacuous for this property: plain `resolve` already collapses it on POSIX. Only the backslash-plus-parent form (`/library\A\..\Y`) reds against fold-after-resolve — pinned in `src/server/utils/path-identity.test.ts` and the legacy-spelling table in `rename.service.test.ts`. And a backslash is a legal POSIX filename character but one of the nine illegal Windows ones, so a fixture that needs a real on-disk directory carrying one must gate on a capability probe rather than a platform check (see `claim-lock-protocol.integration.test.ts`); cf. [[windows-hostile-test-primitives]].

Stated limit: the transform is lexical plus `resolve` and does NOT fold case, so on a case-insensitive filesystem `/library/Y` and `/library/y` still read as two claims.


## loading-assertion-vacuous-at-mount

**source:** #2320  
**added:** 2026-08-14  
**files:** src/client/pages/settings/SecuritySettings.test.tsx  
**tags:** react-query, test-observability, loading-state

---

The pending-side companion to [[observation-points-react-query-error-state]]; read [[vacuous-assertion-observation-points]] first for the general rule.

**A loading-state assertion is satisfied at t=0 by every implementation.** `await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument())` resolves on the first tick, before any query has settled, so it passes against the broken code as readily as the fixed code. Unlike the error side, nothing is being withheld — the observable is simply already true, which is why this reads like the obvious positive assertion and slips through review.

**When the gate under test composes N queries, the observation point is the OTHER query's terminal state.** Settle it, then assert synchronously:

```ts
await waitFor(() => expect(client.getQueryState(queryKeys.auth.config())?.status).toBe('success'));
expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
expect(screen.queryByLabelText('Forms (Login Page)')).not.toBeInTheDocument(); // no posture claim
```

Always pair the positive with the negative: assert the misleading state is ABSENT, not just that the spinner is present. Drive the pending side with a held promise — `mock.mockReturnValue(new Promise(() => {}))` to never settle, or capture `resolve` when the test settles it later. Never `vi.useFakeTimers()`; see [[vitest-faketimers-react-query]].

Why it matters: `SecuritySettings.tsx` gated on `isLoading || !authConfig` from one of two independent auth reads and folded the other into `authStatus?.hasUser ?? false`. For the whole ordinary success/pending window — and permanently on failure — it told the operator no credentials existed and disabled the forms/basic radios: the exact page state of an unprotected install. #2320 replaced it with an error-first policy over the full 3x3 status product; the nine-row table at `src/client/pages/settings/SecuritySettings.test.tsx:961` and its `awaitSettled` helper are the reference shape.

Counterfactual that proves the observation point, not just the branch: restore the single-query gate with the error branch left intact. Exactly the pending rows must red while every error row stays green — a gate reading one query satisfies all five failure combinations and still renders the false posture.


## race-timeout-reject-before-abort

**source:** #2310  
**added:** 2026-08-14  
**files:** src/server/services/search-deadline.ts  
**tags:** abortcontroller, promise-race, timeout

---

`AbortSignal` fires its `abort` listeners SYNCHRONOUSLY during `controller.abort()`. So in a `Promise.race([work, timeout])` deadline, the timer callback must **reject the timeout branch BEFORE calling `controller.abort()`**. With the opposite order — `controller.abort()` then `reject(...)`, which is what `ConnectorRefreshQueue.withTimeout` does at `src/server/services/connector-refresh-queue.ts:312-313` — a leaf that rejects from its own abort listener queues its rejection reaction on the race before the timeout promise settles, wins the race, and delivers a LEAF error where the caller must see the canonical timeout error. Every downstream branch that discriminates an expiry from an ordinary failure (log message, HTTP status, counter arm) then takes the wrong path.

`src/server/services/search-deadline.ts` is the correct shape:

```ts
timer = setTimeout(() => {
  expired = true;
  reject(new SearchDeadlineError(budgetMs, bookId));  // settle the race FIRST
  controller.abort();                                  // then stop the work
}, budgetMs);
timer.unref();
```

Once the timeout promise is settled the race's outcome is fixed and any later leaf settlement is ignored.

**This is live, not theoretical, wherever leaves follow [[abort-verdict-not-error-shape]]** — that pattern's whole point is `if (signal?.aborted) throw error`, i.e. rejecting in response to the abort. The connector queue is currently only latent because its leaves are undici fetches that reject asynchronously from the fetch promise rather than from a synchronous listener.

**Testing it:** the counterfactual is the whole justification for the ordering, so write it — a leaf that registers `signal.addEventListener('abort', () => reject(distinctLeafError))` and never otherwise settles, then assert the caller still receives the canonical error. Swapping the production order back must red exactly that one case. Because this is a hand-rolled `AbortController` + `setTimeout` rather than `AbortSignal.timeout`, `vi.spyOn(globalThis, 'setTimeout')` DOES capture the timer — the stated exception in [[abortsignal-timeout-native-timer-retry-tests]] — so the budget can be asserted exactly and the callback fired on demand with no fake-timer interleaving.


## interval-gate-fifo-chain-not-timestamp-compare

**source:** #2309, #2345  
**added:** 2026-08-14  
**files:** src/core/utils/interval-gate.ts, src/core/indexers/mam-throttle.ts, src/server/services/metadata.service.ts  
**tags:** rate-limiting, concurrency, abortsignal, fake-timers

---

**A read-sleep-restamp throttle does not enforce an interval under concurrency.** The shape `const elapsed = Date.now() - lastRequest; if (elapsed < min) await sleep(min - elapsed); lastRequest = Date.now();` spaces only strictly sequential callers: N simultaneous `acquire()` calls read one stamp, sleep the same amount, and dispatch together — the exact burst the floor exists to prevent. A two-sequential-acquires test passes against it, which is why it stays invisible; the observation point that sees it is three CONCURRENT acquires recorded into a shared resolve-order array (see [[vacuous-assertion-observation-points]]).

**Use `IntervalGate` (`src/core/utils/interval-gate.ts`); do not hand-roll a third one.** It was the MAM adapter's floor in #2309 and absorbed MetadataService's provider floor in #2345, which is the only reason no read-sleep-restamp throttle remains in the tree. `MamRequestThrottle` (`src/core/indexers/mam-throttle.ts`) is the model for a caller: it owns only its destination-key rule and its reset reason, and delegates every scheduling decision. Note the layer boundary — `src/core/**` cannot import `src/server/**`, so a shared gate has to live in core.

The shape, if you ever need to reason about it: per-key `{ waiters, nextAllowedAt, timer }` plus a `pump()` loop that dispatches the head only when the remaining wait is `<= 0`, stamps `nextAllowedAt = Date.now() + intervalMs` on each dispatch, and otherwise arms exactly one `setTimeout` that re-enters `pump`.

**Release on the interval, never on the caller's completion.** A slot freed by the timer means a request that hangs for its full timeout, throws, or is aborted delays nothing but itself — and no `try/finally` release bookkeeping is required. If an implementation grows one, the design has drifted. (`Semaphore` in `src/server/utils/semaphore.ts` is the opposite contract: it bounds concurrency and hands off on explicit release, so it is not a substitute.)

**A wall-clock wait needs an explicit answer for BOTH directions of a clock step, and the backwards one must repair the stamp.** Clamping only the returned wait is insufficient: the stale `nextAllowedAt` survives, the timer fires, the remainder is still huge, and the queue re-arms forever. Rewrite the stamp itself — `if (remaining > intervalMs) { queue.nextAllowedAt = Date.now() + intervalMs; return intervalMs; }` — and return 0 for any non-finite or non-positive remainder (the `Number.isFinite` guard is the same fail-open trap as [[rate-limit-gate-fails-open-on-nan-window]]). A forward step yields a zero wait and lets one early request through; that is a decision — assert the bound, not the absence of the step.

**The fake-timer trap that follows from it:** the armed timer must dispatch directly, not re-read the clock and recompute. Under this repo's `vi.useFakeTimers({ toFake: ['Date','setTimeout','clearTimeout'] })` harness the clock is frozen while timers still run, so a callback that recomputes the remainder finds it unchanged and re-arms forever. See the comment in `IntervalGate.pump`.

**Cancellation:** `acquire` takes an optional `AbortSignal`, rejects with `signal.reason` verbatim (never on an error shape — see [[abort-verdict-not-error-shape]]), removes the waiter from the queue, and leaves `nextAllowedAt` untouched. Immediate queue hand-off is not immediate dispatch: the successor becomes head at once but still owes whatever remains of the floor. Every downstream catch-and-degrade on that path needs `if (signal?.aborted) throw error;` first, or the rejection reads as a legitimate empty answer.

**Module-level state, module-level reset.** Adapter instances are cached and evicted (`indexer.service.ts`), so the floor belongs to the destination, not the object — key it by canonical `host:port` via `normalizedHostPortFromUrl`. `reset` must clear stamps, cancel timers, detach abort listeners AND reject queued waiters; a bare `Map.clear()` leaves timer closures armed and promises permanently pending, which surfaces later as flake (see [[shared-suite-state-inflates-counterfactual]]).

## msw-gated-stream-body-separates-headers-from-parse

**source:** #2373
**added:** 2026-08-16
**files:** src/core/__tests__/solver-bound.ts
**tags:** msw, readablestream, resource-lifetime

---

**To pin that a resource is held until a response body is read and parsed — not merely until `fetch()` resolves — stub a gated streaming body.** With an already-materialized body (`HttpResponse.json(...)`) the two release points are indistinguishable, so a `finally` that wraps only the fetch passes exactly the same tests as one that wraps the parse. This is a whole class of blind spot: any `try { …fetch…; …parse… } finally { release() }` has it.

**The technique is right; the obvious witness is wrong.** Measured on Node 24 / msw 2.15.0, a `new ReadableStream(source, { highWaterMark: 0 })` returned via `new HttpResponse(stream, { headers: { 'Content-Type': 'application/json' } })` produces:

```
handler → pull#1 → fetch() RESOLVES → pull#2 → (gate opened) → parsed
```

`pull#1` fires while the Fetch implementation is still assembling the Response — the caller does not hold it yet. A witness resolved on pull#1 therefore samples *before* a release-after-headers bug has fired, and the test passes under the very mutation it exists to catch.

**`highWaterMark: 0` is load-bearing but insufficient.** Construct as `new ReadableStream(source, { highWaterMark: 0 })` — under the default queuing strategy the stream pre-pulls one chunk at construction, so a `pull`-resolved barrier settles before the response reaches any client at all. But `highWaterMark: 0` only removes that construction-time pre-pull; it does NOT move pull#1 after `fetch()` resolves.

**Remedy: emit the body in two chunks and resolve the witness on the SECOND pull.** Enqueue a head byte on pull#1; on pull#2 announce the witness, `await` the gate, then enqueue the tail and close. pull#2 provably follows `fetch()` resolving, which is exactly the window where release-after-headers has freed the resource and release-after-parse has not.

Exemplar: `gatedSolverBody()` in `src/core/__tests__/solver-bound.ts` (`stream` / `draining` / `complete`), consumed by 'keeps the slot until the body is read and parsed, not merely until headers arrive' in `src/core/indexers/fetch.test.ts` (#2373). Counterfactual: moving `releaseSlot()` out of the `finally` in `fetchViaProxy` to just after the `fetch()` call reds it 5/5 and greens 5/5 unmutated — where the single-pull version passed under that same mutation.

**Process note worth as much as the mechanism.** The single-pull test only ever redded because an unrelated helper in the same test was incidentally adding delay. When that helper was removed as unreliable, the flaw underneath surfaced. A test that stops catching its mutation after you delete an unrelated wait was timing-dependent all along — re-run every counterfactual after removing a synchronization helper, not just the tests the helper was named in. See [[vacuous-assertion-observation-points]].

Distinct from [[msw-url-matching-ipv6-and-path-case]] (handler URL matching) and from the Audnexus body-boundary note on splitting `response.text()` from `JSON.parse` (error classification, not resource lifetime).

## msw-network-error-has-no-transport-code

**source:** #2374  
**added:** 2026-08-16  
**files:** src/core/__tests__/solver-routes.ts  
**tags:** msw, vitest, error-classification, undici

---

msw's `HttpResponse.error()` produces a network error with **no** `code` and no `cause`. It therefore cannot exercise any branch that classifies on the transport code — it only ever hits the unknown/default arm — and it cannot produce the `AbortError` DOMException an expiring `AbortController` raises. A test that uses it to mean "the host refused the connection" is vacuous against a code-reading classifier and stays green when the classifier is wrong.

Real undici failures arrive as `TypeError('fetch failed')` whose `cause` carries `.code`; that is the shape `mapNetworkError` unwraps (`src/core/utils/map-network-error.ts:51-52`), and the shape a test must reproduce. Stub at the fetch boundary, not at an inner export — see [[esm-same-module-vi-mock-bypass]] for why that boundary is the right one anyway.

`src/core/__tests__/solver-routes.ts` is the shared harness: `routeFetch(route)` spies `globalThis.fetch`, routes by URL **and method** (the #2374 solver probe and the solver round-trip share an address — `HEAD /v1` is the probe, `POST /v1` is the round-trip), records every call for "was a probe issued?" assertions, and falls through to the pre-spy fetch so MSW keeps serving everything else. It must be installed after `server.listen()` for that fall-through to reach MSW. Companion builders: `codedRejection(code)`, `uncodedRejection()`, `abortRejection()`, `hangUntilAborted(signal)`, `solverEnvelope(body, status)`.

Related: [[map-network-error-drops-transport-code]] — the production half of the same rule (classify on `code`, never on message text).

## degrading-adapter-invisible-to-mock-suite

**source:** #2375  
**added:** 2026-08-16  
**files:** src/core/indexers/abb.ts  
**tags:** indexer-adapters, error-classification, test-observability

---

**A service-level classifier keyed on a thrown error is only as good as its adapters' willingness to throw, and a mock-adapter suite is structurally blind to that.** Injecting a fake adapter that rejects proves the classifier; it proves nothing about whether the real adapter ever rejects.

#2375 shipped to review with a green suite covering both executors, every outcome kind, a route-level SSE test and five counterfactuals — while `AudioBookBayIndexer.search()`, the adapter the motivating incident was named after, still caught its own direct HTTP/network failures and returned an empty *successful* response. The service read that as `{ kind: 'resolved' }`, `succeeded` incremented, the ladder read a genuine zero and advanced, and the dead indexer was re-asked once per rung — the exact amplification the work removed everywhere else.

Why no extra mock-layer case could have caught it: a fake adapter that rejects can only exercise the branch where the adapter rejects. The defect lives in the branch where it doesn't.

**Rule.** When behavior depends on an adapter raising rather than degrading, drive at least one REAL adapter through the real service seam (MSW for the transport). Pair it with a control that keeps the adapter eligible on a genuine answered zero, or the assertion passes just as well against 'always excluded'. Precedent: the `#2375 AC1/AC9 — the real AudioBookBay adapter` describe in `src/server/services/ladder-exclusion.integration.test.ts`.

**Auditing an adapter for this shape:** look for a `catch` whose non-rethrow arm falls through to the ordinary success return. As of #2375, ABB's *search-page* catch is fixed (first page rethrows; later pages still degrade to the pages already fetched, since the indexer demonstrably answered); its *detail-page* catch still swallows by design and is tracked as #2367. `torznab.ts` and `newznab.ts` have no catch in the search path; `myanonamouse.ts`'s `results: []` returns are genuine answered zeros. Related: [[compat-wrapper-hides-stale-test-doubles]] for the other direction — doubles that drift from a widened real surface.

## ladder-rung-count-needs-colon-segments

**source:** #2375  
**added:** 2026-08-16  
**files:** src/server/services/search-query-ladder.ts  
**tags:** search-ladder, title-variants, test-fixtures

---

`buildQueryLadder` (`src/server/services/search-query-ladder.ts`) builds its relaxation rungs from COLON segments, not from words. `titleVariants` (`src/core/utils/title-variants.ts`) emits two unconditional `full` variants and then derives `prefix(n)` / `suffix(n)` / `first+last` from `colonSegments(base)`; with no colon there is one segment, every cut dedupes against the full form, and the ladder is 2 rungs long however many words the title has.

Measured at `29968a8b`: 'The Way of Kings' → 2; 'The Hitchhikers Guide to the Galaxy' → 2; 'The Name of the Wind Kingkiller Chronicle Day One' → 2; 'Dune Messiah (Dune Chronicles Book Two)' → 4 (the parenthetical adds a second full form); 'Kings: Stormlight Archive: Special Edition' + author 'Sanderson' → exactly 8 = `MAX_SEARCH_RUNGS`. The author is load-bearing too: the ladder iterates `[author, undefined]` author-major, so dropping it roughly doubles the count.

**Why it matters for tests.** Any test that means to exercise multi-rung behaviour — exclusion across rungs, per-rung reporting, cooldown, relaxation disclosure — and picks a natural-looking title runs against 2 rungs and passes whether or not the behaviour works past rung 1. A 'called fewer than 8 times' or even 'called twice' assertion is then vacuous, and nothing in the output reveals it.

**Rule:** use a colon-segmented fixture title when rung count is load-bearing, and pin it with `expect(LADDER).toHaveLength(MAX_SEARCH_RUNGS)` in its own case so a change to the variant generator reds the fixture rather than silently shortening every count that depends on it. `ladder-exclusion.integration.test.ts` and `ladder-outcome-kinds.integration.test.ts` (#2375) do exactly this. Reproduce with `pnpm exec tsx` and a small script file — the inline `-e` form cannot resolve the `@core` alias on Windows. Related: [[variant-tag-not-slice-under-first-wins-dedup]] for why the generator's tags, not its text, are the contract.

## reservation-proof-needs-same-entry-point-race

**source:** #2376  
**added:** 2026-08-16  
**files:** src/server/services/indexer-breaker.integration.test.ts  
**tags:** concurrency, circuit-breaker, mutation-testing

---

**A cross-entry-point race does not prove a synchronous gate's reservation.** When two callers reach a shared gate through unequal amounts of pre-gate `await`, the one that arrives first commits its outcome and closes the gate on the other by the ordinary timestamp comparison — so the test passes identically against code with no reservation at all. Only two concurrent calls through the SAME entry point exercise the atomicity.

The live instance: `pollRss` (`src/server/services/indexer-search.service.ts`) calls `reserveIndexerLeg` as its first statement, while `searchAllWithStatus` / `searchAllStreaming` `await prepareSearch(...)` first. Racing RSS against streaming always lets RSS win, fail, and advance `nextAttemptAt` before streaming's gate check runs.

Mutation-verified: deleting the reservation line in `FailureTracker.reserveAttempt` (`failure-backoff-tracker.ts`) reds only the two-concurrent-`searchAllWithStatus` case; the cross-surface case stays green. Keep both — the cross-surface one still proves every surface consults the gate — but write the same-surface one, and mutation-check it, or the reservation is untested.

Related: [[interval-gate-fifo-chain-not-timestamp-compare]] establishes that a read-then-act gate does not bound concurrent callers and that concurrent acquires into a shared resolve-order array are the observation point; this entry narrows WHICH concurrent acquires can see it. [[vacuous-assertion-observation-points]] is the general rule this is an instance of.

## msw-url-matching-ipv6-and-path-case

**source:** #2373  
**added:** 2026-08-16  
**files:** src/core/indexers/fetch.test.ts  
**tags:** msw, path-to-regexp, url-matching

---

MSW 2.15 routes handler URLs through path-to-regexp 6.3, which constrains handler URLs in two non-obvious ways.

**An IPv6-literal handler URL crashes the handler lookup.** `http.post('http://[::1]:8080/v1', ...)` throws `TypeError: Missing parameter name at 9` in `matchRequestUrl` → `HttpHandler.parse`; MSW logs 'Encountered an unhandled exception during the handler lookup' and answers 500, so the resolver never runs and the stub's counters stay at zero. The symptom is indistinguishable from 'production never issued the request', which is what makes it expensive. There is no bracketed-literal spelling that works — stub at the `vi.spyOn(globalThis, 'fetch')` boundary for that case and read the URL off the spy's argument. Exemplar: the IPv6 isolation case in `src/core/indexers/fetch.test.ts` (#2373).

**Path matching is case-insensitive.** `http.post('http://h/Solver-A/v1')` and `http.post('http://h/solver-a/v1')` both match either request, and since `server.use()` prepends, the last-registered one wins for both. Any test proving that production treats path case as significant therefore cannot use two handlers. Register ONE handler with a wildcard path — `http://h/*` matches and does work — and discriminate inside the resolver on `request.url` or on the request body. Exemplar: 'separates paths differing only in case, while host case still folds' in `src/core/indexers/fetch.test.ts`.

Host case and an explicit default port are NOT affected: `fetch` normalizes those before MSW sees the request, so `http://SOLVER.lan:8191/v1` and `http://solver.lan:80/v1` correctly reach handlers registered as `http://solver.lan:8191/v1` and `http://solver.lan/v1`. Verified on Node 24 / msw 2.15.0 / path-to-regexp 6.3.0.

## cheerio-br-zero-width-text

**source:** #2365  
**added:** 2026-08-15  
**files:** src/core/indexers/abb-fields.ts  
**tags:** cheerio, html-scraping, text-extraction

---

**cheerio's `.text()` treats `<br>` as zero-width — it contributes no character, not even a space.** Measured on cheerio@1.2.0: `cheerio.load('<p>Format: <span>M4B</span><br>Bitrate: <span>128 Kbps</span><br>Unabridged</p>')('body').text()` is `"Format: M4BBitrate: 128 KbpsUnabridged"`. All whitespace in flattened output comes from source text nodes, so a source newline before the `<br>` changes the result to `"Format: M4B\nBitrate: 128 Kbps"`.

Two consequences for any `$(sel).text()` + regex extraction:

1. **A `([^\n]+)`-style capture does not stop at a visual line break.** `/Format:\s*([^\n]+)/i` captures `"M4BBitrate: 128 KbpsUnabridged"` on the first shape and `"M4B"` on the second — the same markup, parsed differently because of how the upstream page was indented. Self-terminating captures (`([\d.]+)`, `(\d+)`) are immune, which is why a broken flattening parser can look fine for numeric fields while every string field is wrong.
2. **Do not repair a text-flattening parser with a narrower pattern.** If the page carries the values in its own elements, read the elements. `src/core/indexers/abb.ts` mined `$('body').text()` for author/narrator and returned the uploader's username; `src/core/indexers/abb-fields.ts` (#2365) replaced it with class-selected reads anchored to the page's schema.org block. The flattening-hostile shape is pinned by the one-source-line block in `src/core/__tests__/fixtures/abb-detail.html`, so a regression back to any text-run regex reds on exact values.

Same family as [[htmlparser2-no-attribute-normalisation]]: measure the parser's actual behaviour before building code or tests on what the markup looks like.

## workflow-dispatch-needs-default-branch

**source:** #2358  
**added:** 2026-08-15  
**files:** .github/workflows/windows-tests.yml  
**tags:** github-actions, workflow-triggers, ci-verification

---

GitHub runs `workflow_dispatch` **only for a workflow file present on the repository's default branch** ([docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)). Declaring the trigger in a NEW workflow on a feature branch does not make it dispatchable — not from the feature branch, not from `develop`, not until it merges to `main`.

**Consequence: `workflow_dispatch` is never a pre-merge verification route for the workflow that introduces it.** A plan that plans to "dispatch it on a scratch branch to prove it catches X" has no route, and the failure mode is silent — nothing fires, which on the PR page is indistinguishable from a clean run.

**Use an event the workflow's own `on:` block covers on a reachable ref.** For `.github/workflows/windows-tests.yml` that is `pull_request: branches: [main, develop]`, i.e. a draft PR into `develop`.

The trap is sharper in this repository because of the surrounding trigger asymmetry: a bare push to a scratch branch fires **nothing** (`ci.yml` is main-only; `docker.yml` is develop-push plus semver tags), so "I pushed and nothing broke" is never evidence here.

Better still, where the property allows it: make the thing you wanted to observe once into a standing test instead. #2358 replaced a planned one-time Windows-red experiment with a filesystem-free, platform-neutral assertion in `src/server/utils/path-write-lock.test.ts` plus a required-file entry in the selection guard — which holds on every run on both platforms instead of once on a branch that gets deleted.

## msw-first-fetch-skews-interval-assertions

**source:** #2358  
**added:** 2026-08-15  
**files:** src/server/services/mam-throttle.integration.test.ts  
**tags:** msw, vitest, timing-assertions

---

A test that stamps `Date.now()` inside two MSW handlers and asserts on their **difference** is measuring the delay under test *plus* the difference of two fetch-to-handler latencies:

```
observed = (resolve2 - resolve1) + (d2 - d1)
```

The run's **first** real fetch pays a one-time interception cost that later ones do not, so `d1 > d2` and the observed gap comes in systematically **short**. Measured in `src/server/services/mam-throttle.integration.test.ts` against `IntervalGate`'s exact 250ms floor: six unloaded runs read 239-245ms, i.e. a ~5-11ms standing bias. The assertion's `- 20` tolerance, written to cover clock granularity, was instead spending most of itself on that bias — so the first run under full-suite parallel load read 225 and went red.

**Rule: warm the fetch path before the measured window.**

```ts
await fetch(`${BASE}/some-stubbed-path`);
dispatched.length = 0;          // drop the warm-up's own stamp
const startedAt = Date.now();
```

Six runs then read 249-250 against a true 250, and the in-test latency probe fell from 11-18ms to 3-5ms — the cost is interception setup, not per-request work. Only after this does a tolerance mean what it says: `Date.now()` granularity, ~15.6ms on Windows and ~1ms on Linux.

**Measure before widening.** The failure looked like generic load flake and the one-line fix was to drop the floor. Instrumenting it showed a fixable bias instead; widening would have deferred the identical failure to the next busy run. Note the gate itself is exact — `IntervalGate.dispatchHead` (`src/core/utils/interval-gate.ts`) stamps `nextAllowedAt = Date.now() + intervalMs` at resolve time — so any shortfall is observation error, never the code under test.

## vitest-passwithnotests-hides-empty-selection

**source:** #2358  
**added:** 2026-08-15  
**files:** vitest.config.ts  
**tags:** vitest, ci, test-selection

---

`vitest.config.ts:19` sets `passWithNoTests: true`, so a run whose include globs match nothing exits **0**. Any gate that reads only the exit code cannot tell "everything passed" from "nothing ran" — and on a platform CI has never covered before, those two look identical.

**Rule: a test gate on a new surface needs a selection assertion, not just an exit code.** Run the JSON reporter alongside the default one and assert on the report:

```
pnpm test --reporter=default --reporter=json --outputFile.json=vitest-windows.json
```

Verified against vitest@4.1.10, the report is `{ numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests, snapshot, startTime, success, testResults: [{ assertionResults, startTime, endTime, status, message, name }] }`. Three conditions catch every realistic collapse given the two-project layout at `vitest.config.ts:25-58`:

- `numTotalTests - numPendingTests - numTodoTests > 0` — something actually executed;
- at least one `testResults[].name` under `src/client/` — the jsdom `client` project selected files;
- at least one `testResults[].name` outside it — the `server` project selected files.

`testResults[].name` is an **absolute** path, so on Windows it arrives backslash-separated: fold with `.split('\\').join('/')` before the prefix test, per [[posix-resolve-ignores-backslash]].

The implementation is `scripts/vitest-selection-guard.ts` (pure, unit-tested at `scripts/vitest-selection-guard.test.ts`) with the CI entry `scripts/check-vitest-selection.ts`; `.github/workflows/windows-tests.yml` runs it as the step after the test step. Since #2445 it is no longer merely informational: it is the job's verdict, adjudicating a non-zero vitest exit against the per-test records (teardown-crash tolerance), so it must never be made skippable on failure.

**Do not add a global numeric floor and do not assert the skip count.** A magic total (`>= 4000`) catches nothing the per-project check misses and reds on legitimate shrinkage. The skip count moves with hosted-runner capabilities — `describe.skipIf(!FFMPEG_PRESENT)`, the `CAN_RUN` mutagen gate, `CAN_SYMLINK` flipping with Developer Mode — not with selection correctness; print it as a diagnostic and let the per-project check be the only thing that can fail. See [[windows-hostile-test-primitives]].

Both `--outputFile=` and `--outputFile.json=` write the report with two reporters configured on vitest@4.1.10; the keyed form is preferred for explicit per-reporter routing, not because the bare form fails.

## interval-gate-frozen-clock-livelock

**source:** #2345  
**added:** 2026-08-14  
**files:** src/core/utils/interval-gate.ts  
**tags:** fake-timers, rate-limiting, concurrency, vitest

---

**A wall-clock FIFO interval gate must dispatch on its armed timer, not re-read the clock when that timer fires.** `pump()` arms one `setTimeout(..., waitFor(queue))`; if the callback re-enters `pump()` and recomputes `remaining = queue.nextAllowedAt - Date.now()`, it livelocks under `vi.useFakeTimers({ toFake: ['Date'] })` — `Date.now()` is pinned while real timers still fire, so the remainder never shrinks and the queue re-arms forever. The worker hangs at the test timeout rather than failing fast. Fix: the callback calls `dispatchHead(queue)` unconditionally, then `pump(queue)`.

This is a **new** failure mode the read-sleep-restamp form did not have (its `setTimeout` sleep is unconditional and real-time), so it appears exactly when a gate built per [[interval-gate-fifo-chain-not-timestamp-compare]] is adopted by a consumer whose suites freeze `Date` only. That harness is not optional — full fake timers stall MSW and the native `AbortSignal.timeout` inside `fetchWithTimeout` (see [[rate-limit-gate-fails-open-on-nan-window]], [[abortsignal-timeout-native-timer-retry-tests]]) — so any shared gate must assume some caller freezes the clock. Pin it with a liveness case on REAL timers and a small interval: `src/core/utils/interval-gate.test.ts`, describe 'IntervalGate under a frozen clock with live timers'. It reds by timeout against the re-consulting form.

**Second-order effect on mutation testing.** Because every dispatch restamps `nextAllowedAt = Date.now() + intervalMs`, a clamp-only variant of `waitFor` (returning `intervalMs` without rewriting the stamp) is repaired at the next dispatch. A third sequential acquire after a backwards clock step therefore CANNOT discriminate a repaired stamp from a merely clamped return — contrary to the obvious test design. The repair is only observable across a wait that ends in no dispatch: queue a waiter after the backwards step, abort it before the timer fires, then acquire again and assert zero wait. See 'repairs the stored deadline, not just the returned wait' in the same suite, and [[vacuous-assertion-observation-points]] for the general rule.

## settimeout-overflow-clamps-to-1ms

**source:** #2344  
**added:** 2026-08-14  
**files:** src/server/jobs/index.ts  
**tags:** node-timers, schedulers, settings-schema

---

Node's `setTimeout` clamps a delay it cannot represent to **1 ms** — in BOTH directions. NaN gives `TimeoutNaNWarning`; anything above `2**31-1` ms (2_147_483_647, ~24.855 days) gives `TimeoutOverflowWarning`. Both turn a bounded schedule into an unbounded one, and neither throws.

So a delay guard must bound the value from both ends, and must be written on the arithmetic **product** rather than the operand (a finite `1e306` overflows to `Infinity` only after `× 60000`; a `null` read multiplies to `0`, not `NaN`, so a `Number.isNaN`-only predicate misses it). The shipped shape is `normalizeIntervalMs` in `src/server/jobs/index.ts`, returning a discriminated `{ kind: 'ok' | 'clamped' | 'invalid' }` — invalid takes a warned retry, clamped fires early at the ceiling (early is the safe direction for a periodic job; late is not).

The non-obvious half: a Zod `.max()` is not a timer bound. `systemSettingsSchema.backupIntervalMinutes` is `.max(43200)` = 30 days = 2,592,000,000 ms, so the schema's own documented maximum — a value the settings form accepts — made the backup job run continuously. Any settings-derived duration that reaches a timer needs the range check at the arming boundary; narrowing the schema instead would silently reset already-stored out-of-range values to defaults through `parseCategory`.

Mirror trap on the display side: `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, so one poisoned `nextRun` 500s the whole `GET /api/system/tasks` response, not just its own field. `TaskRegistry.setNextRun` (`src/server/services/task-registry.ts`) accepts `Date | null` and treats an Invalid Date as a clear for exactly that reason. Companion entry: [[rate-limit-gate-fails-open-on-nan-window]] (finiteness on the product, and pino serialising NaN to null so the warn must carry `String(value)`).

## pr-branch-rebase-duplicates-unpin-merge-base

**source:** #2309, #2348  
**added:** 2026-08-14  
**tags:** git, rebase, pr-scope, merge-base

---

**A branch update can put the BASE's commits on your branch as duplicates, and the PR then shows their content as yours.**

GitHub renders a PR's delta as `git diff <base>...HEAD` — three-dot, relative to the *merge base*, not to the base tip. If the base's commits exist on your branch as rewritten copies (same patch, new SHA), git can no longer see them as shared history: the merge base falls back to the last true common ancestor, and every change the base made since surfaces as part of your PR. This is a realistic outcome whenever a local rebase leaves the branch diverged from its remote and something else reconciles the divergence — the reconciliation can replay the base onto the branch rather than the branch onto the base.

Nothing about this is visible from inside the branch. The working tree is correct, the tests pass, and `git log --oneline` reads as a sensible history. Only the comparison point is wrong.

**Detect** — after ANY history operation on a PR branch:

```sh
git merge-base origin/<base> HEAD   # must equal…
git rev-parse origin/<base>          # …this
git diff origin/<base>...HEAD --name-only   # must list only your files
```

To name the duplicates, compare subjects of `git rev-list <merge-base>..HEAD` against `git log --format=%s <merge-base>..origin/<base>`.

**Fix** — `git merge origin/<base>`. It makes the base tip a genuine ancestor, so the merge base moves to the base tip and the delta becomes correct **without rewriting a single commit**. The push that follows is a strict fast-forward: nothing is rejected, so no reconcile path is ever entered. Verify with `git merge-base --is-ancestor <remote-head> HEAD`.

**Do NOT fix by rebasing — under this harness the rebase is correct locally and then thrown away.** The push gate's rebase-on-reject checks out `origin/<feature-branch>` (workflume `src/gates/push.ts`, `git rebase origin/${branch}` where `branch` is your own branch), NOT `origin/<base>`. Your freshly-rewritten commits are patch-identical to the ones already on the stale remote head, so every one is skipped and the branch lands back on exactly that head. `git ls-remote` shows the remote never moved. This looks like a no-op push, not a failure, and it cost PR #2343 two review rounds across two attempts before the reflog gave it up:

```
19:20:12  rebase (start): checkout origin/develop                 -> ed3800be1   (correct delta)
19:28:51  rebase (start): checkout origin/feature/issue-2309-...  -> e608ccf77   (rewrite discarded)
```

**Reverting the duplicated commits is the trap.** It produces the same correct delta by fast-forward, so it *looks* like the cheap fix — but the safety depends entirely on the merge strategy. Merge-commit and squash-merge are safe. **Rebase-merge is not**: the reverts replay onto the base tip and silently delete the base commits they reverted.

**Verify three ways**, not one: (1) merge base equals base tip; (2) the delta's file list, filtered against the set your issue permits, is empty; (3) `git diff origin/<base> HEAD -- <foreign path>` is empty for each previously-leaking file, which distinguishes "present and unmodified" from "reverted". Then re-run the base's own suites — your commits now sit on code they were never tested against.

## zod-object-superrefine-skipped-on-shape-failure

**source:** #2392
**added:** 2026-08-16
**files:** src/shared/schemas/indexer.ts
**tags:** zod, react-hook-form, form-validation

---

zod (4.4.3) does not run an object's `.superRefine()` at all when the object's own shape parse produced any issue. One bad field therefore suppresses EVERY cross-field message the refine would have added, not just its own. Verified: `createIndexerFormSchema.safeParse({type:'abb', settings:{hostname:'ftp://x', pageLimit: NaN}})` returns exactly one issue, at `['settings','pageLimit']`, and none at `['settings','hostname']`.

The live trap in this repo is numeric inputs registered with `valueAsNumber: true` (e.g. `settings.pageLimit` in `src/client/components/settings/indexer-fields/abb-fields.tsx`): an emptied input yields NaN, `z.number()` rejects it, and the whole `createIndexerFormSchema` superRefine block in `src/shared/schemas/indexer.ts` — the `INDEXER_REGISTRY.requiredFields` loop, the `flareSolverrUrl` 'Must be a valid URL' check, and the #2392 ABB hostname check — goes silent. `INDEXER_REGISTRY.abb.defaultSettings` supplies `pageLimit: 2`, so it only surfaces when the operator clears the field.

Consequences when working here: (1) don't put a validation rule in an object-level `.superRefine()` if it must fire independently of sibling field validity — put it on the field; (2) any `useForm` test fixture driving `zodResolver(createIndexerFormSchema)` must populate every numeric field, or the assertion is vacuous (this cost real debugging time on #2392 — see the `ValidatedAbbForm` wrapper in `src/client/components/settings/IndexerFields.test.tsx`, which sets `pageLimit: 2` for exactly this reason).

This is one step earlier than `zod-type-scoped-settings-transform`, which covers `.transform()` running only when the preceding `.superRefine()` was clean. Related: `zod-resolver-effects-divergence`.

## external-fifo-queue-excludes-primitive-acquire

**source:** #2379
**added:** 2026-08-16
**files:** src/server/services/merge.service.ts
**tags:** concurrency, semaphore, fifo, merge-service

---

**A service that layers its own FIFO queue on top of a bounded semaphore must use only the non-blocking admission path.** `MergeService` (`src/server/services/merge.service.ts`) owns `private queue: number[]` and admits exclusively through `semaphore.tryAcquire()` (`:152,187`), never `acquire()`. `drainQueue()` (`:184-192`) is the sole promoter. Adding one `acquire()` call would create a second, independent waiting list inside the primitive that promotes on its own schedule, and FIFO across the two queues is undefined — a book could start ahead of an older queued book with no code path expressing that decision.

This stopped being structural and became a maintained invariant in #2379. `BoundedSemaphore.setMax` now calls `pump()`, so a capacity raise admits queued waiters immediately; the deleted `src/server/utils/semaphore.ts` had a mutation-only `setMax` that woke nobody, which made the two-queue hazard impossible by construction rather than by discipline. The pump is required for liveness in the general case — raising a bound that has already drained to `active === 0` has no holder left to release, so without pumping on resize the queue is stranded forever (pinned by `bounded-semaphore.test.ts` 'keeps a zero bound live: the queue survives the drain to empty and a later raise admits it', which reds if the `setMax` pump is removed).

`MergeService` is safe because its primitive queue is provably always empty. When reviewing or extending it, treat `tryAcquire`-only as a contract, not a style choice; the reason is recorded at `merge.service.ts:141-142`. The end-to-end proof that `setMax` + `tryAcquire` + `drainQueue` still compose is the `#1302 maxConcurrentProcessing — semaphore sizing + FIFO under resize` block in `merge.service.test.ts`. Consumers that want the primitive's own FIFO should call `acquire()` and keep no external queue — the two designs do not mix. Related: [[vacuous-assertion-observation-points]] for why the resize cases are counterfactual-verified.

## optional-interface-method-blocks-protected-hook

**source:** #2391
**added:** 2026-08-16
**files:** src/core/indexers/newznab-family.ts
**tags:** typescript, indexer-adapters, class-hierarchy

---

An OPTIONAL member on an interface is still a reserved name for any class that `implements` it. Optionality permits omitting the member; it does not permit redefining it with a different signature or a narrower visibility. A class that declares the name gets its signature checked against the interface and fails `TS2416` on any mismatch.

This bites when extracting a shared base for adapters. `IndexerAdapter` (`src/core/indexers/types.ts:110-124`) declares `resolveDownloadUrl?(ctx: ResolveDownloadContext): Promise<ResolveDownloadResult>` for MAM's grab-time sentinel resolution, and `refreshStatus?(signal?)` alongside it. `NewznabFamilyIndexer implements IndexerAdapter`, so it cannot use `resolveDownloadUrl` as the name of its own per-item URL-derivation hook however protected that hook is — the shipped name is `resolveItemDownloadUrl`, with the reason in a doc comment at the declaration so nobody 'corrects' it later. #2391's approved spec named the hook `resolveDownloadUrl` in AC2 and its class sketch; the collision was found at implementation time and the rename was forced, since changing `types.ts` was explicitly out of scope.

**When specifying a base class over `IndexerAdapter`, check its optional members before naming protected hooks.** When implementing one, expect a rename rather than a signature adjustment: the two members genuinely mean different things, so no parameter shape makes both work.

Verification note: `pnpm exec tsc --noEmit <file>` refuses to load `tsconfig.json` when files are named on the command line (`TS5112`), and this repo's `@shared`/`@core` aliases live there — so a probe of this kind has to be dropped into the tree and checked with `pnpm typecheck`, then deleted.

## exported-vifn-helper-needs-mock-annotation

**source:** #2383
**added:** 2026-08-16
**files:** src/server/__tests__/helpers.ts
**tags:** typescript, vitest, declaration-emit

---

`tsconfig.json` sets `declaration: true`, so `tsc --noEmit` still resolves declaration-emit names for every exported signature. An exported helper returning `vi.fn()` therefore fails with `TS2883: The inferred type of '<fn>' cannot be named without a reference to 'Procedure' from '.pnpm/@vitest+spy@<ver>/node_modules/@vitest/spy'` — `Procedure` is not reachable by name from the importing file under pnpm's nested layout.

Fix: annotate the return type as `Mock` (imported from 'vitest'). Do not reach for `ReturnType<typeof vi.fn>` — it re-introduces the same unnameable type.

This only bites when a per-suite mock factory is PROMOTED to a shared harness file: a module-local `function withStatus() { return vi.fn()... }` is never emitted to a `.d.ts`, so it typechecks fine in place and fails the moment you `export` it. That makes it a standing trap for fixture-consolidation chores (#2383 hit it moving three suites' `withStatus`/`answering` builders into `src/server/__tests__/helpers.ts`). Helpers returning plain values are unaffected. Reference: `mockSearchAllWithStatus` / `answeringSearchStatus` in `src/server/__tests__/helpers.ts`, both annotated `: Mock`.

## drizzle-dynamic-mode-conditional-builders

**source:** #2319
**added:** 2026-08-17
**files:** src/server/utils/db-helpers.ts
**tags:** drizzle, typescript, query-builder

---

Conditionally applying `.limit()`, `.offset()` or `.where()` to a Drizzle select narrows the builder type at each step, which is why the codebase had accumulated `query = query.limit(n) as typeof query` at six sites. The cast is avoidable, not inherent: `.$dynamic()` switches the builder into dynamic mode, where `SQLiteSelectWithout<T, TDynamic, K>` resolves to plain `T` (drizzle-orm 0.45.2, `sqlite-core/query-builders/select.types.d.ts`), so those methods return the type they were called on and can be applied conditionally and repeatedly. `.$dynamic()` is runtime identity — the emitted SQL and bound parameters are byte-identical.

A helper over such a builder needs no cast at all: constrain it as `<T extends SQLiteSelect>(query: T, ...): T` with `import type { SQLiteSelect } from 'drizzle-orm/sqlite-core'`. The type-only import matters — it keeps the module free of `@db/schema` runtime coupling, which is what `drizzle-schema-toplevel-deref-breaks-partial-mocks` warns about. `SQLiteSelect`'s default type arguments already fix `TDynamic = true`, so the constraint alone selects dynamic mode.

Canonical example: `applyPagination` in `src/server/utils/db-helpers.ts`, used by the six paginated list services. Guard with `!== undefined`, never truthiness — `limit: 0` is a real window and a truthiness guard silently returns every row (pinned by `db-helpers.test.ts` 'binds limit 0 rather than dropping it'). Note that `offset: 0` is unobservable in emitted SQL because Drizzle's dialect drops a falsy offset, so assert it at the builder level; see [[vacuous-assertion-observation-points]].

A site that forgets `.$dynamic()` fails `pnpm typecheck` (TS2345 at the helper call, plus a downstream TS2322 where the widened row type meets the method's declared return) — verify by exit code, not by grepping the output, since ANSI colour codes split the literal `error TS`. `mockDbChain` needs no change: its Proxy returns the chain for any unknown property, so `.$dynamic()` is transparent to every mock-based suite.

## qbittorrent-hybrid-v2-hash-rekey

**source:** #2423
**added:** 2026-08-18
**files:** src/core/download-clients/qbittorrent.ts
**tags:** qbittorrent, bittorrent-v2, libtorrent, download-clients, hash-identity

---

**A BitTorrent v1+v2 hybrid torrent does not keep answering to the v1 hash you grabbed it by.** qBittorrent on libtorrent 2.x re-keys its canonical API `hash` to the TRUNCATED v2 hash (first 40 hex chars of the SHA-256 v2 infohash) once metadata is fetched, moving the SHA-1 v1 to `infohash_v1` and the full 64-char v2 to `infohash_v2`. The switch lands seconds after the add, while the torrent is still in `metaDL` — so a poller that stored the v1 at grab time gets `[]` from `torrents/info?hashes=<v1>` on its FIRST cycle, reads that as death, and fails/blacklists a download that is running fine (#2423, observed live).

**Match on all three identities, never the canonical hash alone:** `hash`, `infohash_v1`, `infohash_v2.slice(0, 40)`, case-folded on both sides (magnet infohashes normalize lowercase via `normalizeInfoHash`, but `.torrent`-derived and operator-supplied values do not). Keep `?hashes=` as the fast path so v1-only torrents cost exactly one request and behave byte-identically; fall back to ONE (category-scoped) list scan only on a miss. Shipped as `isSameTorrent` / `resolveTorrent` in `src/core/download-clients/qbittorrent.ts`.

**Both fields must be `.nullish()`, and empty must never match.** qBittorrent < 4.4 (libtorrent 1.2) omits them entirely; current builds emit `""` for the axis a torrent lacks. An `infohash_v1: ""` must match nothing — including an empty queried hash — or the first element of the fallback list becomes a false positive. `.passthrough()` alone is not enough: it lets the fields survive parsing but leaves them untyped and therefore unreachable from `mapItem`/matching code, so declare them explicitly on `qbTorrentSchema`.

**The read path is not the whole defect.** qBittorrent resolves `hashes=` identically for `torrents/info`, `torrents/pause`, `torrents/resume` and `torrents/delete`. Fixing only `getDownload` makes the monitor track a hybrid all the way to a successful import and then silently fail to remove it — an orphan seeder plus a compensating-delete leak. Route the controls through the same resolution and POST the resolved canonical hash; when nothing resolves, send the caller's hash through unchanged so a delete for an already-gone torrent stays a no-op rather than an error.

Scope this to qBittorrent — v2-hybrid re-keying is a libtorrent-2.x behavior; Transmission (`hashString`) and Deluge are unaffected. Sonarr and Radarr both hit this and both resolved it by multi-identity matching. Testing it needs a real adapter over MSW, not a fake ([[degrading-adapter-invisible-to-mock-suite]]): a double that returns the item only exercises the branch where resolution already succeeded. Exemplars: the `hybrid v1/v2 hash identity (#2423)` describe in `src/core/download-clients/qbittorrent.test.ts` and `src/server/jobs/monitor-hybrid.integration.test.ts`.

## abb-tokenizer-keeps-apostrophe-in-word

**source:** #2422
**added:** 2026-08-18
**files:** src/core/indexers/abb-query.ts
**tags:** audiobookbay, indexer-query, search-ladder, tokenization

---

AudioBookBay's search is AND-over-stemmed-tokens, but its tokenizer treats the apostrophe as a WORD character: the indexed token for "Rider's" is matched by neither `rider` nor `riders`, and by no de-apostrophized spelling at all. Under AND semantics the only winning move is to omit the apostrophe-bearing word entirely — guessing its indexed form (straight vs curly, s vs no-s) is a losing bet.

**The structural trap.** The fold cannot live inside `abb.ts` on the query it receives. `cleanIndexerQuery` (`src/server/services/indexer-query.ts`) DELETES apostrophes rather than substituting a space, and `IndexerSearchService.prepareSearch` derives `transportQuery` from it before every `adapter.search()` call — so `Riders` from `Rider's` is indistinguishable from a genuine `Riders` by the time any adapter runs. `buildQueryLadder` strips even earlier, at `rung.query`. The apostrophe-bearing text exists exactly one layer above every strip site: `normalizeTitleForVariantMatch` keeps `'` and folds `‘`/`’` to it (keep class `/[^a-z0-9' ]+/g`), so `variant.raw` retains it — lowercased, which is why relaxed rungs are mixed-case (lowercase title, source-cased author).

**The shape that shipped (#2422):** an apostrophe-preserving twin cleaner (`cleanIndexerQueryKeepingApostrophes`, sharing the original's punctuation/whitespace tail so the two cannot drift), an optional `SearchOptions.queryWithApostrophes` populated in `prepareSearch` (caller-supplied wins), a REQUIRED `Rung.queryWithApostrophes` forwarded by all three rung-dispatch sites, and the pure fold `buildAbbQuery` in `src/core/indexers/abb-query.ts`. `rungDedupKey` stays keyed on `rung.query` alone — keying on the apostrophe form would split rung 1 from the equivalent full variant and lengthen the ladder.

**Do not widen `cleanIndexerQuery` instead.** Newznab, Torznab and MAM all tokenize normally, so `riders` matches there; changing the shared cleaner changes every one of their requests for a bug scoped to one indexer. This is per-adapter query MAPPING, not shared-query-builder policy — expect future indexer quirks to want the same treatment.

Related: [[degrading-adapter-invisible-to-mock-suite]] — the proof for this class has to drive the REAL adapter through the real service seam with MSW (`src/server/services/abb-apostrophe-query.integration.test.ts`), because a mock adapter builds whatever URL the test wants. [[ladder-rung-count-needs-colon-segments]] — the multi-rung half needs a colon-segmented fixture or it asserts nothing.

## buffer-base64-never-throws

**source:** #2421  
**added:** 2026-08-18  
**files:** src/core/indexers/abb-re-ab.ts  
**tags:** node, base64, buffer, input-validation

---

**`Buffer.from(x, 'base64')` never throws.** Measured on Node 24: `Buffer.from('not base64!!!***', 'base64')` returns mojibake bytes, `Buffer.from('', 'base64')` returns an empty buffer, and embedded whitespace is ignored entirely. A `try/catch` around a base64 decode is therefore not a guard — it can never fire — and any port of a decoder from a platform whose base64 function DOES throw (.NET's `Convert.FromBase64String`, which Jackett relies on) silently accepts every malformed payload.

Validity has to be an explicit test, on both sides of the decode:

1. **Before** — reject empty/whitespace-only, and require the alphabet: `/^[A-Za-z0-9+/]+={0,2}$/` over the whitespace-stripped payload. Strip whitespace first rather than rejecting on it: `Buffer` tolerates a blob split across newlines and indentation, and real payloads are formatted that way.
2. **After** — a decode that produced characters is not the same as a decode that produced what you asked for. For HTML, `cheerio.load(decoded, null, false)('*').length > 0` is the observation point: it answers `0` for `Hello`, `''` and mojibake, and `> 0` for any real markup fragment (cheerio@1.2.0).

Shipped at `src/core/indexers/abb-re-ab.ts:41-48` (#2421). The failure mode a guard invites in the other direction is over-rejection, so pin positive controls alongside the reject table — a padded blob, an **unpadded** blob, and a whitespace-split blob are all shapes `Buffer` accepts and a hand-tightened guard tends to refuse. Both tables live in `src/core/indexers/abb-re-ab.test.ts`. Same family as [[cheerio-br-zero-width-text]]: measure the library's actual behaviour before building code or tests on what it looks like it should do.

## url-setters-noop-on-opaque-path

**source:** #2434  
**added:** 2026-08-18  
**files:** src/core/indexers/abb-url.ts  
**tags:** whatwg-url, node-24, url-normalization, scheme-validation

---

**The WHATWG `URL` `protocol` and `host` setters are specified as no-ops when the URL has an opaque path** — every non-special scheme, including `javascript:`, `mailto:` and `data:`. `const u = new URL('javascript:alert(1)'); u.protocol = 'https:'; u.host = 'abb.test';` leaves `u.href === 'javascript:alert(1)'`. The same assignments on `https://other.test/x` work normally, which is what makes the trap survive a casual test.

**So never re-host a URL by assignment when the input is untrusted.** The natural rewrite — `const u = new URL(href, base); u.protocol = base.protocol; u.host = base.host; return u.href;` — returns the attacker/markup-supplied `javascript:` URL completely unchanged, and any downstream `startsWith('https://')` check becomes the only guard between it and a `fetch`. Instead: check `resolved.protocol` against `http:`/`https:` first, then COMPOSE the output as a string from the parts you want — `` `${base.origin}${resolved.pathname}${resolved.search}${resolved.hash}` ``. `rewriteAbbUrl` in `src/core/indexers/abb-url.ts` (#2434) is the model.

**This is a different branch from a constructor failure, and both need their own cases.** `new URL('http://[::1', base)`, `new URL('http://a b', base)`, `new URL('http://', base)` and `new URL('//', base)` all throw `Invalid URL` on Node 24 and never reach the scheme guard, so an implementation with no `try`/`catch` passes every wrong-scheme test and then throws out of the caller's loop. See the separate 'Arm A' and 'Arm B' describes in `src/core/indexers/abb-url.test.ts` — folding them into one table is exactly how the missing `catch` stays green.

Related, same file: `new URL('#', base)` and `new URL('?', base)` both resolve to `pathname === '/'` with an EMPTY `hash`/`search`, while `new URL('/?p=1', base)` keeps a non-empty `search`. That asymmetry is why a 'does this address a real page' predicate has to be `pathname === '/' && search === ''` and not `pathname === '/'`.

## render-template-drops-empty-segments

**source:** #2435  
**added:** 2026-08-18  
**files:** src/core/utils/naming.ts  
**tags:** naming, folder-format, path-rendering

---

`renderTemplate` (src/core/utils/naming.ts:304-317) filters empty path segments BEFORE calling `sanitizePath`, so a folder token with no value causes its entire segment to be dropped — `sanitizePath`'s `|| 'Unknown'` fallback (:143) is not reachable that way.

Measured against the real module:
- `renderTemplate('{author}/{year}/{title}', {author:'A', year:undefined, title:'T'})` → `'A/T'` (no `Unknown` segment)
- `renderTemplate('{author}/{title}', {author:undefined, title:'T'})` → `'T'`
- `renderTemplate('{author}/{title}', {author:':::', title:'T'})` → `'Unknown/T'` — the fallback fires only for a segment that is non-empty but sanitizes to empty.
- `renderFilename('{author} - {title}', {author:undefined, title:undefined})` → `'-'` — it does not split, so its single segment does reach the fallback.

Two consequences. First, do not write "an absent token renders Unknown" into a spec or a test for FOLDER templates; assert the segment's absence instead. #2435's AC25 asserted the fallback and was wrong, caught only because the test reded. Second, `{author}` looks like a counterexample but is not: `buildTargetPath` (src/server/utils/import-helpers.ts:108) defaults it to `'Unknown Author'` before templating, so it never reaches the template empty.

Worked reference: 'renders no year at all for a dateless incumbent (AC25)' in src/server/services/import-adapters/manual-attach.integration.test.ts, which drives a conflicting source-supplied year through to prove the outcome is absence rather than substitution.

## modal-null-return-keeps-usestate

**source:** #2435  
**added:** 2026-08-18  
**files:** src/client/pages/book/ImportFilesPicker.tsx  
**tags:** react, modal-state, component-lifecycle

---

`if (!isOpen) return null` does NOT unmount a React component — the fiber and its hook state survive, so a `useState` initializer runs once per mount rather than once per open. A modal holding a user choice therefore leaks that choice into its next session whenever the parent renders it unconditionally.

**The repo's convention is the outer-gate/inner-content split, not a reset effect.** `DirectoryBrowserModal` (src/client/components/DirectoryBrowserModal.tsx) is the reference:

```tsx
export function DirectoryBrowserModal({ isOpen, ...props }) {
  if (!isOpen) return null;
  return <DirectoryBrowserContent isOpen={isOpen} {...props} />;   // all state lives here
}
```

with the comment *'Mounting this inner component resets initialPath state without a syncing effect'*. Prefer it over `useEffect(() => setMode('copy'), [isOpen])`, which must be updated every time new state is added.

**When it actually bites.** Only when the parent mounts the modal unconditionally. In this codebase:
- unconditional (hazardous): `ImportFilesPicker` (BookDetails.tsx:128), `ManualAddFormModal` (SearchTabContent).
- conditionally rendered by the parent, so they genuinely unmount: `BookMetadataModal`, `BookFixMatchModal`, `RetagPreviewModal`, `BookEditModal` — their internal `return null` guard is belt-and-braces.

**Measured instance (#2435 / PR #2438, caught in review).** `ImportFilesPicker` defaulted its copy/move control to the safe `copy`. Selecting `move`, cancelling, and reopening retained `move`, so accepting the apparent default would have deleted the source. Fixed by the split above.

**Testing it.** `rerender` from `renderWithProviders` replaces the root and drops the provider wrapper, so it cannot express open→close→open here. Use a harness component that owns the flag and mounts the modal unconditionally, then assert the SUBMITTED payload (`onSubmit` args), not the control's `aria-checked` — the latter can pass while the value sent on submit is stale. Reference: src/client/pages/book/ImportFilesPicker.test.tsx.

## url-strips-trailing-query-whitespace

**source:** #2433  
**added:** 2026-08-18  
**files:** src/core/download-clients/qbittorrent.test.ts  
**tags:** whatwg-url, msw, query-params, test-observability

---

The WHATWG URL parser strips leading/trailing C0-control-or-space from its input string, so a whitespace-only query value in the LAST position of a URL is unobservable: `new URL('http://h/p?hashes=   ').searchParams.get('hashes')` returns `''` and href normalizes to `?hashes=`. Mid-URL it survives — `new URL('http://h/p?hashes=   &x=1')` gives `'   '`, percent-encoded as `%20%20%20`. Verified on Node 24.

Why it costs time: in an MSW test that inspects the outgoing request, the stripped value reads as an empty param, which is indistinguishable from production having dropped or mis-encoded it. A test asserting `params.get('x')).toBe('   ')` fails against correct production code.

**Rule.** When pinning empty/whitespace/blank input behavior at an HTTP seam, choose an observation point that survives URL normalization — assert the request COUNT delta (or a `.not.toBe(<the value the broken impl would send>)`), not the param value. Exemplars: the #2433 A9 cases in `src/core/download-clients/qbittorrent.test.ts`, where the count delta is exactly what separates a `!key` guard from a `!key.trim()` guard in `memoKey`. Distinct from [[msw-url-matching-ipv6-and-path-case]], which covers handler-side URL matching rather than request-side readback.

## layered-lock-boundary-park-point

**source:** #2369  
**added:** 2026-08-18  
**files:** src/server/services/claim-lock-protocol.integration.test.ts  
**tags:** locking, mutation-testing, test-observability, concurrency

---

**The trap.** When a system has more than one lock tier and you add or verify one of them, an ordered-boundary test observes only the tier that is actually held at the point you parked the first mutator. If an inner tier is also sufficient to produce the asserted ordering, deleting the outer one leaves the test green — the redundant-sites failure mode of [[symmetric-mutation-cannot-observe-shared-derivation]] arm B, in the locking medium.

**Measured instance (#2369).** Narratorr's three tiers are `withBookAdmissionLock` (book id, `src/server/utils/book-admission-lock.ts`) → the claim-key protocol (`src/server/utils/claim-lock.ts`) → the file key (`src/server/utils/path-write-lock.ts`). `renameBook` holds admission for the whole operation but its claim keys only from `withPathWriteLocks` onward. Parking the rename inside `fs.rename` — the gate `claim-lock-protocol.integration.test.ts` already provides — sits inside both tiers, so a delete issued against it blocks on the CLAIM key: removing deletion's admission acquisition left the suite 12/12 green. Parking inside `planApply` instead (gate the first `bookService.getById`) leaves the rename holding admission alone, and the same mutation reds.

**The rule.** Before writing an ordered-boundary case for a lock, enumerate every tier the parked mutator holds at the park point, and move the park to a moment where only the tier under test is held. If no such moment exists, the tier may be genuinely redundant for that pair — which is itself the finding.

**Observation points that discriminate.** Assert the contender has not reached its own first read — `expect(getById).toHaveBeenCalledTimes(1)` plus the durable row still naming the pre-mutation path — rather than asserting completion order, which both tiers produce. For a sweep bounded by a semaphore, count the participants that reached the lock (`events.filter(e => e.startsWith('lock.acquire:')).length`) rather than racing a timer; the deterministic count reds when the bound is removed and a wall-clock probe does not.

**Related.** Adding an outer lock to nearly every mutator also makes the lock registry shared suite state: a case that leaves a section running queues the next case's mutator behind it forever, surfacing as unrelated assertion failures in other files ([[shared-suite-state-inflates-counterfactual]]). Reset it in a `setupFiles` hook. See also [[vacuous-assertion-observation-points]].

## vitest-fork-teardown-crash-reds-green-suite

**source:** #2445  
**added:** 2026-08-18  
**files:** scripts/vitest-selection-guard.ts  
**tags:** vitest, ci, forks-pool, windows, json-reporter

---

Vitest's forks pool can crash at TEARDOWN — after every test file has already reported — and vitest counts the unhandled error and exits non-zero on a fully green suite. Observed ~1 run in 4 on `windows-latest` at vitest 4.1.10 (#2445). Signature: `Errors  1 error` / `Error: [vitest-pool]: Worker forks emitted error.` / `Caused by: Error: Worker exited unexpectedly`. Upstream vitest-dev/vitest#9762 is byte-identical on 4.0.18 and was closed as not planned, so a version bump is not a fix; #8861 (truncated module transfer) and #8766 (worker termination timeout) are different failures.

**Rule: to tell a post-suite teardown crash from a mid-run worker death, read the JSON report's per-test records — never its aggregate counters.** Both directions were measured on 4.1.10:

- A real mid-run kill (`process.kill(process.pid, 'SIGKILL')` inside a test, `--pool=forks --maxWorkers=1 --fileParallelism=false`): every selected file is still present (vitest enumerates modules up front, so a worker death omits nothing), the killed file's `status` is `'passed'`, `success` is `true`, and `numFailedTests`/`numFailedTestSuites` are 0. The only evidence is the killed test's `assertionResults[].status === 'pending'`.
- A clean run containing `describe.todo` (exit 0): `numPendingTestSuites` is 2 and the todo-only file's `assertionResults` is `[]`. So `numPendingTestSuites === 0` and 'reject an empty `assertionResults`' each false-red a healthy run.

Adjudicate with a CLOSED allowlist over `assertionResults[].status` — exactly `passed`, `skipped`, `todo`. Vitest's `StatusMap` maps `pass`→`passed`, `fail`→`failed`, `run`/`queued`/`only`→`pending`, `skip`→`skipped`, `todo`→`todo`, so deliberate work and unfinished work stay distinct where the counters collapse them. Anything unrecognized reds, which is what makes the rule fail closed against a future vitest. Also require `Array.isArray(testResults[].assertionResults)` (vitest always builds it with `tests.map(...)`) while ACCEPTING `[]`, and require at least one `passed` assertion so a record-stripped report cannot pass vacuously. Never gate on `numTotalTestSuites === testResults.length` — that counter counts `describe` blocks, not files (a 7-file run reports 40).

Implementation: `evaluateTeardownCrash` in `scripts/vitest-selection-guard.ts` (pure; all I/O injected via `GuardIo`), composed by `runVitestGuard`, CI entry `scripts/check-vitest-selection.ts`. Two deliberate positive fixtures in `scripts/vitest-selection-guard.test.ts` swallow reports whose counters are omitted and whose counters are mutually incoherent — they exist to red any future change that reintroduces counter arithmetic.

**Capturing the exit code in GitHub Actions:** the bash default is `-eo pipefail`, so `set +e` must precede the pipeline and the code must be read from `${PIPESTATUS[0]}`, not `$?`. Without `set +e` a non-zero run aborts the step before the guard sees it; with `$?` you get tee's status. Either mistake yields a silently-always-zero code, which turns the guard into a no-op that swallows real failures.

Stated limit: a file the run never SELECTED does not appear in the report at all, and a file enumerated but never COLLECTED is indistinguishable from a legitimate `describe.todo`-only file (both `assertionResults: []`). Neither is covered by this rule; the first stays covered by the per-project selection checks plus the `REQUIRED_FILES` control. See [[vitest-passwithnotests-hides-empty-selection]] — whose 'deliberately ungated — if the tests failed the job is already red for the right reason' sentence is now false: the guard step is the job's only verdict and adjudicates the exit code.

## playwright-webserver-precedes-globalsetup

**source:** #2452  
**added:** 2026-08-19  
**files:** e2e/playwright.config.ts  
**tags:** playwright, e2e-harness, process-lifecycle, config-evaluation

---

Two non-configurable facts about `@playwright/test` (verified on 1.62.1) that between them invalidate the natural reading of a harness config:

**1. `webServer` entries start BEFORE `globalSetup`.** Anything `globalSetup` prepares for the server is observed as absent by every boot-time reader. In this repo that is `runMigrations`, the `settings.general` log-level read, `AuthService.initialize()`, and all of `startRuntime` (`src/server/index.ts:112-176`, `src/server/startup.ts:18`). Seeding in `globalSetup` is therefore a nondeterminism generator, not merely a style choice — it produced the #2452 critical-path flake.

The fix shape is to move the setup into the server's own launch path so ordering is structural: make `webServer.command` a wrapper that seeds, verifies, then starts the server IN THE SAME PROCESS — `node --import tsx ./fixtures/seed-and-serve.ts`, which ends in `await import('../../dist/server/index.js')`. `--import tsx` registers the loader in-process so Playwright manages exactly one PID and its existing kill path keeps working; a bare `tsx <file>` CLI invocation forks a child and risks an orphaned server after teardown. Node has no `execve`, so a literal exec is unavailable. Verify the seed through a **fresh** connection before booting — a same-connection read cannot observe the defect this guards.

**2. `playwright.config.ts` is evaluated in MULTIPLE processes** — the runner, every worker, and tooling (`--list`, IDE extensions). Module-scope side effects run once per process, not once per run. Three `createRunTempDirs()` calls at module scope (5 `mkdtempSync` each) leaked ~15 directories per config load; **14,962** `narratorr-e2e-*` directories were measured in %TEMP% on 2026-08-18. Guard such work behind a manifest published on `process.env` at config time — config-time env DOES reach worker processes, unlike `globalSetup` env mutations which are same-process only. The first loader allocates and publishes; later loaders adopt and allocate nothing. Tooling processes inheriting no env still allocate one batch, so pair the guard with an age-floored sweep as a second line.

Two supporting details worth not re-deriving: `webServer.command` runs with `cwd` defaulting to the config file's directory (`runner/index.js:827`), and `webServer.env` is MERGED over `process.env` (`{...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...options.env}`, `runner/index.js:857-862`), so a shell override of a port variable does reach the wrapper.

See `e2e/README.md` "How the harness is wired" and "Ownership model", and the config sentinels in `e2e/global-setup.test.ts` that red if a `command` is reverted to a bare bundle launch.

## mutation-loop-restore-clobbers-uncommitted

**source:** #2440  
**added:** 2026-08-19  
**files:** src/server/services/enrichment-orchestration.helpers.ts  
**tags:** mutation-testing, git, test-observability

---

A mutate → run → restore counterfactual loop must NOT restore with `git checkout -- <file>` while the implementation under test is still uncommitted. The first restore reverts the file to the base branch, so every subsequent mutation is applied to unmodified code and the reds you record are the pre-implementation red set, not the mutation's.

Measured on #2440 (`src/server/services/enrichment-orchestration.helpers.ts`): mutation 1 red 3 tests correctly; mutations 2-4 each red exactly the 2 tests that are red on the base branch by construction (the new behaviour-change tests). Re-run with a file-copy restore gave the true 3/4/3/3 against a 129/129 green baseline.

The working shape:

```sh
cp $F /tmp/x.bak                  # before the loop
# per mutation: patch $F; run suites; cp /tmp/x.bak $F
diff /tmp/x.bak $F && echo RESTORED OK   # after the loop
```

Two detectors that catch it independently of the restore mechanism: (1) record an unmutated BASELINE run first — a mutation whose red set equals the baseline's proves nothing; (2) treat an identical red set across structurally different mutations as a harness failure, not a coverage result. Both are cheap and belong in any counterfactual pass, since the failure mode is silent and produces a receipt that reads as thorough.

Related: [[symmetric-mutation-cannot-observe-shared-derivation]] (its rule 2 — 'run the mutation, don't predict the red set' — is necessary but insufficient when the harness reverted the subject), [[shared-suite-state-inflates-counterfactual]] (misattributing a red that genuinely fired), [[vacuous-assertion-observation-points]] (the parent discipline).

## admission-handoff-continuation-order

**source:** #2462  
**added:** 2026-08-19  
**files:** src/server/utils/book-admission-lock.ts  
**tags:** book-admission-lock, promises, cancellation, test-observability

---

**A continuation attached to the promise `withBookAdmissionLock` returns fires after the next waiter's `fn()` has already begun.** The primitive (src/server/utils/book-admission-lock.ts:27-37) returns `run = prev.then(() => fn(), () => fn())` and separately registers `tail = run.then(...)` as the map entry, so the successor's `fn()` is invoked synchronously inside the predecessor's reaction. A test that parks the holder on a deferred and attaches `holder.then(() => cancel())` therefore lands on fully-registered successor state — measured in #2462, where the merge had already created its AbortController and reached `processAudioFiles` by the time the callback ran. Do not derive this from promise semantics on paper; the on-paper derivation predicts the opposite and produces a test that fails against correct code.

**Consequence:** there is no observable interleaving in which a waiter is 'awake but not yet registered', so a test aiming at that gap is unwritable. Pin the two sides of the boundary instead — before the wake takes one arm, after the wake takes the other, neither yields a wrong verdict — and write the structural argument (which statements share a synchronous block) into the test as a comment, per [[vacuous-assertion-observation-points]]. Related: [[layered-lock-boundary-park-point]] covers which lock TIER a parked test observes; this entry covers WHEN within one tier's handoff a continuation lands.

## empty-filter-param-is-no-filter

**source:** #2485  
**added:** 2026-08-19  
**files:** src/core/__tests__/qb-hash-filter.ts  
**tags:** qbittorrent, test-doubles, query-params, msw

---

**A filter parameter sent empty is usually 'no filter', not 'a filter matching nothing' — and a test double that gates on `params.has(name)` models the opposite.** qBittorrent's `/api/v2/torrents/info` splits `hashes` on `|` with `Qt::SkipEmptyParts` and builds an id set only when at least one part survives (torrentscontroller.cpp:608-625). So an absent `hashes`, `?hashes=`, and `?hashes=||` all mean NO filter and answer with the FULL list; a surviving part — including a whitespace-only one, which SkipEmptyParts does not drop — is a real filter and answers `[]` on a miss.

Every qBittorrent list double in this repo used `params.has('hashes')` (or a truthiness gate on the value) as its fast-path/scan discriminator. That made a blank hash look like a filter that matched nothing, which is precisely the shape that masked #2485: `resolveTorrent` probed `?hashes=` with a raw blank hash, the real client answered the full list, and the memo-hit `probed[0]` adoption returned an arbitrary torrent — so `removeDownload('', true)` deleted the wrong torrent's files. Two prior issues (#2423, #2433) worked on this exact resolver with the mask in place and read the memo guard as holding end-to-end.

**Rule.** When a double stands in for a filtering endpoint, write the API's filter rule down ONCE as a shared predicate with its own unit fence, and make every double consult it — do not re-express it per site. `servesFullList(params: URLSearchParams)` in `src/core/__tests__/qb-hash-filter.ts` is that home here (`@core/__tests__/` is importable from core, server, and `e2e/` suites alike); `qb-hash-filter.test.ts` is the one place the semantics are asserted rather than used. Seven consumers route through it: `qbittorrent.test.ts`, `registry.test.ts`, `monitor-hybrid.integration.test.ts`, `blank-external-id.integration.test.ts` (#2485's own suite), `msw-handlers.ts` (whose default IS production behavior for six e2e suites — see [[shared-test-double-defaults]]), the `multi-entity.e2e.test.ts` inline handler, and `e2e/fakes/qbit.ts`.

**Two encoding traps in the fence.** `%20%20%20` and `+++` both decode to three real space characters through `URLSearchParams`, so they are surviving parts and therefore a real filter. Raw literal trailing whitespace is stripped by the WHATWG URL parser before `searchParams` ever sees it and is indistinguishable from `?hashes=` — which is why blank-input production behavior is pinned by request COUNT, not param value ([[url-strips-trailing-query-whitespace]]).

**Auditing for this shape:** grep the suite for `params.has(<filter>)`, `searchParams.get(<filter>)` used as a boolean, or `if (value)` gating a filtered response, and ask what the real server does with an empty value. Scope the grep past `src/` — the Playwright fake at `e2e/fakes/qbit.ts` carried its own copy of the rule and diverged on `?hashes=||`. Related: [[degrading-adapter-invisible-to-mock-suite]] (drive the real adapter over MSW, since a fake that returns the item only exercises the branch where resolution already succeeded) and [[qbittorrent-hybrid-v2-hash-rekey]] for the three-identity resolver this filter feeds.

## solver-abort-after-slot-not-after-call

**source:** #2483  
**added:** 2026-08-19  
**files:** src/core/__tests__/solver-routes.ts  
**tags:** abortcontroller, solver-concurrency, vitest, test-observability

---

On the solver transport a concurrency slot is acquired BEFORE the request is issued (`fetchViaProxy` awaits `acquireSolverSlot` at src/core/indexers/fetch.ts:113, then calls `postToSolver`). A cancellation test that aborts synchronously after calling `fetchWithProxy` therefore aborts in the pre-request window and never reaches the `AbortError` arm it means to exercise — abort only once the POST is genuinely on the wire, by resolving a barrier promise from inside the fetch stub and awaiting it first.

Compounding it: a fetch stub that models a stalled request with `signal?.addEventListener('abort', reject)` alone NEVER settles when the signal is already aborted, because an `abort` event does not re-fire. The result is a 15s timeout instead of a readable assertion failure, and the still-held solver slot then corrupts unrelated cases in the same file (`_resetSolverConcurrencyForTesting` restores bookkeeping but holds no handle on in-flight fetches), so the first visible symptom is a wrong concurrency count in a different test. Always guard with `if (signal?.aborted) return abort()` before subscribing.

`hangUntilAborted(signal)` in `src/core/__tests__/solver-routes.ts:92-96` has this gap today — it hangs unconditionally for a null/undefined or already-aborted signal. It is currently safe only because its callers pass live signals. Reference shape: the `cancellation (AC17)` describe in `src/core/indexers/fetch.test.ts` (#2483). Related: [[abort-verdict-not-error-shape]] (keep the verdict on `signal.aborted`, never on the error), [[msw-network-error-has-no-transport-code]] (why this harness exists at all).

## event-history-tx-arm-partial-doubles

**source:** #2481  
**added:** 2026-08-19  
**files:** src/server/services/event-history.service.ts  
**tags:** event-history, test-doubles, transactions, drizzle

---

`EventHistoryService.create` has two arms. Without `tx` it inserts and logs. With `tx` (`src/server/services/event-history.service.ts:63-81`) it is deliberately side-effect-free — no logging, because the caller may still roll back — and returns the inserted `BookEventRow` so the transaction owner calls `eventHistory.logRecorded(row)` after its commit (`:83-86`). `BookDeletionService.commitDeletion`/`reportCommitted` is the reference shape.

**The trap when adopting that arm.** Suites commonly fake the service as `{ create: vi.fn().mockResolvedValue({}) } as unknown as EventHistoryService` (the shape #2499 retired from the refused suite in favour of the real service over the migrated DB). That fake returns a TRUTHY non-row and has no `logRecorded`, so the owner's post-commit call throws `TypeError: eventHistory.logRecorded is not a function`. The throw lands AFTER the transaction has committed, so the durable assertions in those suites still pass and only the post-commit work disappears — in #2481 the `import_failed` SSE, presenting as three failures in a suite the change never touched. There is no way to distinguish the fake's `{}` from a real row at runtime, so this cannot be defended against by inspecting the return value.

**Two rules.** (1) When you move an event write onto the `tx` arm, grep sibling suites for partial `EventHistoryService` doubles in the same change; the suite that breaks is not the suite you edited. (2) Isolate post-commit reporting. Once the transaction has committed, the operation has succeeded, and neither the event log nor anything else in the reporting tail may reject into the caller — `src/server/utils/safe-emit.ts:7-19` already encodes exactly this rule for the broadcaster (null-guard plus try/catch at debug); `src/server/services/import-refused.ts` applies it to the `logRecorded` call, and `BookDeletionService.reportCommitted` (`book-deletion.service.ts`) isolates each of its two arms independently since #2536 — both are reference implementations.

Related: [[shared-test-double-defaults]] — the same family, where a shared double's shape silently becomes production behaviour for suites that never changed.

## node-report-triggers-miss-native-sigsegv

**source:** #2496  
**added:** 2026-08-19  
**files:** src/server/boot-crash-forensics.ts  
**tags:** node-diagnostic-report, sigsegv, core-dumps, docker

---

**Node's diagnostic-report triggers do not cover native crashes.** `--report-on-fatalerror` fires on V8 fatal errors and `--report-uncaught-exception` on the uncaught-JS path; neither fires for a SIGSEGV raised inside a native addon (e.g. the libsql `.node` binding). The same gap applies to everything registered at the top of `src/server/index.ts` — `uncaughtException`, `unhandledRejection`, the `exit` logger, the `process.exit` interceptor, and `src/server/utils/crash-logger.ts`. For a native fault the evidence paths are core dumps and the host kernel log (`journalctl -k | grep -i segfault` names the faulting `.node` object), not reports. Do not add report flags in response to a signal-11 crash and expect them to help.

**`--report-on-signal --report-signal=SIGUSR2` is the one genuinely new capability**, because it snapshots a LIVE process (libuv handles, heap, native + JS stacks) during a pre-crash window without killing it.

**Always pair it with `--report-exclude-env`.** Reports serialize an `environmentVariables` block by default, and this process's environment holds `NARRATORR_SECRET_KEY` and `DATABASE_URL` — the same secret-bearing environment `src/core/utils/sanitized-env.ts` exists to keep out of spawned scripts. Verified: with the flag, a captured report contains zero occurrences of `environmentVariables`.

**`process.report` fields read back RAW, not resolved.** `--report-directory=rel/dir` reads back as the literal `rel/dir`, and the default `''` means the process CWD. Resolve before comparing (`path.posix.resolve(cwd, directory)` in `reportConfigLeg`, `src/server/boot-crash-forensics.ts`) — a `startsWith` or raw-equality check silently passes a deployment whose reports land in `/app`. `process.report.filename` is likewise operator-settable at runtime through `NODE_OPTIONS`, which is why the artifact classifier keys on content and never on a name.

**Node's written report file starts with a leading newline** before the opening `{` (confirmed with `od -c`), so a byte-prefix check on report files is wrong; parse the document. Real captured report: `header.reportVersion === 5`, ~13 KB with `--report-exclude-env`. Both the default and `--report-compact` forms parse to the same `header.reportVersion`.

**`kernel.core_pattern` is a global, non-namespaced sysctl.** A container cannot set it and must not try; it is a host step, documented in `docs/crash-forensics.md`. For the non-pipe form the kernel writes through the crashing process's mount namespace, so an absolute host pattern under `/config/crash-reports` lands in the container's volume. For the pipe form a host handler (systemd-coredump, apport) owns the core and `coredumpctl` is the retrieval path.

## boot-entrypoint-call-order-vitest

**source:** #2496  
**added:** 2026-08-19  
**files:** src/server/boot-crash-forensics.wiring.test.ts  
**tags:** vitest, vi-mock, boot-order, fastify

---

**When a boot step's correctness IS its position, assert the order at runtime.** A static source-text assertion (`expect(source).toContain('await fooAtBoot(app.log);')`) is fine as a supplement — it catches a helper that exists but is never called — but it cannot distinguish correct ordering from exactly-backwards ordering, which is usually the whole defect. `src/server/index.ts` can be booted in a Vitest file with its boundaries mocked, giving a real call-order recorder. Reference implementation: `src/server/boot-crash-forensics.wiring.test.ts`.

Shape: a module-scope `const order: string[] = []`, ~16 `vi.mock` factories that push their own name, then `await import('./index.js')`, then assert with `order.indexOf(a) < order.indexOf(b)`. Modules to mock: `./config.js`, `fastify` (a stub app with `log`, `withTypeProvider`, `setValidatorCompiler`, `setSerializerCompiler`, `register`), `@db/index.js`, `./routes`, `./startup.js`, `./server-utils.js`, `./shutdown.js`, `./services/backup.service.js`, `./plugins/{auth,error-handler,security-plugins}.js`, `./routes/v1/openapi.js`, `./request-trace-logging.js`, `./boot-warnings.js`, `./boot-{ffmpeg,mutagen}-version.js`, `./utils/secret-codec.js`, `./utils/secret-migration.js`.

Three traps, all of which bite:

1. **`main()` fires from module scope**, so the `import()` promise resolves before boot finishes. Follow the import with `await vi.waitFor(() => expect(listenWithRetry).toHaveBeenCalled(), { timeout: 10_000 })` — asserting immediately after the import reads a half-built `order` array.
2. **`src/server/index.ts` reassigns `process.exit` and registers `process.on('exit')` at import time.** This is only survivable because Vitest's forks pool isolates per test file. It also means any mock gap that lets `main()` reject reaches `main().catch(() => process.exit(1))` and kills the worker with no useful output — a mysteriously vanishing test file is almost always an under-mocked boundary.
3. **Mock the module under test PARTIALLY**, via `importOriginal()` and wrapping its real exports, rather than replacing them. The order recorder still works, and the real implementations run — which in the reference case also covers the first-boot shape (a real prune against a non-existent directory) for free in the same test.

**Prove it isn't vacuous.** Move the call being ordered to the wrong side and confirm only the ordering test reds. See `vacuous-assertion-observation-points`.

## testing-library-nested-text-matcher

**source:** #2495  
**added:** 2026-08-19  
**files:** src/client/components/RetagPreviewModal.test.tsx  
**tags:** testing-library, jsdom, react-testing

---

testing-library's default text matcher calls `getNodeText`, which concatenates ONLY an element's direct TEXT_NODE children — nested element text is excluded (this is not `textContent`). So copy with inline markup, e.g. `<p>Re-tagging supports <code>.mp3</code>, <code>.m4a</code>, and <code>.mp4</code>.</p>`, presents to the matcher as 'Re-tagging supports , , and .'. A regex spanning the tags (/supports .*\.mp3.*\.mp4/) can never match, and the failure reads as missing copy rather than a matcher limitation — inviting a debug of the wrong layer.

Prefer: match a contiguous prefix, then assert on the element's textContent:
```ts
const copy = await screen.findByText(/Re-tagging supports/);
expect(copy.textContent).toContain('.mp4');
```
A matcher function `(_, el) => el?.textContent?.includes(x)` also works but matches every ancestor as well, so it needs a tag/role narrowing to stay unambiguous. Live example: src/client/components/RetagPreviewModal.test.tsx (#2495). Note the near-miss that hides this: an assertion on a contiguous clause in the SAME paragraph passes normally, so the file can look like it already proves the matcher works.

## join-delimiter-needs-two-element-fixture

**source:** #2480  
**added:** 2026-08-20  
**files:** src/server/utils/import-steps.test.ts  
**tags:** mutation-testing, test-fixtures, vitest

---

A fixture with one element in a collection cannot observe how that collection is JOINED: `['A'].join('; ')` and `['A'].join(', ')` are byte-identical. So an assertion pinning a joined string against a single-item fixture is vacuous for the delimiter, however precise its expected literal looks.

Measured on #2480: `buildTagProjection` (`src/server/utils/tag-projection.ts`) joins `authors`/`narrators` with `', '` and feeds BOTH the retag path (`tagging.service.ts`) and the import embed (`import-steps.ts`). Mutating `joinNames` to `join('; ')` left all 150 tests in `src/server/utils/import-steps.test.ts` green — every fixture there carried one author and one narrator. Widening the fixture to two names per axis reds 6 of them on the same mutation.

Rule: when the property under test is how a list is combined (join delimiter, sort order, dedup, first-vs-all selection), the fixture needs at least two elements, and they must be distinguishable. This is the fixture-cardinality sibling of [[symmetric-mutation-cannot-observe-shared-derivation]]: there the wrong MUTATION was chosen, here the mutation is right and the FIXTURE cannot see it. Both are instances of [[vacuous-assertion-observation-points]], and both are only findable by running the mutation — reading the assertion suggests it is airtight.

Same-shaped joins elsewhere in this repo: `snapshotBookForEvent` (`src/server/utils/event-helpers.ts`) and `buildCanonicalTags`'s `artist`/`albumArtist`/`composer` (`src/server/services/retag-plan.ts`).

## iteach-mixed-type-column-arity

**source:** #2504  
**added:** 2026-08-20  
**files:** src/shared/schemas/search-stream.test.ts  
**tags:** vitest, typescript, table-tests

---

An `it.each` table whose rows mix value types in a single column infers a UNION of tuple types (`[string, string] | [number, string]`), and TypeScript cannot spread a union of tuples into a callback that declares fewer parameters than the row's arity. The same shorter callback is accepted against a homogeneous table, where the rows infer as one tuple type and TS's ordinary 'a function may declare fewer parameters' rule applies.

This bites the common negative-case table shape — each row pairing a bad input with a description used only in the test name:

```ts
// fails typecheck: 'Source has 2 element(s) but target allows only 1'
it.each([
  ['64 Kbps', 'a display string'],
  [64.5, 'a fraction'],
])('rejects %s — %s', (value) => { ... });

// passes: the annotation collapses the rows to one tuple type
it.each<[string | number, string]>([...])('rejects %s — %s', (value) => { ... });
```

Verified under Vitest 4.1.10. The error message names the arity, not the mixed types, so it reads as though the callback simply needs a second parameter — declaring one works but leaves an unused binding; the annotation is the smaller fix. Note this fails `pnpm typecheck` and NOT `vitest run`, so a targeted test-file run will not surface it. Live example: the `searchResultSchema — bitrateKbps (#2504)` describe in `src/shared/schemas/search-stream.test.ts` (annotated) against the absence table in `src/core/indexers/abb-fields.test.ts` (homogeneous, unannotated, and fine).

## undici-socks5-bracketed-ipv6-atyp

**source:** #2484  
**added:** 2026-08-20  
**files:** src/core/indexers/proxy.ts  
**tags:** undici, socks5, proxy, ipv6

---

undici 8.9.0 exports a first-party `Socks5ProxyAgent` that `extends Dispatcher`, so it works with `undici.fetch`. `socks-proxy-agent`'s `SocksProxyAgent` does NOT — it is a Node `http.Agent` (`addRequest`), and handing it to `undici.fetch` fails as `TypeError: fetch failed` / `cause: TypeError: agent.dispatch is not a function` with no `code` on either error. That shipped undetected because `proxy.test.ts` mocks `fetchWithOptionalDispatcher` down to `globalThis.fetch` and only asserted `instanceof <concrete class>`; assert `instanceof Dispatcher` for every branch instead (see [[degrading-adapter-invisible-to-mock-suite]]).

Target address encoding, measured against a stub RFC 1928 listener:
- IPv4 literal → ATYP `0x01`.
- Hostname → ATYP `0x03`, hostname bytes intact: remote DNS (socks5h). The proxy resolves the target, so `makeValidatingLookup` never sees it on this path — correct for a privacy proxy, and not a reason to add address-blocking (the proxy is an operator-configured destination).
- **IPv6 literal → ATYP `0x03` carrying the bracketed string `[::1]`, not ATYP `0x04`.** undici passes `new URL(origin).hostname` through unchanged and its `parseAddress` tests `net.isIPv6`, which is false for a bracketed string — the same Node quirk `normalizeHostname` (`src/core/utils/network-service.ts:88`) exists for. A conforming proxy resolves `[::1]` as a domain name and returns host-unreachable. Not fixable via options: `connect` configures the hop to the *proxy*, and a URL cannot carry an unbracketed IPv6 literal.

#2484 therefore refuses IPv6-literal targets on the SOCKS5 path with a `ProxyError` before any tunnel opens (`createProxyAgent` takes a required target URL). Two placement traps, both pinned by tests: the guard must sit AFTER the `if (!proxyUrl) return undefined` early return, or it refuses ordinary *direct* IPv6 requests; and OUTSIDE the factory's bare `catch`, which rewrites everything it catches as `Invalid proxy URL: …` and would silently swallow the actionable message. If IPv6 over SOCKS5 is ever actually needed, the path is a custom `Agent` whose `connect` hook opens the tunnel via the `socks` package and passes the socket to `buildConnector` as `httpSocket` — `socks` left the tree with `socks-proxy-agent` and would have to be re-added directly.

Other measured behaviours worth not rediscovering: URL credentials are percent-decoded with `decodeURIComponent`, so malformed encoding throws `URIError` from the CONSTRUCTOR (keep the factory's catch-all); a proxy that accepts TCP then goes silent fails at undici's own 5s ceiling with `cause.message === 'SOCKS5 authentication timeout'`, so it lands in the generic `Proxy connection failed:` arm, never `Proxy timed out after Ns`; rejected RFC 1929 auth gives `cause.code === 'UND_ERR_SOCKS5_AUTH_FAILED'`. Agent construction emits a one-per-process `ExperimentalWarning` — accurate and cheap, do not suppress it. Exemplars: `src/core/indexers/proxy-socks5.contract.test.ts` and the reusable listener at `src/core/__tests__/socks5-stub.ts`.

## race-ordering-counterfactual-needs-leaf-promise

**source:** #2477  
**added:** 2026-08-20  
**files:** src/server/services/search-deadline.ts  
**tags:** promise-race, abortcontroller, mutation-testing, test-observability

---

The reject-before-abort ordering in [[race-timeout-reject-before-abort]] is only OBSERVABLE where the raced promise is the leaf itself. Write that counterfactual at the deadline helper's own suite; do not re-point it at a caller.

Mechanism: the timer callback settles the `timeout` promise synchronously. A leaf that rejects from its own abort listener also settles synchronously — so with the wrong order it can win. But once the raced `work` is an async chain (and especially one with a catch that converts failures into resolved outcomes), the leaf's settlement needs several microtask hops to reach `work`, and the timeout always wins regardless of statement order. The counterfactual then passes under the mutation and proves nothing.

Measured on #2477: flipping `search-deadline.ts:75-76` reds exactly `search-deadline.test.ts:125` (where `fn` returns the leaf promise directly) and leaves the byte-equivalent case in `retry-search.test.ts` green, because `runBoundedRetryLadder`'s `try/catch` converts the leaf rejection into a resolved `retry_error`.

Two corollaries for any caller with a converting inner catch:
- The helper's `'Abandoned search work FAILED after its deadline'` warn is unreachable from that caller; the `'...RESOLVED after its deadline'` arm fires instead. A test plan asking for the warn is asking for a state the code cannot reach.
- A caller-level abort-listener case is still worth keeping, but as a control on the VERDICT — the caller receives the canonical deadline error, never the leaf the abort provoked. Comment it as such so nobody later reads a green mutation run as proof the ordering is pinned.

An instance of [[vacuous-assertion-observation-points]]: the observation point moved layers, and the property moved with it.

## import-failure-cleanup-is-per-file

**source:** #2475  
**added:** 2026-08-20  
**files:** src/server/utils/import-steps.ts  
**tags:** import-staging, vitest, test-observability, node-fs

---

`handleImportFailure` (src/server/utils/import-steps.ts:403-437) never calls `rm(targetPath, { recursive: true })`. Its unprotected arm calls `deleteManagedBookFiles`, which issues `rm(file, { force: true })` per managed entry and then `rmdirIfEmpty` → `rmdir(targetPath)`. The recursive form is reserved for the `.import-staging` / `.import-backup` siblings (`removeImportSibling`). `cleanupOldBookPath`'s sweep shares the same helper and the same property.

**Consequence:** `expect(rm).not.toHaveBeenCalledWith(TARGET, expect.objectContaining({ recursive: true }))` is VACUOUS as a proof that the target's files survived — it passes under every implementation, including one that deletes the whole folder file by file. Several pre-existing #1255 assertions in src/server/services/import.service.test.ts (lines 958, 981, 1007, 1075) have this shape.

**The observation point that works** is the pair:

```ts
expect(rm).not.toHaveBeenCalledWith(join(TARGET, 'old.mp3'), { force: true });
expect(rmdir).not.toHaveBeenCalledWith(TARGET);
```

with the positive form (`toHaveBeenCalledWith`) for the arm that SHOULD clean. Arm `readdir` to return real entries first (the `withExistingAudioAndCover()` helper in that suite), or the per-file assertion has nothing to observe. Reference: the `#2475: a pre-commit failure preserves the operator audio when the stored path uses %s` it.each and its case-only negative in src/server/services/import.service.test.ts, plus the `#2475` cases in src/server/utils/import-steps.test.ts.

Related: [[import-cleanup-marker-aware-fs-mock]] (a blanket `stat` mock flips the same assertions to pass via marker preservation instead) and [[vacuous-assertion-observation-points]].

## widened-invalidation-reopens-optimistic-cancel-window

**source:** #2541  
**added:** 2026-08-21  
**files:** src/client/components/SeriesCard.tsx  
**tags:** react-query, sse, cache-invalidation

---

TanStack Query v5. [[react-query-optimistic-cancel]] states that the window `cancelQueries` protects (between `setQueryData` and `onSettled`'s invalidation) is not deterministically reachable. That is true only while nothing ELSE invalidates the mutation's key mid-flight. Enrolling a broader prefix in an event-driven invalidation reopens it, and `onMutate`'s cancel does not cover it — that cancel runs before the competing refetch is started.

#2541 added `invalidateQueries({ queryKey: ['book'] })` to `invalidateFromRule` (src/client/hooks/useEventSource.ts) for the five status-bearing SSE events. `queryKeys.bookSeries(id) = ['book', id, 'series']` prefix-matches it, and `SeriesCard`'s refresh mutation is a `cancelQueries`(onMutate) + `setQueryData`(onSuccess) pair on that key. Losing order: mutate → onMutate cancels (nothing in flight) → SSE event invalidates `['book']` → mounted observer refetches → mutation resolves and writes the refresh body → the refetch resolves LAST and overwrites it with a pre-refresh body. The card silently reverts.

Fix: repeat the cancel at the write, not just at the start.

```ts
onSuccess: async (response) => {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, { series: response.series });
},
```

Testing it: the end-state assertion is vacuous unless the competing GET is held open PAST the mutation's write. A `mockResolvedValue` settles inside the same macrotask as the SSE dispatch and never races — use a deferred promise released after `releaseRefresh`, and assert `getBookSeries` was actually called a second time so the refetch is proven to have fired. Reference: src/client/components/SeriesCard.sse.test.tsx, 'a refresh in flight when a status event lands still settles on the refresh response'.

General rule: widening an invalidation key is not purely additive. Audit every optimistic mutation whose key now falls under the widened prefix, and check whether its existing guard sits at a lifecycle point that can see the new invalidation source. Related: [[sse-setquerydata-not-invalidate]], [[setquerydata-notify-is-a-macrotask]], [[vacuous-assertion-observation-points]].

## undici-dispatcher-close-reentrant

**source:** #2539  
**added:** 2026-08-21  
**files:** src/core/__tests__/dispatcher-capture.ts  
**tags:** undici, vitest, dispatcher-lifecycle, spy-call-counts

---

undici 8's `DispatcherBase.close()` with no argument returns `new Promise((res, rej) => this.close(cb))` — it re-enters the SAME instance method in callback form. Since `vi.spyOn(dispatcher, 'close')` shadows the prototype method with an own property, BOTH the outer and inner calls hit the spy, and one production `await dispatcher.close()` records `spy.mock.calls.length === 2`. Inherited from `DispatcherBase`, so `ProxyAgent`, `Socks5ProxyAgent` and `Agent` all behave this way.

This reads exactly like a double-close bug in production code, which is the trap: the count is wrong, not the code.

**Rule.** When the call COUNT is the assertion, stub the spy (`spy.mockResolvedValue(undefined)`) — that suppresses the internal recursion and leaves precisely the production call. Call through only when the real close must actually happen, and then assert `toHaveBeenCalled()` instead of a count.

Shared helper: `src/core/__tests__/dispatcher-capture.ts` (#2539) — `captureDispatcher(mockHelper, respond, {closeRejects})` captures the real dispatcher off `init.dispatcher` in a mocked `fetchWithOptionalDispatcher` and exposes `closeCalls()` meaning 'times production called close'. Used by `proxy.dispatcher-routing.test.ts` and `myanonamouse.dispatcher-routing.test.ts`. The call-through variant lives in `proxy-socks5.contract.test.ts`, where a real `Socks5ProxyAgent` must genuinely close and the assertion is correspondingly looser.

Related: [[degrading-adapter-invisible-to-mock-suite]] — the mocked routing suites capture a dispatcher the transport never used, so at least one close assertion belongs on the real SOCKS5 harness.

## eslint-typeaware-heap-ceiling

**source:** #2538  
**added:** 2026-08-21  
**files:** package.json  
**tags:** eslint, typescript-eslint, node-memory, ci-flake

---

`pnpm lint` runs type-aware rules over the whole project (`projectService: true` in eslint.config.js), which peaks around 1.9 GB — close enough to Node's ~2.24 GB default old-space ceiling that the run dies with `FATAL ERROR: Ineffective mark-compacts near heap limit` (exit 134) on roughly half of invocations, on the same commit, with no lint error to show for it.

Because the crash is GC-timing dependent it is NOT reproducible on demand and reads as a flaky CI box. Before attributing a verify `exit 134` to your own branch, re-run lint on the parent commit twice — a commit that already passed verify will fail the same way.

The `lint` and `lint:fix` scripts therefore invoke ESLint as `node --max-old-space-size=4096 node_modules/eslint/bin/eslint.js .` rather than through the `eslint` bin. Do not 'simplify' this back to `eslint .`.

Invoke `node` explicitly rather than prefixing `NODE_OPTIONS=`: a shell variable prefix is not valid Windows `cmd` syntax, and `pnpm verify` is the pre-push gate on Windows (CLAUDE.md). `cross-env` is not a dependency. The rationale lives in CONTRIBUTING.md's Quality Gates section because package.json cannot carry comments and a bare `--max-old-space-size=4096` invites deletion as cargo cult.

## rendered-error-message-as-data-channel

**source:** #2537  
**added:** 2026-08-21  
**files:** src/server/utils/hardcover-error.ts  
**tags:** error-messages, metadata-providers, hardcover

---

When an error message is the only channel carrying a structured value — because the error type holds just `provider` + `message` and widening a shared error type for one adapter's diagnostics was rejected — the message becomes a serialization format, and both ends need delimiter discipline.

**Reader: match a whole entry at a separator boundary, never search the message for the key.** `/\bscope:\s*([^;)]+)/` over ` (error: insufficient_scope; error_description: retry with scope: admin)` captures `admin` from prose. Use `message.split('; ').find(p => p.startsWith(`${key}: `))` — a key mentioned mid-value cannot START an entry. Two traps this also closes: a terminator character class like `[^;)]` truncates a legitimate value containing a paren, and left-to-right scanning means a prose mention rendered BEFORE the real key wins, so a wrong value overrides a right one rather than only filling in for a missing one.

**Renderer: neutralize your own separator inside values.** Anchoring the reader is necessary but NOT sufficient — an upstream value of `"do this; scope: admin"` renders a literal `; scope: ` and forges the boundary. `describeHardcoverErrorBody` (src/core/utils/hardcover-http.ts) applies `.replace(/;/g, ',')` after the length cap. Scope the neutralization to the separator only: under a `startsWith` reader, parentheses and other punctuation cannot forge an entry, so mangling them buys nothing and costs the operator readability.

**Test the pairing, not each half in isolation.** Build the message in the reader's test by running a real body through the renderer and formatting it the way the adapter does; a hand-written expected suffix lets the two halves drift. Reference: `mapHardcoverError` / `renderedDetail` in src/server/utils/hardcover-error.ts, tests in hardcover-error.test.ts and hardcover-http.test.ts (#2537, PR #2553 F1).

**Scope note:** this is about a value read back out programmatically. Presence-only substring checks — `message.includes('401')` for routing an invalid-key hint — do not have the fabrication failure mode and are a deliberate, separately-pinned contract here.

## widened-projection-invisible-to-partial-mock-rows

**source:** #2535  
**added:** 2026-08-21  
**files:** src/server/services/enrichment-orchestration.helpers.ts  
**tags:** drizzle, test-doubles, test-observability

---

Adding a column to an existing `tx.select({...})`/`db.select({...})` projection is INVISIBLE to every suite whose mock rows are object literals: the new key is absent, production reads `undefined`, behaviour is unchanged on the empty path, and all pre-existing cases stay green. Typecheck cannot catch it either — the handle is `as unknown as Db`, so the chain mock's resolved value is never structurally compared against the projection's inferred row type.

Measured on #2535: widening the projection in `applyEnrichmentData` (`src/server/services/enrichment-orchestration.helpers.ts:173-190`) with `title` and `seriesName` left all ~40 cases in `enrichment-orchestration.helpers.test.ts` green, because `dbWithUpdateChain`'s `selectRow` literal (`:44-75`) never carried those keys. Same latent shape in `src/server/jobs/enrichment.test.ts`, where a dozen-plus inline `existing` rows omit `subtitle` and `publisher` that `enrichment-writeback.ts:309-324` already projects.

**Rule.** When you widen a projection, (1) add the new key to the suite's shared row factory in the SAME change so the shape stays honest, and (2) write at least one case that populates it with a value whose effect is observable, then mutation-verify by reverting the read to its pre-widening source — e.g. `updates.subtitle ?? row.subtitle` back to `row.subtitle` must red the new case while the pre-existing ones stay green. A green suite after a projection widening proves nothing about the new read.

Distinct from [[new-books-column-breaks-inline-fixtures]]: that one is about a nullable SCHEMA column making `$inferSelect`-typed literals fail typecheck, which is loud. This one is silent precisely because the projection literal at the double is untyped. Same family as [[shared-test-double-defaults]] (a double's shape silently becoming production behaviour) and [[vacuous-assertion-observation-points]] (the observable cannot see the property under test).

## placeholderdata-scoped-to-query-key

**source:** #2530  
**added:** 2026-08-21  
**files:** src/client/pages/settings/ImportListExclusionsSettings.tsx  
**tags:** react-query, pagination, filters, loading-state

---

`placeholderData: (previousData) => previousData` is correct only while the query key varies by PAGE alone. The moment the key gains a filter dimension (a tab, a kind, a status), the same line hands the previously selected filter's rows, `total` and pagination to the newly selected filter for its whole pending window — and because the query then has data, the page's `isLoading` spinner branch never fires, so the ordinary loading state does not cover it.

TanStack Query v5 passes a second argument for exactly this: `placeholderData: (prev, prevQuery) => …`, where `prevQuery.queryKey` is the key `prev` was fetched under. Compare that key with the currently selected filter and return `undefined` when they differ — the query is then genuinely `pending`, the loading branch fires, and `total` falls back to `0`, which also clamps an out-of-range page to 1 through `usePagination.clampToTotal`. Live shape: `kindOfQueryKey(prevQuery?.queryKey) === kind ? prev : undefined` in `src/client/pages/settings/ImportListExclusionsSettings.tsx`.

**Do not derive the previous filter from the previous DATA.** `prev.data[0]?.kind` cannot answer for an empty page, which is precisely the case that would slip through. The key is the only total source.

**Two tests, or the fix is unpinned.** (1) The regression gate: hold the newly selected filter's request on a captured promise (never `vi.useFakeTimers()`), take the observation point from the held query's own state — `queryClient.getQueryState(key)?.status === 'pending'` — and pair the positive spinner assertion with NEGATIVE assertions that no previous-filter row title and no previous-filter `total` is in the document. The spinner assertion alone is satisfied at t=0 by the broken implementation ([[loading-assertion-vacuous-at-mount]]). (2) The counter-test: within one filter, hold page 2 and assert page 1's rows are still on screen. Without it, deleting `placeholderData` outright passes (1) while silently regressing page-to-page navigation. Both directions were measured on #2530: the unconditional form reds only (1); no placeholder at all reds only (2).

This refines the blanket advice in [[react-query-optimistic-cancel]] ("for paginated queries, set placeholderData: (prev) => prev to avoid flicker"), which predates any filtered list in this repository.

## undeclared-status-observable-in-openapi-not-body

**source:** #2527  
**added:** 2026-08-21  
**files:** src/server/routes/v1/actions.ts  
**tags:** fastify, zod, openapi, test-observability

---

Undeclaring a status in a v1 route's `response` map fails `pnpm typecheck` — `reply.status(409)` reports `TS2345: Argument of type '409' is not assignable to parameter of type '200 | 400 | 404'`, the narrowing described in [[zod-type-provider-send-union-narrowing]]. But that entry's 'Approach (2) also fail-closes error-body serialization' clause is a property, NOT a test observation point: where the route's other statuses already declare the same envelope schema, the serialized body is byte-identical with and without the declaration, so a case that parses the body against `v1ErrorEnvelopeSchema` stays green under the mutation.

Measured on #2527: removing the `409`/`504` entries from `src/server/routes/v1/actions.ts`'s search route left every case in `actions.test.ts` green (vite transpiles without typechecking) and red exactly two cases in `src/server/routes/v1/openapi.test.ts`, which reads `app.swagger().paths` and therefore sees the response map directly.

**Rule:** when an AC says 'this status must be declared', put the observation point in the OpenAPI suite (and lean on typecheck), not in a response-body parse. Keep the body-parse case, but scope its claim to what it can see — that the envelope is strict-clean and leaks no ids or URLs. The declaration only becomes body-observable on a status whose declared schema differs from every sibling's. An instance of [[vacuous-assertion-observation-points]].
