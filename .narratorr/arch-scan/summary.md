# Architecture Scan Summary (2026-03-30)

Full codebase scan against all 17 architecture checks.

## Blocking Findings

| ID | Check | File(s) | Description |
|----|-------|---------|-------------|
| B1 | DB-2 | `book.service.ts:180-216` | `create()` — insert book + syncAuthors + syncNarrators without transaction. Manual compensating delete doesn't cover all failure modes. |
| B2 | DB-2 | `book.service.ts:218-239` | `update()` — update book + syncNarrators + syncAuthors without transaction or compensating action. |
| B3 | DB-2 | `recycling-bin.service.ts:114-148` | `restore()` — insert book + sync authors + sync narrators + delete recycling entry. Four mutations across three tables; failure mid-sequence creates duplicate books on retry. |
| B4 | DRY-2 | `NamingSettingsSection.tsx` + `library.ts` | `hasTitle` and `validateTokens` copied verbatim instead of imported. |
| B5 | DRY-2 | `core/utils/parse.ts` + `client/lib/api/utils.ts` | `formatBytes` independently defined with near-identical logic. |
| B6 | ZOD-2 | `NamingSettingsSection.tsx` | `namingFormSchema` copies 4/5 fields from `libraryFormSchema` instead of deriving via `.pick()/.omit()`. |
| B7 | ZOD-2 | Quality settings (file TBD) | `qualityFormSchema` copies all 7 fields from `qualitySettingsSchema` with only `.default()` stripped. |
| B8 | TS-2 | `ProcessingSettingsSection.tsx:156` | `zodResolver(processingFormSchema) as any` — type mismatch worked around with cast. |
| B9 | REACT-3 | 7+ settings sections | Raw `<select>` with identical styling copy-pasted. `SelectWithChevron` exists locally in `NamingSettingsSection.tsx` but isn't shared. |

## Suggestions

| ID | Check | File(s) | Description |
|----|-------|---------|-------------|
| S1 | CSS-1 | `DownloadClientFields.tsx:113` | Autocomplete dropdown uses `z-10` instead of `z-30` (dropdown scale). |
| S2 | CSS-1 | `BookContextMenu.tsx:48` | Context menu uses `z-10` instead of `z-30`. |
| S3 | ERR-1 | `myanonamouse.ts:88,141` | `body.includes('Error, you are not signed in')` — string-based auth check against external API. Defensible at system boundary but could wrap in typed error. |
| S4 | DRY-2 | `NamingSettingsSection.tsx` | Title-check regex used inline twice more instead of calling existing `hasTitle`. |
| S5 | DRY-2 | `PathStep.tsx` + `LibraryTableView.tsx` | `formatDate` short date formatting duplicated. |
| S6 | ZOD-2 | `library.ts` | `libraryFormSchema` redefines `librarySettingsSchema` fields in the same file instead of deriving. |
| S7 | ZOD-2 | General + Discovery settings | `generalFormSchema` copies 3/4 fields, `discoveryFormSchema` copies 5/6 fields. |
| S8 | REACT-5 | `App.tsx` / `main.tsx` | Single root-level error boundary. No page-level boundaries — crash on one page kills navigation to all. |
| S9 | REACT-4 | 5 pagination components | `useEffect` to clamp page on total change. Could absorb into `usePagination` hook. Borderline — consistent and correct as-is. |

## Systemic Patterns

### ZOD-2 is systemic, not isolated
Every settings form component creates its own Zod schema by copying the shared schema and stripping `.default()`. A `stripDefaults()` utility or co-located form schema exports would kill this entire class of violations across general, library, quality, discovery, and naming settings.

### REACT-3 is systemic, not isolated
7+ settings sections paste the same `<select>` styling. `SelectWithChevron` needs to be extracted to `src/client/components/` and adopted everywhere. Same for any other form control patterns that are repeated.

## Clean Checks

| Check | Status |
|-------|--------|
| ZOD-1 | Clean — all string `.min(1)` properly trimmed |
| TS-1 | Clean — all catch blocks use `: unknown` |
| OCP-1 | Clean — adapter registries use `Record<string, Factory>` maps |
| OCP-2 | Clean — new adapters require 2-3 files, under threshold |
| SRP-1 | Clean — no mixed-concern files found |
| DB-1 | Clean — rename/merge services update DB immediately after filesystem ops |
| REACT-1 | Clean — no god hooks, returns well-grouped |
| REACT-4 | Clean (with S9 borderline note) |
