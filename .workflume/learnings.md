## sse-inject-helper-gap

**source:** #755
**added:** 2026-05-04
**tags:** testing, sse, fastify, e2e, test-harness

---

Fastify's `app.inject()` cannot exercise SSE/streaming routes because Fastify hijacks the response on those handlers — the injection API never sees the streamed body. When migrating E2E tests from a non-streaming endpoint to an SSE replacement, the available workarounds are (a) call the underlying service method directly (preserves MSW/mocking assertions but bypasses the route handler) or (b) bind a real ephemeral port and parse the SSE event stream from a real HTTP client.

Observed in `src/server/__tests__/e2e-helpers.ts` during the #755 migration: three tests originally hit `GET /api/search?q=...` via `app.inject()` and were ported to call `e2e.services.indexer.searchAll()` directly against `/api/search/stream`. The route-layer coverage was lost as a tradeoff. See the explanatory comment at `src/server/__tests__/search-stream.test.ts:417`.

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
