# Technical Debt

## Actionable

- ~~**`src/client/pages/settings/CredentialsSection.tsx` + `ImportListProviderSettings.tsx` + `SearchSettingsSection.tsx`**: inputClass duplication~~ — resolved in #409
- ~~**`src/server/jobs/search.ts`**: `startSearchJob()` dead code~~ — resolved in #409
- ~~**`src/server/services/indexer.service.ts`**: duplicate enabled indexer query~~ — resolved in #409
- ~~**`usePagination` clamp effect pattern across 3 files**~~ — resolved in #555 (destructured `clampToTotal` in all 3 files)
- ~~**`src/server/services/quality-gate.helpers.ts`**: `resolveBookQualityInputs(book)` called twice~~ — resolved in #555 (cached result)
- ~~**`src/client/pages/activity/DownloadActions.tsx`**: `PendingActionButtons` dead code~~ — resolved in #409
- ~~**`src/core/indexers/types.ts` / `src/client/lib/api/search.ts`**: `SearchResult` DRY-1~~ — resolved in #409
- ~~**`src/client/components/SearchReleasesModal.tsx`**: `handleGrab()` cherry-picks fields from SearchResult~~ — resolved in #412
- ~~**`src/server/services/library-scan.service.ts` / `src/shared/schemas/library-scan.ts` / `src/client/lib/api/library-scan.ts`**: `DiscoveredBook`/`duplicateReason` DRY-1~~ — resolved in #409

- ~~**`src/server/services/quality-gate-orchestrator.ts`**: `processOneDownload()` O(N) scan~~ — resolved in #413
- ~~**`src/core/indexers/types.ts` / `src/server/services/indexer.service.ts` / `src/client/lib/api/settings.ts`**: `IndexerTestResult` DRY-1~~ — resolved in #409

- ~~**`src/server/services/merge.service.ts`**: Deprecated `mergeBook()` method~~ — resolved in #556 (deleted method, migrated 57 tests to `enqueueMerge()`)

- ~~**`src/client/pages/activity/ActivityPage.tsx`**: Cyclomatic complexity at 17 (limit 15), suppressed with eslint-disable~~ — resolved in #470 (extracted DownloadsTabSection)

