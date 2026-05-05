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
