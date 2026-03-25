# Technical Debt

## Test Coverage Gaps

- **src/client/pages/settings/SecuritySettings.tsx**: AuthModeSection and LocalBypassSection mutation flows (mode changes, toast messages, query invalidation) have no interaction tests. (discovered in #11)
- **src/client/pages/settings/LibrarySettingsSection.tsx**: Remaining: fileFormat title-missing, preview output assertions, dirty-reset after save. (discovered in #50, #18)
- **src/client/pages/activity/ActivityPage.tsx**: `usePagination.clampToTotal()` useEffect not covered by tests — pagination clamping behavior when totals shrink is untested. (discovered in #58)

## Code Hardening

- **src/core/metadata/ (audible.ts, audnexus.ts)**: Direct `fetch()` calls without timeout or redirect protection — consider migrating to `fetchWithTimeout`. (discovered in #23)
- **scripts/lib.ts**: No `git push` helper that embeds a fresh installation token — `git push` fails with stale GH_TOKEN; workaround is manual inline token refresh each session. (discovered in #79)
- **src/server/services/import.service.test.ts**: Large describe block complexity — the main describe has 80+ tests with a complex `beforeEach` setup. Could be split by concern (getEligibleDownloads, importDownload, getImportContext). (discovered in #79)
- **src/client/components/manual-import/BookEditModal.tsx + ImportCard.tsx + DirectoryBrowserModal.tsx**: 17 pre-existing behavioral gaps identified by coverage subagent (issue #80): Windows backslash path handling, search results boundary, applyMetadata() multi-author edge case, confidence labels, narrator display in alternatives, singular file form, row background classes, showPencilAlways visibility. (discovered in #80)
- **src/client/pages/manual-import/PathStep.tsx**: frontend-design skill was unavailable — visual polish pass not applied; amber accent hover states and glass-card styling may need review for consistency. (discovered in #81)
- **src/client/pages/activity/ActivityPage.tsx + useActivity.ts**: `useActivitySection` lacks `placeholderData: keepPreviousData` — when navigating pages, data briefly becomes `undefined`, causing `queueTotal = 0` and the clamp effect resetting the page to 1. Production behavior may differ from tests due to browser microtask timing. (discovered in #93)
