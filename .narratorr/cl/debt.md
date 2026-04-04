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

## Accepted Debt

Items below are real but not worth fixing — the cost of change outweighs the benefit.

- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Workaround (explicit form schemas with `as` casts) is in place and stable. A type-preserving generic would fight Zod v4's type system for marginal benefit (discovered in #215)
- **`src/shared/schemas/settings/processing.ts`**: Shared `processingFormSchema` still uses `z.preprocess(nanToUndefined, ...)`. Not blocking — used by registry for server-side validation, not zodResolver. Changing it gains nothing (discovered in #219)
- **`src/client/pages/settings/ImportListProviderSettings.tsx`**: No co-located test file. Provider-specific settings are covered indirectly via the parent `ImportListsSettingsSection.test.tsx`. Adding a dedicated test would duplicate assertions (discovered in #216)
- **`src/client/pages/manual-import/PathStep.tsx`**: No co-located test file. Already covered indirectly via ManualImportPage.test.tsx (discovered in #224)
- **`src/core/utils/audio-processor.ts`**: `convertFiles()` injects `trackNumber`, `trackTotal`, `partName` unconditionally — single-file inputs get `trackNumber: 1, trackTotal: 1`. The metadata is accurate (there IS one track), and suffixes only appear in intermediate filenames during processing, not final output (discovered in #231)
- **`useManualImport.ts` / `useLibraryImport.ts`**: Confidence upgrade logic (none→medium, medium→high) is duplicated in both hooks' `handleEdit` callbacks. A shared `upgradeConfidence(confidence, hasMetadata)` utility would prevent drift if rules change. Minor DRY-2. (discovered in #335)
