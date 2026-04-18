# Technical Debt

## Actionable

### New from recent merges

- **`src/server/services/import-adapters/auto.ts` — AutoImportAdapter has no phase/progress instrumentation**: `process()` only sets `analyzing` phase, then delegates to `ImportOrchestrator.importDownload()` which runs the full copy/process/rename/verify pipeline internally with no import-job phase hooks or progress callbacks. Users see auto-import jobs stuck on "analyzing" in the `ImportActivityCard`. Needs the same treatment as `ManualImportAdapter` (per-phase setPhase calls + progress callbacks through the pipeline). (discovered in #637)

- **`src/shared/schemas/settings/processing.ts` — `processing.enabled` is now inert**: After #649 removed `runAudioProcessing()` from the import path, no production code reads `processing.enabled`. Merge gates on `ffmpegPath`, Bulk gates on `ffmpegPath`, tagging gates on `tagging.enabled` + `ffmpegPath`. The setting persists in the schema and UI toggle but has no runtime effect. Could be removed from schema and UI in a future cleanup. (discovered in #649)

### Promoted from Accepted Debt (2026-04-18 re-audit)

- **User-facing bug: MAM numeric language codes silently filter results to zero**: `src/core/utils/language-codes.ts` — `normalizeLanguage()` doesn't handle MAM's numeric codes. MAM returns `lang_code: '1'` for English (and similar bare numerics for other languages); `normalizeLanguage` only consults `ISO_639_TO_NAME` and `KNOWN_NAMES`, so numerics pass through unchanged and get silently filtered out by the default `metadataSettings.languages: ['english']` check — user sees 0 results despite valid MAM matches. Either add a MAM-specific numeric map or document the need to override `searchLanguages` per-indexer. (discovered in #614 — confirmed by having to coerce `langCode: 'en'` in the E2E fake to avoid this trap. Re-classified 2026-04-18: silent data-loss bug should not live in "accepted".)

- **`src/client/pages/settings/ImportListProviderSettings.tsx` has no actual coverage**: Claimed to be "covered indirectly via `ImportListsSettingsSection.test.tsx`," but grep of the parent test file shows zero references to `ImportListProviderSettings`, `ProviderSettings`, or `providerSettings`. The file contains `AbsSettings` with real async logic (`handleFetchLibraries`, error states, loading states) that is not exercised by any test. Needs a co-located test file. (originally #216, re-classified 2026-04-18 after indirect-coverage claim verified false)

- **`src/server/utils/paths.ts` + `src/server/services/quality-gate-deferred-cleanup.helpers.ts` lack co-located tests**: Both contain error-handling logic (rename rollback with per-file undo, settings read failure on deferred cleanup) that deserves direct unit coverage. Indirect coverage via parent service tests exercises the happy path but not the rollback edge cases. (discovered in #621, re-classified 2026-04-18 — error-path logic warrants direct tests.)

- **`useManualImport.ts` / `useLibraryImport.ts` confidence upgrade duplication**: `upgradeConfidence(confidence, hasMetadata)` logic (none→medium, medium→high) is duplicated verbatim in both hooks' `handleEdit` callbacks. Extract to a shared util (~10 lines of actual logic). Risk of drift if confidence rules change. (discovered in #335, re-classified 2026-04-18 — trivial extraction shouldn't sit in accepted.)

- **`src/server/__tests__/e2e-helpers.ts` leaks `.db` files on abnormal exit**: `cleanup()` uses per-file `unlink()` wrapped in try/catch; a crash or Ctrl+C leaves `narratorr-e2e-*.db` + their `-wal`/`-shm` sidecars in `os.tmpdir()`. Observed accumulation dating back to April 9. Playwright harness already solved this by creating a containing *directory* per run and `rm -rf`ing it. The vitest helper should adopt the same pattern (or register a process-exit handler). (discovered in #612, re-classified 2026-04-18 — this is a queued cleanup, not "accepted forever".)

### Existing actionable

- **Core layer has 11 `instanceof Error` ternaries**: `src/core/` adapters still use raw `error instanceof Error ? error.message : fallback` instead of `getErrorMessage()`. Down from 30 after #621's `serializeError` migration. Out of scope for #513 and #621 because `src/core` throws/returns rather than logs — services catch and log. Warrants a follow-up issue for consistency. (discovered in #513; count updated 2026-04-18 per fs grep)

- **`processing_queued` download status may be vestigial**: After #636 and #637, `processing_queued` is still set by `enqueueAutoImport()` as an intermediate download.status between completion and import start. The window between queue insertion and worker pickup is very short (serial queue, immediate nudge). The UI can now query `import_jobs` directly via `GET /api/import-jobs` (#637), so `processing_queued` may be removable from the download.status enum. Callers verified via grep: `src/server/routes/activity.ts:147` (comment), `src/server/utils/enqueue-auto-import.ts` (writer), `src/server/services/download.service.ts` (duplicate-check logic), plus several tests. Removal would require auditing the duplicate-check paths in download.service. (discovered in #636; re-evaluated 2026-04-18 after #637 merged)

## Accepted Debt

Items below are real but genuinely not worth fixing — the cost of change outweighs the benefit, or the "correct" fix would introduce its own problems.

- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Workaround (explicit form schemas with `as` casts) is in place and stable. A type-preserving generic would fight Zod v4's type system for marginal benefit. (discovered in #215)

- **`src/shared/schemas/settings/processing.ts`**: Shared `processingFormSchema` still uses `z.preprocess(nanToUndefined, ...)`. Not blocking — used by registry for server-side validation, not zodResolver. **Revisit trigger:** if zodResolver is ever pointed at this schema, the preprocess becomes a ZodEffects mismatch and will need replacing. (discovered in #219)

- **`src/core/utils/audio-processor.ts`**: `convertFiles()` injects `trackNumber`, `trackTotal`, `partName` unconditionally — single-file inputs get `trackNumber: 1, trackTotal: 1`. Metadata is accurate (there IS one track), and suffixes only appear in intermediate filenames during processing, not final output. Conditional logic would add complexity for zero observable impact. (discovered in #231)

- **`src/core/utils/audio-processor.ts:108-123`**: `processAudioFiles()` has a broad catch block that wraps ffmpeg errors, file I/O errors, chapter-source reading errors, and temp-file operations under one `{ success: false, error: message }` return. **Revisit trigger:** if blacklist classification needs to distinguish content vs tooling failures more precisely than the current `isContentFailure()` allowlist pattern, structured error types (`ProcessingErrorKind: 'media' | 'tooling' | 'io'`) become worth the refactor. (discovered in #504)

- **22 remaining `type="number"` inputs missing `step` attribute**: Across `BackupScheduleForm`, `GeneralSettingsForm`, `SearchSettingsSection`, `ImportListsSettings`, `ProcessingSettingsSection`, `DiscoverySettingsSection`, `ImportSettingsSection`, `notifier-fields`, `abb-fields`, and `DownloadClientFields`. Waiting to fix centrally at the `FormField` component level in one sweep rather than 22 individual site changes. (discovered in #583; count updated 2026-04-18 per fs grep — was 19)
