# Architecture Scan: Phase 2 — DRY-2 & ZOD-2

## DRY-2 — Duplicated Logic

### 1. `hasTitle` and `validateTokens` copied to NamingSettingsSection (BLOCKING)

**Files:**
- `src/shared/schemas/settings/library.ts` (lines 7-18) — canonical definitions
- `src/client/pages/settings/NamingSettingsSection.tsx` (lines 20-30) — identical copy

Both files define `hasTitle(val: string): boolean` with the exact same regex `/\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/` and `validateTokens(val: string, allowed: readonly string[]): boolean` with the exact same token extraction regex `/\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g` and logic.

**Fix:** Export `hasTitle` and `validateTokens` from `library.ts`, import in the component.

### 2. Title-check regex used a third time inline (SUGGESTION)

**File:** `src/client/pages/settings/NamingSettingsSection.tsx` (lines 196, 198)

The same `/\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/` regex that `hasTitle` wraps is used inline two more times in the same component (for `hasTitleToken` and `fileTitleToken` warning displays). These should call the already-defined `hasTitle` function instead of duplicating the regex.

**Fix:** Replace inline regex tests with `hasTitle(folderFormat)` and `hasTitle(fileFormat)`.

### 3. `formatBytes` defined in two files (BLOCKING)

**Files:**
- `src/core/utils/parse.ts` (line 308) — `export function formatBytes(bytes: number): string`
- `src/client/lib/api/utils.ts` (line 1) — `export function formatBytes(bytes?: number): string`

Near-identical implementations (1024-based byte formatting with the same sizes array `['B', 'KB', 'MB', 'GB', 'TB']`). The client version adds a `!bytes` guard and an `i >= sizes.length` guard; otherwise the logic is the same. Both are actively imported:
- `src/core/utils/parse.ts` version: re-exported via `@core/utils/index.js`, used by `AudioInfo.tsx`
- `src/client/lib/api/utils.ts` version: used by 9+ client components via `@/lib/api`

**Fix:** Keep one canonical definition (the client version has better null-safety), export from a shared location, import everywhere.

### 4. `formatDate` (short date) defined in two files (SUGGESTION)

**Files:**
- `src/client/pages/manual-import/PathStep.tsx` (line 33) — `function formatDate(iso: string): string` using `toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })`
- `src/client/pages/library/LibraryTableView.tsx` (line 19) — `function formatDate(dateStr: string): string` using `toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })`

Identical formatting logic, just different parameter names.

Note: `EventHistoryCard.tsx` also has a `formatDate` but it does relative time ("5m ago", "2d ago"), which is different behavior.

**Fix:** Extract a shared `formatShortDate` to `src/client/lib/helpers.ts` (which already has `formatDuration`).

---

## ZOD-2 — Schema Copy Instead of Composition

### 1. `namingFormSchema` copies fields from `libraryFormSchema` (BLOCKING)

**Files:**
- `src/shared/schemas/settings/library.ts` (lines 53-67) — `libraryFormSchema` with fields: `path`, `folderFormat`, `fileFormat`, `namingSeparator`, `namingCase`
- `src/client/pages/settings/NamingSettingsSection.tsx` (lines 33-46) — `namingFormSchema` with fields: `folderFormat`, `fileFormat`, `namingSeparator`, `namingCase`

