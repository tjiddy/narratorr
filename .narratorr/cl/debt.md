# Technical Debt

## Actionable

- ~~**`src/client/pages/settings/CredentialsSection.tsx` + `ImportListProviderSettings.tsx` + `SearchSettingsSection.tsx`**: inputClass duplication~~ — resolved in #409
- ~~**`src/server/jobs/search.ts`**: `startSearchJob()` dead code~~ — resolved in #409
- ~~**`src/server/services/indexer.service.ts`**: duplicate enabled indexer query~~ — resolved in #409
- **`usePagination` clamp effect pattern across 3 files**: `BlacklistSettings.tsx:45-47`, `EventHistorySection.tsx:47-50`, `LibraryPage.tsx:56-59` all use the full pagination object in `useEffect` deps, causing the effect to fire on every render. Fixed in `ActivityPage` (#414) by destructuring `clampToTotal` — same pattern should be applied to these 3 files. (discovered in #414)
- **`src/server/services/quality-gate.helpers.ts`**: `resolveBookQualityInputs(book)` is called twice in `buildQualityAssessment()` — once at line 40 for MB/hr + existing metadata, again at line 79 for duration delta. Could reuse the first result. Pure function so no side effects, just minor waste. (discovered in #300)
- ~~**`src/client/pages/activity/DownloadActions.tsx`**: `PendingActionButtons` dead code~~ — resolved in #409
- ~~**`src/core/indexers/types.ts` / `src/client/lib/api/search.ts`**: `SearchResult` DRY-1~~ — resolved in #409
- ~~**`src/client/components/SearchReleasesModal.tsx`**: `handleGrab()` cherry-picks fields from SearchResult~~ — resolved in #412
- ~~**`src/server/services/library-scan.service.ts` / `src/shared/schemas/library-scan.ts` / `src/client/lib/api/library-scan.ts`**: `DiscoveredBook`/`duplicateReason` DRY-1~~ — resolved in #409

- ~~**`src/server/services/quality-gate-orchestrator.ts`**: `processOneDownload()` O(N) scan~~ — resolved in #413
- ~~**`src/core/indexers/types.ts` / `src/server/services/indexer.service.ts` / `src/client/lib/api/settings.ts`**: `IndexerTestResult` DRY-1~~ — resolved in #409

- **`src/server/services/merge.service.ts`**: Deprecated `mergeBook()` method (lines 222-270) duplicates validation and execution logic from `validatePreEnqueue()` + `executeMerge()`. Kept for backward compatibility with 40+ existing tests that test the synchronous merge path. Should be removed once existing tests are migrated to test via `enqueueMerge()`. (discovered in #368)

- ~~**`src/client/pages/activity/ActivityPage.tsx`**: Cyclomatic complexity at 17 (limit 15), suppressed with eslint-disable~~ — resolved in #470 (extracted DownloadsTabSection)

- **Merge phase enum in 4 locations**: `mergePhaseSchema` in `sse-events.ts` is the source of truth, but the phase union is also implicitly encoded in `merge.service.ts` (`emitMergeProgress` type annotation), `useMergeProgress.ts` (`phase: string` — untyped), and `merge.ts` (format switch cases). Renaming `finalizing` → `committing` required touching all 4. The `MergePhase` type is now exported from schemas — consumer files should import and use it instead of inline string unions. (discovered in #431)

- ~~**`collectAudioFiles()` wrappers in 4 places**: collectAudioFiles wrapper consolidation~~ — resolved in #409 (audio-scanner excluded per spec)

- **`src/server/services/quality-gate-orchestrator.ts` at 501 lines (max 400)**: File exceeds ESLint max-lines rule and any net addition triggers a "new violation" in verify.ts diff-based linting. Needs to be split — e.g., extract deferred-cleanup logic or SSE emission into a separate module. (discovered in #434)

- **`src/server/services/search-pipeline.ts` at ~500 lines (max 400)**: File exceeds ESLint max-lines soft limit. Contains `canonicalCompare`, `filterAndRankResults`, and multiple helper functions. `parseWordList` extracted in #513. Consider extracting `canonicalCompare` and its tier helpers into a separate `search-ranking.ts` module. (discovered in #469, grew in #502)

- **`src/server/routes/search-stream.test.ts`**: Module-level `vi.mock('../services/search-pipeline.js')` prevents integration testing of `postProcessSearchResults` in the same file. New integration tests had to go in a separate file (`search-stream-filtering.test.ts`). Consider refactoring the existing tests to use per-test mocking or moving the mocked tests to a separate file so the main test file can run unmocked. (discovered in #438)

- ~~**`src/client/pages/library/LibraryBookCard.tsx`**: Uses same `opacity-0 group-hover:opacity-100` hover-gated pattern as BookHero overlay (lines 87, 119). Touch devices can't discover these actions. Should apply the `no-hover:opacity-100` variant added in #450 for consistency.~~ — resolved in #551

- **`src/server/services/library-scan.service.ts` enrichImportedBook/processOneImport complexity**: Both methods report complexity 19/23 (limit 15) due to nullable field coalescing (`??`, `||`) in event payloads and enrichment configs. Extracting the enrichment orchestration didn't reduce complexity because the operators are in the remaining caller code. Could extract event payload builders as standalone functions to bring methods under threshold. (discovered in #470)

- ~~**`MAX_COVER_SIZE` duplicated in 3 files**~~ — resolved in #513

- **Cover MIME type surfaces still duplicated in 4 locations**: `src/client/pages/book/BookHero.tsx:187` (accept attribute), `src/client/pages/book/BookDetails.tsx:59` (inline array), `src/server/services/cover-download.ts:27` (contentType check), `src/server/utils/cover-cache.ts:70-72` (MIME→ext mapping). These consume MIME types but are UI constraints or separate serving logic — not consolidated in #513 which only extracted the canonical `SUPPORTED_COVER_MIMES` set. (discovered in #513)

- **Core layer has 30 `instanceof Error` ternaries**: `src/core/` adapters (indexers, download-clients, notifiers, import-lists, metadata, utils) still use raw `error instanceof Error ? error.message : fallback` instead of `getErrorMessage()`. Out of scope for #513 (core throws/returns, services catch). Warrants a follow-up issue. (discovered in #513)

- **`src/server/services/refresh-scan.service.test.ts:329-341`**: `rethrows non-ENOENT stat errors` test still uses the same double-call anti-pattern (rejects.toThrow + try/catch). Was out of scope for #468 which only targeted RefreshScanError-coded tests, but should be consolidated to match. (discovered in #468)

- ~~**`src/server/jobs/index.ts:54` housekeeping callback lacks per-sub-task error isolation**~~ — resolved in #547 (per-sub-task try/catch with log.warn)

- **`src/client/hooks/useBulkOperation.ts`, `src/client/components/settings/useFetchCategories.ts`, `src/client/pages/library/useLibraryBulkActions.ts`**: No co-located test files. These hooks contain error handling and polling logic that could regress silently. (discovered in #486)

- **`BackupScheduleForm.tsx` still uses raw `useMutation`/`useQuery`/`useEffect` boilerplate**: Excluded from `useSettingsForm` migration (#485) because it has no zodResolver, no `!isDirty` guard, and no reset-on-success. A separate `useSettingsForm` variant or standalone refactor could normalize this. (discovered in #485)

- **`src/client/lib/api/books.ts` / `src/core/metadata/schemas.ts`**: Client `BookMetadata` interface is hand-maintained separately from server `BookMetadataSchema`. Fields drift — `language` and `publishedDate` existed server-side but were missing client-side until #497. Should derive client type from the Zod schema or generate it. (discovered in #497)

- **`src/client/components/SearchReleasesModal.tsx` at 391 lines (max 400)**: File is near ESLint max-lines soft limit and already has `eslint-disable max-lines-per-function` at line 108. Any net additions (new state, new UI sections) will trigger the violation. Consider extracting the results list or grab/replace logic into sub-components. (discovered in #484)

- **`src/client/components/book/BookMetadataModal.tsx` at 357 lines (max 400)**: Same situation — already has `eslint-disable max-lines-per-function` at line 18. The search integration (view toggle, search results, apply metadata) could be extracted into a separate component. (discovered in #484)

- ~~**`src/server/services/search-pipeline.ts` `filterAndRankResults` has 10 positional parameters**~~ — resolved in #522 (options bag with `SearchFilterOptions`)

- **SABnzbd/NZBGet adapters lack byte-upload paths**: Both usenet adapters only support URL submission (`mode=addurl` / RPC `append` with URL string). `nzb-bytes` artifact variant was scoped out of #527. SABnzbd supports `mode=addlocalfile` / multipart upload, NZBGet supports base64 content in `append` params[1]. Adding this would allow the resolver to fetch NZB bytes and upload directly, removing dependency on the indexer URL remaining accessible after resolution. (discovered in #527)

- ~~**`src/core/utils/download-url.ts:290` sanitizeNetworkError fallthrough leaks error.message**~~ — resolved in #541 (URL redaction via regex)

- ~~**`src/client/pages/discover/DiscoverPage.tsx:52` markAdded fire-and-forget has no error logging**~~ — resolved in #547 (console.warn on catch + error path tests)


- **`src/core/utils/download-url.ts:65-66, 107-110` base32 normalization duplicated**: `infoHash.length === 32 ? base32ToHex(infoHash).toLowerCase() : infoHash.toLowerCase()` appears in both `resolveMagnet()` and `handleRedirect()`. Extract a `normalizeInfoHash(hash)` helper. (discovered in Archer session review of #527)

- ~~**`src/server/services/import-orchestrator.test.ts:23-28` mock CONTENT_FAILURE_PATTERNS is a silent copy**~~ — resolved in #541 (replaced with importOriginal passthrough)

- **Discovery candidates use region-only language gate, not configured-languages array**: `discovery-candidates.ts:182` checks `book.language.toLowerCase() !== ctx.regionLang` (single region-derived language), while search/author filtering uses the full `metadata.languages` array. A user with `languages: ['english', 'french']` but `audibleRegion: 'us'` will have French books filtered out of discovery but not search. Undocumented inconsistency. (discovered in Archer session review of #523)

- **`src/server/services/import-orchestrator.ts:122-128` SSE status mismatch in drain path**: `drainQueuedImports` emits `emitDownloadImporting` with `downloadStatus: 'processing_queued'` while the DB row is already `importing` (set by `claimQueuedDownload`). SSE consumers that display the payload status would briefly show the wrong state. (discovered in Archer session review of #525)

- ~~**No concurrent-drain test for import nudge**: resolved in #539 — concurrent drain contention test added to import-orchestrator.test.ts~~

- **`src/server/services/import-orchestrator.ts:85` processCompletedDownloads doesn't nudge**: The cron batch path releases slots but does not call `drainQueuedImports`. Intentional (cron re-queries immediately), but undocumented — a future reader might add nudge without understanding the design. Add a comment. (discovered in Archer session review of #525)

- ~~**`src/client/pages/settings/QualitySettingsSection.tsx:65 vs 84` step attribute inconsistency**: `minSeeders` uses `step={1}` (number) while `maxDownloadSize` uses `step="1"` (string). Both render identically but mixing forms is inconsistent.~~ — resolved in #551

- ~~**`src/server/services/download.service.ts:271` logs raw passkey URL at debug level**~~ — **RESOLVED in #545**: `sanitizeLogUrl` now applied at all 3 log sites (download.service, search route, enrich-usenet-languages)

- **`src/server/services/cover-download.ts:55,61,92` logs raw remote URLs**: Cover download service logs `url: remoteUrl` unsanitized in warn/debug calls. Cover URLs are unlikely to contain indexer credentials but pattern is inconsistent with the sanitized grab/search paths. (discovered in #545)

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
- **`src/core/utils/audio-processor.ts:108-123`**: `processAudioFiles()` has a broad catch block that wraps ffmpeg errors, file I/O errors, chapter-source reading errors, and temp-file operations under one `{ success: false, error: message }` return. This prevents downstream code from distinguishing content-caused failures (bad media) from environment failures (broken tooling). Adding structured error types (e.g., `ProcessingErrorKind: 'media' | 'tooling' | 'io'`) would enable more precise blacklist classification in import-orchestrator. (discovered in #504)
- **`tsconfig.json`**: Missing `vite/client` type reference — `import.meta.env` is untyped in client code, forcing workarounds like `process.env.NODE_ENV`. Add `"vite/client"` to `types` array or create a `src/client/env.d.ts` with `/// <reference types="vite/client" />` (discovered in #416)

- **`src/client/pages/settings/index.ts` barrel still re-exports individual settings page components unnecessarily**: Before #550, the barrel exported all 10 settings sub-pages + registry. #550 trimmed it to just `SettingsLayout`, but if future code imports individual settings components from the barrel, it will re-add the coupling. No consumer currently needs this. (discovered in #550)
