# Technical Debt

## Test Coverage Gaps

- **src/server/services/library-scan.service.ts**: `importSingleBook()` failure-path test uses `null` metadata so the narrator snapshot in `import_failed` events is never exercised with real metadata. (discovered in #104)
- **src/client/pages/library-import/useLibraryImport.ts**: `handleRetry()` resets `prevMatchCountRef.current = 0` but does not call `startMatching()` after new scan results arrive — retry flow relies on `scanMutation.onSuccess` to call `startMatching()`, which works, but the explicit reset is subtle and undocumented. (discovered in #133)
- **src/client/pages/library-import/LibraryImportPage.tsx**: Pre-existing behavioral test gaps: deselect-all action, register button text with selectedCount=0, manual edit then register flow, duplicate visibility label text toggle, back link href, EditModal save with user-edited metadata, EditModal with missing matchResult/alternatives, summary bar counter accuracy. None introduced by #175. (discovered in #175)
- ~~**src/core/metadata/audnexus.ts**: No test for 429 Retry-After header parsing or default 60s fallback in `fetchJson()`. Rate limit retry timing could silently break. (discovered in #174)~~ **Resolved in #198** — 7 tests added covering valid/missing/empty/NaN/zero Retry-After headers.
- ~~**src/core/metadata/audnexus.ts**: No test verifying `region` query param is sent in `getBook()` / `getAuthor()` calls. Region config changes would go undetected. (discovered in #174)~~ **Resolved in #198** — 4 tests added verifying region param for both methods (custom + default).

## Code Hardening

- ~~**src/client/pages/manual-import/PathStep.tsx**: frontend-design skill was unavailable — visual polish pass not applied; amber accent hover states and glass-card styling may need review for consistency. (discovered in #81)~~ **Resolved in #202** — verified compliant (glass-card, focus-ring, amber accents all present).
- ~~**src/client/pages/manual-import/pathUtils.ts**: `makeRelativePath` and `isPathInsideLibrary` are co-located in the Manual Import folder but used by both Manual Import and Library Import — should be moved to a shared location (e.g., `src/client/lib/pathUtils.ts`) when a third consumer appears. (discovered in #175)~~ **Resolved in #202** — moved to `src/client/lib/pathUtils.ts`.
- **src/server/routes/activity.ts**: ~~`DELETE /api/activity/:id/history` still uses `message.includes('use cancel instead')` string matching for error routing~~ — verified in #197: no `message.includes()` exists in `activity.ts`; error is already plugin-routed via `error-handler.ts`. **Resolved.**

## Discovered in CL triage (2026-03-28)

- **ERR-1 pattern**: ~~7 instances of `message.includes()` for error routing remain across `search-pipeline.ts`, `jobs/rss.ts`, `jobs/search.ts`, `blackhole.ts`, `backup.service.ts`.~~ **Resolved in #197** — all sites replaced with typed `instanceof` or `NodeJS.ErrnoException.code` checks.
- ~~**Test fixture bugs**: `qbittorrent.test.ts` uses `HttpResponse.json()` for plain-text endpoint (lines 49/68/86); `LibrarySettingsSection.test.tsx` uses `userEvent.keyboard('{author}/')` which fires unknown key events (lines 439/504); `DownloadClientFields.test.tsx:169` uses fragile CSS selector. (CL triage)~~ **Resolved in #202.**
- ~~**focus-ring consistency**: 50+ bare `focus:outline-none` instances in settings/form inputs should use `focus-ring` utility. (CL triage)~~ **Resolved in #202** — 52 instances replaced across 23 files.
