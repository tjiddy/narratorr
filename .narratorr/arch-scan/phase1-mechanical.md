# Phase 1 — Mechanical Grep Scan (2026-03-30)

## ZOD-1 — Untrimmed `.min(1)`

**Status: CLEAN** — All `.min(1)` on strings are preceded by `.trim()`. The numeric `.min(1)` hits (port numbers, retention days, etc.) are correctly not trimmed.

## TS-1 — Untyped catch

**Status: CLEAN** — Zero `catch (e)` or `catch (err)` without `: unknown` found.

## TS-2 — Loose `as any` in production code

**Status: 2 findings in production code**

| File | Line | Code | Assessment |
|------|------|------|------------|
| `src/server/__tests__/helpers.ts:110` | 110 | `return chain as any` | Test helper — acceptable |
| `src/server/__tests__/helpers.ts:30` | 30 | `return mock as any` | Test helper (`inject<T>`) — acceptable |
| `src/client/pages/settings/ProcessingSettingsSection.tsx` | 156 | `resolver: zodResolver(processingFormSchema) as any` | **FINDING** — Zod resolver type mismatch worked around with `as any`. Likely a ZOD-2 issue (schema shape doesn't match form type). |
| `src/server/utils/secret-migration.ts` | 14 | Comment line, not actual cast | False positive |
| `src/server/services/discovery.service.test.ts:13` | 13 | `(expr as any).getSQL()` | Test — acceptable |
| `src/server/services/backup.service.test.ts:464` | 464 | `(service as any)._pendingRestore` | Test — acceptable |
| `src/client/components/settings/NotifierFields.test.tsx:25` | 25 | `as any` for RHF field path | Test — acceptable |
| Various `*.test.ts` | — | `service as any` for private method spying | Test pattern — acceptable per CLAUDE.md |

**Production violations: 1** — `ProcessingSettingsSection.tsx:156`

## ERR-1 — String-based error routing

**Status: 1 finding**

| File | Line | Code |
|------|------|------|
| `src/core/indexers/myanonamouse.ts` | 88, 141 | `body.includes('Error, you are not signed in')` |

This is checking a response body for an auth error string from MAM's API. It's at the system boundary (external API), so it's somewhat defensible — we don't control MAM's response format. But it could be wrapped in a typed error on detection.

## CSS-1 — Z-index scale violations

**Status: 2 potential findings**

Scale: z-10 (sticky headers) → z-30 (dropdowns) → z-40 (popovers) → z-50 (modals)

| File | Line | z-value | Expected | Assessment |
|------|------|---------|----------|------------|
| `DownloadClientFields.tsx` | 113 | `z-10` | z-30 (dropdown) | **FINDING** — Inline autocomplete dropdown using z-10 (sticky header level) instead of z-30 (dropdown level) |
| `BookContextMenu.tsx` | 48 | `z-10` | z-30 (dropdown/menu) | **FINDING** — Context menu using z-10 instead of z-30 |
| `LibraryBookCard.tsx` | 62 | `z-10` | z-10 | OK — badge overlay on card, local stacking |
| `LibraryTableView.tsx` | 93 | `z-10` | z-10 | OK — sticky table header |
| All others | — | — | — | Correct |

## DB-2 — Multi-step mutations without transaction

**Status: Needs Phase 2 semantic review** — 200+ db operations found. Grep alone can't determine which are multi-step sequences that need transactions vs independent operations. Flagged for agent review.
