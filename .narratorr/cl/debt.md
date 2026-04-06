# Technical Debt

## Actionable

- **`src/client/pages/settings/CredentialsSection.tsx` + `ImportListProviderSettings.tsx`**: Still define local `inputClass` constants identical to shared `formStyles.ts`. Could import from shared location for full dedup (discovered in #289)
- **`src/server/services/blacklist.service.ts`**: `isBlacklisted(infoHash)` method still only checks `infoHash`, not `guid`. If usenet-only blacklisted entries exist (guid-only, no infoHash), `isBlacklisted()` won't find them. Low priority — only called from quality gate pre-check, not from reject flow (discovered in #248)
- **`src/server/services/search-pipeline.ts`**: `searchAndGrabForBook()` still has no blacklist filtering — only `retrySearch()` filters. Scheduled search and manual search can re-grab blacklisted releases. Spec explicitly deferred this as out-of-scope (discovered in #248)

- **`src/server/services/indexer.service.ts`**: `searchAllStreaming()` and `searchAll()` both query enabled indexers from the DB independently. Could share a common `getEnabledIndexerRows()` that returns full rows, with `getEnabledIndexers()` projecting just id+name. Minor DRY issue. (discovered in #298)
- **`src/client/pages/activity/ActivityPage.test.tsx`**: "queue page clamps to last valid page" test is flaky — fails intermittently in CI. Likely a timing issue with pagination state updates. (discovered in #298)
- **`src/server/services/quality-gate.helpers.ts`**: `resolveBookQualityInputs(book)` is called twice in `buildQualityAssessment()` — once at line 40 for MB/hr + existing metadata, again at line 79 for duration delta. Could reuse the first result. Pure function so no side effects, just minor waste. (discovered in #300)
- **`src/client/pages/activity/DownloadActions.tsx`**: `PendingActionButtons` component inside DownloadActions still renders for `pending_review` status (line 78), but the parent `DownloadCard` hides `DownloadActions` entirely for pending_review cards (line 253). Dead code branch that can never execute. (discovered in #306)
- **`src/core/indexers/types.ts` / `src/client/lib/api/search.ts`**: `SearchResult` is duplicated across core and client — DRY-1 parallel types that must be kept in sync manually. A shared types package or generated types would prevent drift. (discovered in #317)
- **`src/core/indexers/abb.ts`**: ABB adapter does not populate `guid` in search results (lines 174-182), same bug as MAM had. ABB downloads are un-blacklistable. Separate fix from #348. (discovered in #348)
- **`src/client/components/SearchReleasesModal.tsx`**: `handleGrab()` cherry-picks fields from SearchResult instead of spreading. Every new SearchResult field requires a manual addition to both the mutation call AND `PendingGrabParams`. Fragile — consider spreading `result` and letting the API schema filter. (discovered in #348)
- **`src/server/services/library-scan.service.ts` / `src/shared/schemas/library-scan.ts` / `src/client/lib/api/library-scan.ts`**: `DiscoveredBook` type and `duplicateReason` union defined in 3 places that must be kept in sync manually. DRY-1 — the shared schema should be the single source of truth with types derived via `z.infer`. (discovered in #342)

- **`src/server/services/quality-gate-orchestrator.ts`**: `processOneDownload()` calls `getCompletedDownloads()` (loads ALL completed downloads) and then `.find()` by ID. Should have a dedicated `getCompletedDownloadById(id)` query in `QualityGateService` for O(1) lookup instead of O(N) scan. Low priority — completed download count is typically small. (discovered in #358)
- **`src/core/indexers/types.ts` / `src/server/services/indexer.service.ts` / `src/client/lib/api/settings.ts`**: `test()` return type (including `warning`) is defined as inline types in 3 places — adapter interface, service methods, and client TestResult. Adding a new field requires updating all 3. Extract a shared `TestResult` type from the adapter interface and reuse it in service and client. DRY-1 parallel types. (discovered in #372)

## Accepted Debt

Items below are real but not worth fixing — the cost of change outweighs the benefit.

- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Workaround (explicit form schemas with `as` casts) is in place and stable. A type-preserving generic would fight Zod v4's type system for marginal benefit (discovered in #215)
- **`src/shared/schemas/settings/processing.ts`**: Shared `processingFormSchema` still uses `z.preprocess(nanToUndefined, ...)`. Not blocking — used by registry for server-side validation, not zodResolver. Changing it gains nothing (discovered in #219)
- **`src/client/pages/settings/ImportListProviderSettings.tsx`**: No co-located test file. Provider-specific settings are covered indirectly via the parent `ImportListsSettingsSection.test.tsx`. Adding a dedicated test would duplicate assertions (discovered in #216)
- **`src/client/pages/manual-import/PathStep.tsx`**: No co-located test file. Already covered indirectly via ManualImportPage.test.tsx (discovered in #224)
- **`src/core/utils/audio-processor.ts`**: `convertFiles()` injects `trackNumber`, `trackTotal`, `partName` unconditionally — single-file inputs get `trackNumber: 1, trackTotal: 1`. The metadata is accurate (there IS one track), and suffixes only appear in intermediate filenames during processing, not final output (discovered in #231)
- **`useManualImport.ts` / `useLibraryImport.ts`**: Confidence upgrade logic (none→medium, medium→high) is duplicated in both hooks' `handleEdit` callbacks. A shared `upgradeConfidence(confidence, hasMetadata)` utility would prevent drift if rules change. Minor DRY-2. (discovered in #335)
- **`src/client/components/settings/IndexerFields.tsx`**: `DetectionOverlay` was converted from fixed viewport overlay to inline relative positioning (#353). The visual appearance changed (no longer dims the full viewport). If a full-viewport detection UX is desired in non-modal contexts, this would need to be re-added conditionally. (discovered in #353)
