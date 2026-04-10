# Technical Debt

## Actionable

- ~~**`src/client/pages/settings/CredentialsSection.tsx` + `ImportListProviderSettings.tsx` + `SearchSettingsSection.tsx`**: inputClass duplication~~ — resolved in #409
- ~~**`src/server/jobs/search.ts`**: `startSearchJob()` dead code~~ — resolved in #409
- ~~**`src/server/services/indexer.service.ts`**: duplicate enabled indexer query~~ — resolved in #409
- **`usePagination` clamp effect pattern across 3 files**: `BlacklistSettings.tsx:45-47`, `EventHistorySection.tsx:47-50`, `LibraryPage.tsx:56-59` all use the full pagination object in `useEffect` deps, causing the effect to fire on every render. Fixed in `ActivityPage` (#414) by destructuring `clampToTotal` — same pattern should be applied to these 3 files. (discovered in #414)
- **`src/server/services/quality-gate.helpers.ts`**: `resolveBookQualityInputs(book)` is called twice in `buildQualityAssessment()` — once at line 40 for MB/hr + existing metadata, again at line 79 for duration delta. Could reuse the first result. Pure function so no side effects, just minor waste. (discovered in #300)
- ~~**`src/client/pages/activity/DownloadActions.tsx`**: `PendingActionButtons` dead code~~ — resolved in #409
- ~~**`src/core/indexers/types.ts` / `src/client/lib/api/search.ts`**: `SearchResult` DRY-1~~ — resolved in #409
- **`src/client/components/SearchReleasesModal.tsx`**: `handleGrab()` cherry-picks fields from SearchResult instead of spreading. Every new SearchResult field requires a manual addition to both the mutation call AND `PendingGrabParams`. Fragile — consider spreading `result` and letting the API schema filter. (discovered in #348)
- ~~**`src/server/services/library-scan.service.ts` / `src/shared/schemas/library-scan.ts` / `src/client/lib/api/library-scan.ts`**: `DiscoveredBook`/`duplicateReason` DRY-1~~ — resolved in #409

- ~~**`src/server/services/quality-gate-orchestrator.ts`**: `processOneDownload()` O(N) scan~~ — resolved in #413
- ~~**`src/core/indexers/types.ts` / `src/server/services/indexer.service.ts` / `src/client/lib/api/settings.ts`**: `IndexerTestResult` DRY-1~~ — resolved in #409

- **`src/server/services/merge.service.ts`**: Deprecated `mergeBook()` method (lines 222-270) duplicates validation and execution logic from `validatePreEnqueue()` + `executeMerge()`. Kept for backward compatibility with 40+ existing tests that test the synchronous merge path. Should be removed once existing tests are migrated to test via `enqueueMerge()`. (discovered in #368)

- **`src/client/pages/activity/ActivityPage.tsx`**: Cyclomatic complexity at 17 (limit 15), suppressed with eslint-disable. Adding merge cards pushed it over. The page handles downloads tab, events tab, search cards, merge cards, and pagination for two sections. Consider extracting the downloads tab content into a sub-component. (discovered in #422)

- **Merge phase enum in 4 locations**: `mergePhaseSchema` in `sse-events.ts` is the source of truth, but the phase union is also implicitly encoded in `merge.service.ts` (`emitMergeProgress` type annotation), `useMergeProgress.ts` (`phase: string` — untyped), and `merge.ts` (format switch cases). Renaming `finalizing` → `committing` required touching all 4. The `MergePhase` type is now exported from schemas — consumer files should import and use it instead of inline string unions. (discovered in #431)

- ~~**`collectAudioFiles()` wrappers in 4 places**: collectAudioFiles wrapper consolidation~~ — resolved in #409 (audio-scanner excluded per spec)

- **`src/server/services/quality-gate-orchestrator.ts` at 501 lines (max 400)**: File exceeds ESLint max-lines rule and any net addition triggers a "new violation" in verify.ts diff-based linting. Needs to be split — e.g., extract deferred-cleanup logic or SSE emission into a separate module. (discovered in #434)

- **`src/server/routes/search-stream.test.ts`**: Module-level `vi.mock('../services/search-pipeline.js')` prevents integration testing of `postProcessSearchResults` in the same file. New integration tests had to go in a separate file (`search-stream-filtering.test.ts`). Consider refactoring the existing tests to use per-test mocking or moving the mocked tests to a separate file so the main test file can run unmocked. (discovered in #438)

- **`src/client/pages/library/LibraryBookCard.tsx`**: Uses same `opacity-0 group-hover:opacity-100` hover-gated pattern as BookHero overlay (lines 87, 119). Touch devices can't discover these actions. Should apply the `no-hover:opacity-100` variant added in #450 for consistency. (discovered in #450)

## Accepted Debt

Items below are real but not worth fixing — the cost of change outweighs the benefit.

- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Workaround (explicit form schemas with `as` casts) is in place and stable. A type-preserving generic would fight Zod v4's type system for marginal benefit (discovered in #215)
- **`src/shared/schemas/settings/processing.ts`**: Shared `processingFormSchema` still uses `z.preprocess(nanToUndefined, ...)`. Not blocking — used by registry for server-side validation, not zodResolver. Changing it gains nothing (discovered in #219)
- **`src/client/pages/settings/ImportListProviderSettings.tsx`**: No co-located test file. Provider-specific settings are covered indirectly via the parent `ImportListsSettingsSection.test.tsx`. Adding a dedicated test would duplicate assertions (discovered in #216)
- **`src/client/pages/manual-import/PathStep.tsx`**: No co-located test file. Already covered indirectly via ManualImportPage.test.tsx (discovered in #224)
- **`src/core/utils/audio-processor.ts`**: `convertFiles()` injects `trackNumber`, `trackTotal`, `partName` unconditionally — single-file inputs get `trackNumber: 1, trackTotal: 1`. The metadata is accurate (there IS one track), and suffixes only appear in intermediate filenames during processing, not final output (discovered in #231)
- **`useManualImport.ts` / `useLibraryImport.ts`**: Confidence upgrade logic (none→medium, medium→high) is duplicated in both hooks' `handleEdit` callbacks. A shared `upgradeConfidence(confidence, hasMetadata)` utility would prevent drift if rules change. Minor DRY-2. (discovered in #335)
- **`src/client/components/settings/indexer-fields/mam-fields.tsx`**: `DetectionOverlay` was converted from fixed viewport overlay to inline relative positioning (#353). The visual appearance changed (no longer dims the full viewport). If a full-viewport detection UX is desired in non-modal contexts, this would need to be re-added conditionally. (discovered in #353)
- ~~**`src/server/services/indexer.service.ts`**: language injection duplication between searchAll/searchAllStreaming~~ — resolved in #409 (shared getEnabledIndexerRows)
- **`tsconfig.json`**: Missing `vite/client` type reference — `import.meta.env` is untyped in client code, forcing workarounds like `process.env.NODE_ENV`. Add `"vite/client"` to `types` array or create a `src/client/env.d.ts` with `/// <reference types="vite/client" />` (discovered in #416)