- **Merge phase enum in 4 locations**: `mergePhaseSchema` in `sse-events.ts` is the source of truth, but the phase union is also implicitly encoded in `merge.service.ts` (`emitMergeProgress` type annotation), `useMergeProgress.ts` (`phase: string` — untyped), and `merge.ts` (format switch cases). Renaming `finalizing` → `committing` required touching all 4. The `MergePhase` type is now exported from schemas — consumer files should import and use it instead of inline string unions. (discovered in #431)

- ~~**`collectAudioFiles()` wrappers in 4 places**: collectAudioFiles wrapper consolidation~~ — resolved in #409 (audio-scanner excluded per spec)

- ~~**`src/server/services/quality-gate-orchestrator.ts` at 501 lines (max 400)**~~ — resolved in #552 (extracted deferred-cleanup to helper)

- ~~**`src/server/services/search-pipeline.ts` at ~500 lines (max 400)**~~ — resolved in #552 (extracted canonicalCompare + ranking helpers to search-ranking.ts)

- ~~**`src/server/routes/search-stream.test.ts`**: Module-level `vi.mock('../services/search-pipeline.js')` prevents integration testing~~ — resolved in #563 (replaced with per-test `vi.spyOn`)

- ~~**`src/client/pages/library/LibraryBookCard.tsx`**: Uses same `opacity-0 group-hover:opacity-100` hover-gated pattern as BookHero overlay (lines 87, 119). Touch devices can't discover these actions. Should apply the `no-hover:opacity-100` variant added in #450 for consistency.~~ — resolved in #551

- ~~**`src/server/services/library-scan.service.ts` enrichImportedBook/processOneImport complexity**: Both methods report complexity 19/23 (limit 15)~~ — `processOneImport` removed in #635 (logic moved to ManualImportAdapter). `enrichImportedBook` complexity remains but is only called from `importSingleBook`.

- **`src/server/services/library-scan.service.test.ts` 26 skipped background processing tests**: Tests skipped with `describe.skip` in #635 after migrating confirmImport to job queue. The tested behavior now lives in ManualImportAdapter (covered by `manual.test.ts`), but the skipped tests should be deleted in a cleanup pass. (discovered in #635)

- ~~**`MAX_COVER_SIZE` duplicated in 3 files**~~ — resolved in #513

- **Cover MIME type surfaces still duplicated in 4 locations**: `src/client/pages/book/BookHero.tsx:187` (accept attribute), `src/client/pages/book/BookDetails.tsx:59` (inline array), `src/server/services/cover-download.ts:27` (contentType check), `src/server/utils/cover-cache.ts:70-72` (MIME→ext mapping). These consume MIME types but are UI constraints or separate serving logic — not consolidated in #513 which only extracted the canonical `SUPPORTED_COVER_MIMES` set. (discovered in #513)

- **Core layer has 30 `instanceof Error` ternaries**: `src/core/` adapters (indexers, download-clients, notifiers, import-lists, metadata, utils) still use raw `error instanceof Error ? error.message : fallback` instead of `getErrorMessage()`. Out of scope for #513 (core throws/returns, services catch). Warrants a follow-up issue. (discovered in #513)

- ~~**`src/server/services/refresh-scan.service.test.ts:329-341`**: double-call anti-pattern~~ — resolved in #563 (consolidated to `rejects.toMatchObject` + `rejects.not.toBeInstanceOf`)

- ~~**`src/server/jobs/index.ts:54` housekeeping callback lacks per-sub-task error isolation**~~ — resolved in #547 (per-sub-task try/catch with log.warn)

- ~~**`src/client/hooks/useBulkOperation.ts`, `src/client/components/settings/useFetchCategories.ts`, `src/client/pages/library/useLibraryBulkActions.ts`**: No co-located test files.~~ — all three now have co-located tests (useBulkOperation and useFetchCategories resolved earlier, useLibraryBulkActions resolved in #626)

- ~~**`BackupScheduleForm.tsx` still uses raw `useMutation`/`useQuery`/`useEffect` boilerplate**~~ — resolved in #564 (migrated to `useSettingsForm` with `zodResolver`)

- ~~**`src/client/lib/api/books.ts` / `src/core/metadata/schemas.ts`**: Client `BookMetadata` drift~~ — resolved in #559 (client type now derived from server schema via `src/core/metadata/types.ts`)

- ~~**`src/client/components/SearchReleasesModal.tsx` at 391 lines (max 400)**~~ — resolved in #553 (extracted SearchReleasesContent, SearchReleasesHeader, phase sub-components)

- ~~**`src/client/components/book/BookMetadataModal.tsx` at 357 lines (max 400)**~~ — resolved in #553 (extracted MetadataSearchView, MetadataEditFields)

- ~~**`BookMetadataModal` / `BookEditModal` search results rendering 90% duplicated**~~ — resolved in #627 (extracted MetadataResultItem + MetadataResultList shared components)

- ~~**`src/server/services/search-pipeline.ts` `filterAndRankResults` has 10 positional parameters**~~ — resolved in #522 (options bag with `SearchFilterOptions`)

- ~~**SABnzbd/NZBGet adapters lack byte-upload paths**~~ — resolved in #565 (added `nzb-bytes` multipart/base64 paths to SABnzbd, NZBGet, and Blackhole)

- ~~**`src/core/utils/download-url.test.ts` mockFetch call history accumulates across tests**~~ — resolved in #624 (added `mockFetch.mockClear()` to top-level `beforeEach`, removed redundant nested clear)

- ~~**`src/core/utils/download-url.ts:290` sanitizeNetworkError fallthrough leaks error.message**~~ — resolved in #541 (URL redaction via regex)

- ~~**`src/client/pages/discover/DiscoverPage.tsx:52` markAdded fire-and-forget has no error logging**~~ — resolved in #547 (console.warn on catch + error path tests)


- ~~**`src/core/utils/download-url.ts:65-66, 107-110` base32 normalization duplicated**~~ — resolved in #560 (extracted `normalizeInfoHash()` helper)

- ~~**`src/server/services/import-orchestrator.test.ts:23-28` mock CONTENT_FAILURE_PATTERNS is a silent copy**~~ — resolved in #541 (replaced with importOriginal passthrough)

- ~~**Discovery candidates use region-only language gate, not configured-languages array**~~ — resolved in #560 (replaced `regionLang` with `languages[]` array in CandidateContext)

- ~~**`src/server/services/import-orchestrator.ts:122-128` SSE status mismatch in drain path**~~ — resolved in #628 (changed `downloadStatus` from `'processing_queued'` to `'importing'`)

- ~~**No concurrent-drain test for import nudge**: resolved in #539 — concurrent drain contention test added to import-orchestrator.test.ts~~

- ~~**`src/server/services/import-orchestrator.ts:85` processCompletedDownloads doesn't nudge**~~ — resolved in #628 (added design comment explaining intentional cron-driven re-query)

- ~~**`src/client/pages/settings/QualitySettingsSection.tsx:65 vs 84` step attribute inconsistency**: `minSeeders` uses `step={1}` (number) while `maxDownloadSize` uses `step="1"` (string). Both render identically but mixing forms is inconsistent.~~ — resolved in #551

- ~~**`src/server/services/download.service.ts:271` logs raw passkey URL at debug level**~~ — **RESOLVED in #545**: `sanitizeLogUrl` now applied at all 3 log sites (download.service, search route, enrich-usenet-languages)

- ~~**`src/server/services/cover-download.ts:55,61,92` logs raw remote URLs**~~ — **RESOLVED in #622**: All 3 log sites now wrapped with `sanitizeLogUrl()`

- ~~**`src/core/download-clients/blackhole.ts:13` and `src/server/services/cover-download.ts:10` have private 30s timeout constants**~~ — **RESOLVED in #622**: Both replaced with shared `HTTP_DOWNLOAD_TIMEOUT_MS` from `src/core/utils/constants.ts`

- **`src/core/utils/download-url.ts:18` has private `DOWNLOAD_TIMEOUT_MS = 30_000`**: Same 30s timeout as the now-shared `HTTP_DOWNLOAD_TIMEOUT_MS` in `constants.ts`. Intentionally left out of scope in #622 per spec boundary — could be migrated in a future cleanup pass. (discovered in #622)

- **`processing_queued` download status may be vestigial**: After #636, `processing_queued` is still set by `enqueueAutoImport()` but the window between queue insertion and worker pickup is very short (serial queue, immediate nudge). The status exists mainly for UI display. If the queue grows large or the worker is slow, it's useful; for typical single-download flows it's a no-op transition. Consider removing it if the UI moves to job-based status tracking (#637). (discovered in #636)

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
- ~~**`tsconfig.json`**: Missing `vite/client` type reference~~ — resolved in #559 (`src/client/env.d.ts` created)
- ~~**`src/client/lib/api/books.ts`**: Client `MetadataSearchResults` and `AuthorMetadata` interfaces hand-maintained separately from server schemas~~ — resolved in #594 (re-exported from `src/core/metadata/types.ts`)

- **`src/client/pages/settings/index.ts` barrel still re-exports individual settings page components unnecessarily**: Before #550, the barrel exported all 10 settings sub-pages + registry. #550 trimmed it to just `SettingsLayout`, but if future code imports individual settings components from the barrel, it will re-add the coupling. No consumer currently needs this. (discovered in #550)
- **`btnSecondary` class string duplicated in `ImportListCard.tsx` and `ImportListProviderSettings.tsx`**: Same Tailwind class string defined in both files. Minor DRY-2 — extract to `formStyles.ts` alongside existing `compactInputClass`. (discovered in #607)
- **19 remaining `type="number"` inputs missing `step` attribute**: Across BackupScheduleForm, GeneralSettingsForm, SearchSettingsSection, ImportListsSettings, ProcessingSettingsSection, DiscoverySettingsSection, ImportSettingsSection, notifier-fields, abb-fields, and DownloadClientFields (priority). Full list in #583 out-of-scope section. Consider adding `step` to the shared `FormField` component's number input path instead of per-site. (discovered in #583)
- **`src/server/__tests__/e2e-helpers.ts` — orphan `.db` files in `os.tmpdir()`**: `cleanup()` uses per-file `unlink()` calls wrapped in a try/catch; when a test process exits without calling `cleanup()` (crash, Ctrl+C, timeout), the `narratorr-e2e-*.db` files and their `-wal` / `-shm` sidecars are left behind. Observed accumulation of such files in tmpdir dating back to April 9. New Playwright harness avoids this by creating a containing *directory* per run and `rm -rf`ing it; the vitest helper could adopt the same pattern — or register a process-exit handler — to ensure cleanup survives abnormal termination. (discovered in #612)

- **`src/server/config.ts` `LIBRARY_PATH` / `config.libraryPath` is decorative**: declared in Zod schema and exposed on `config`, but no runtime code reads it — `settings.library.path` (DB row) is the only source of truth for imports, scans, folder moves. Setting the env var does nothing; new installs must configure the path via Settings UI. Either wire it into first-boot settings provisioning (so the env becomes a true bootstrap default) or delete the declaration to stop the false affordance. E2E harness had to seed the `library` settings row directly because of this gap. (discovered in #614)

- **`src/server/utils/paths.ts` and `src/server/services/quality-gate-deferred-cleanup.helpers.ts` lack co-located test files**: Both contain error-handling logic (rename rollback, settings read failure) with no dedicated tests. Changes are covered indirectly by parent service tests but direct coverage would catch regressions in edge case behavior. (discovered in #621)

- ~~**Pino logging of `catch (error: unknown)` yields `"error":{}` by default**: `handleImportFailure` and a handful of other `log.error({ error }, ...)` sites serialize `unknown` errors to empty objects, making production log triage effectively impossible without a code change. A shared `serializeError(err)` helper returning `{ message, stack, type, cause? }` — paired with a lint rule banning raw `{ error }` in `log.error` payloads where error is `unknown` — would fix the class of issue at once.~~ — resolved in #621 (serializeError helper + ESLint rule + 100-site migration)

- **`src/core/utils/language-codes.ts` — `normalizeLanguage()` doesn't handle MAM's numeric codes**: MAM returns `lang_code: '1'` for English (and similar bare numerics for other languages); `normalizeLanguage` only consults `ISO_639_TO_NAME` and `KNOWN_NAMES`, so numerics pass through unchanged and get silently filtered out by the default `metadataSettings.languages: ['english']` check — user sees 0 results despite valid MAM matches. Either add a MAM-specific numeric map or document the need to override `searchLanguages` per-indexer. (discovered in #614 — confirmed by having to coerce `langCode: 'en'` in the E2E fake to avoid this trap)
