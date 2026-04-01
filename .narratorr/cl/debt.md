# Technical Debt

## Actionable

- **`src/client/pages/library/FilterRow.tsx` + `src/client/components/manual-import/ImportSummaryBar.tsx`**: 4 raw `<select>` elements still use manual `appearance-none` + `ChevronDownIcon` instead of shared `SelectWithChevron` (discovered in #224 → tracked in #288)
- **`src/client/components/settings/` inputClass duplication**: `inputClass` / `errorInputClass` constants copy-pasted across 3 settings field components. Could be extracted to shared `formStyles.ts` (discovered in #216 → tracked in #289)
- **Toggle switch markup duplication across settings sections**: Inline Tailwind toggle pattern copy-pasted in 7 settings section files. Should be extracted to a shared `<ToggleSwitch>` component (discovered in #265 → tracked in #289)
- **`src/client/pages/settings/CredentialsSection.tsx` + `ImportListProviderSettings.tsx`**: Still define local `inputClass` constants identical to shared `formStyles.ts`. Could import from shared location for full dedup (discovered in #289)
- **`src/server/services/blacklist.service.ts`**: `isBlacklisted(infoHash)` method still only checks `infoHash`, not `guid`. If usenet-only blacklisted entries exist (guid-only, no infoHash), `isBlacklisted()` won't find them. Low priority — only called from quality gate pre-check, not from reject flow (discovered in #248)
- **`src/server/services/search-pipeline.ts`**: `searchAndGrabForBook()` still has no blacklist filtering — only `retrySearch()` filters. Scheduled search and manual search can re-grab blacklisted releases. Spec explicitly deferred this as out-of-scope (discovered in #248)

## Accepted Debt

Items below are real but not worth fixing — the cost of change outweighs the benefit.

- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Workaround (explicit form schemas with `as` casts) is in place and stable. A type-preserving generic would fight Zod v4's type system for marginal benefit (discovered in #215)
- **`src/shared/schemas/settings/processing.ts`**: Shared `processingFormSchema` still uses `z.preprocess(nanToUndefined, ...)`. Not blocking — used by registry for server-side validation, not zodResolver. Changing it gains nothing (discovered in #219)
- **`src/client/pages/settings/ImportListProviderSettings.tsx`**: No co-located test file. Provider-specific settings are covered indirectly via the parent `ImportListsSettingsSection.test.tsx`. Adding a dedicated test would duplicate assertions (discovered in #216)
- **`src/client/pages/manual-import/PathStep.tsx`**: No co-located test file. Already covered indirectly via ManualImportPage.test.tsx (discovered in #224)
- **`src/core/utils/audio-processor.ts`**: `convertFiles()` injects `trackNumber`, `trackTotal`, `partName` unconditionally — single-file inputs get `trackNumber: 1, trackTotal: 1`. The metadata is accurate (there IS one track), and suffixes only appear in intermediate filenames during processing, not final output (discovered in #231)