`namingFormSchema` is `libraryFormSchema` minus `path`, with identical refine chains on `folderFormat` and `fileFormat`. The refines use the same `hasTitle`/`validateTokens` logic (which is itself copied per DRY-2 finding #1).

**Fix:** `libraryFormSchema.omit({ path: true })` or extract a shared `namingFieldsSchema` that both compose from.

### 2. `libraryFormSchema` redefines `librarySettingsSchema` fields (SUGGESTION)

**File:** `src/shared/schemas/settings/library.ts` — both schemas in the same file

`librarySettingsSchema` (line 45) and `libraryFormSchema` (line 53) define the same 5 fields (`path`, `folderFormat`, `fileFormat`, `namingSeparator`, `namingCase`). The form version strips `.default()` and adds `.trim().min(1)` to format fields. Since Zod's `.omit()` doesn't strip defaults, this is somewhat justified, but the refine chains on `folderFormat`/`fileFormat` are duplicated verbatim between the settings schema (which uses `folderFormatSchema`/`fileFormatSchema`) and the form schema.

**Fix:** Extract the refine chain into a reusable pipeline, or build the form schema from the settings schema's shape.

### 3. `qualityFormSchema` redefines all `qualitySettingsSchema` fields (BLOCKING)

**Files:**
- `src/shared/schemas/settings/quality.ts` (lines 6-14) — `qualitySettingsSchema` with 7 fields
- `src/client/pages/settings/QualitySettingsSection.tsx` (lines 19-27) — `qualityFormSchema` with the same 7 fields

All 7 field names match exactly: `grabFloor`, `protocolPreference`, `minSeeders`, `searchImmediately`, `monitorForUpgrades`, `rejectWords`, `requiredWords`. The only difference is the form version omits `.default()`. This is the textbook ZOD-2 violation — the schema should derive from the canonical one.

**Fix:** Strip defaults programmatically or use a `required()` wrapper on the settings schema.

### 4. `generalFormSchema` redefines `generalSettingsSchema` fields minus one (SUGGESTION)

**Files:**
- `src/shared/schemas/settings/general.ts` (lines 6-11) — `generalSettingsSchema` with 4 fields
- `src/client/pages/settings/GeneralSettingsForm.tsx` (lines 13-17) — `generalFormSchema` with 3 fields (omits `welcomeSeen`)

3 of 4 fields are identical: `logLevel`, `housekeepingRetentionDays`, `recycleRetentionDays`. The form just drops `welcomeSeen` and defaults.

**Fix:** `generalSettingsSchema.omit({ welcomeSeen: true })` with defaults stripped.

### 5. `discoveryFormSchema` redefines `discoverySettingsSchema` fields minus one (SUGGESTION)

**Files:**
- `src/shared/schemas/settings/discovery.ts` (lines 10-19) — `discoverySettingsSchema` with 6 fields
- `src/client/pages/discover/DiscoverySettingsSection.tsx` (lines 13-19) — `discoveryFormSchema` with 5 fields (omits `weightMultipliers`)

5 of 6 fields match: `enabled`, `intervalHours`, `maxSuggestionsPerAuthor`, `expiryDays`, `snoozeDays`.

**Fix:** `discoverySettingsSchema.omit({ weightMultipliers: true })` with defaults stripped.

---

## Summary

| ID | Check | Severity | Location |
|----|-------|----------|----------|
| DRY-2.1 | `hasTitle`/`validateTokens` copied | Blocking | `library.ts` + `NamingSettingsSection.tsx` |
| DRY-2.2 | Title regex used inline instead of calling `hasTitle` | Suggestion | `NamingSettingsSection.tsx` |
| DRY-2.3 | `formatBytes` defined twice | Blocking | `parse.ts` + `api/utils.ts` |
| DRY-2.4 | `formatDate` (short) defined twice | Suggestion | `PathStep.tsx` + `LibraryTableView.tsx` |
| ZOD-2.1 | `namingFormSchema` copies `libraryFormSchema` | Blocking | `NamingSettingsSection.tsx` + `library.ts` |
| ZOD-2.2 | `libraryFormSchema` redefines `librarySettingsSchema` | Suggestion | `library.ts` |
| ZOD-2.3 | `qualityFormSchema` copies all 7 fields | Blocking | `QualitySettingsSection.tsx` + `quality.ts` |
| ZOD-2.4 | `generalFormSchema` copies 3/4 fields | Suggestion | `GeneralSettingsForm.tsx` + `general.ts` |
| ZOD-2.5 | `discoveryFormSchema` copies 5/6 fields | Suggestion | `DiscoverySettingsSection.tsx` + `discovery.ts` |

### Pattern note

There's a systemic pattern here: every settings form component defines its own Zod schema that copies fields from the shared settings schema but strips `.default()`. A utility like `stripDefaults(schema)` or a convention of exporting both `settingsSchema` (with defaults, for server) and `formSchema` (without, for client) from each shared settings file would eliminate the entire class of ZOD-2 violations across settings.
