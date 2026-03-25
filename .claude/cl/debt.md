# Technical Debt

## Auth Test Failures (BLOCKING)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 auth integration tests failing on `main` — tests expect 401 but get 500/200. Blocks `scripts/verify.ts` from returning `VERIFY: pass` on any branch. Auth tests depend on `vi.mock('../config.js')` to override `AUTH_BYPASS=true` — this mock was applied, reverted, and re-applied during #57; root cause not documented. Recurring blocker since #16, rediscovered in #17, #21, #24, #28, #30, #37, #40, #50, #54, #57, #58, #62.

## Test Coverage Gaps

- **src/server/services/auth.service.test.ts**: `updateLocalBypass()` and timing-safe comparison gaps resolved in #82. (was: discovered in #8)
- **src/client/pages/settings/SecuritySettings.test.tsx**: `LocalBypassSection` toggle interaction tests added in #82. `ApiKeySection` clipboard copy button still has no interaction test. (was: discovered in #8)
- **src/client/pages/settings/SecuritySettings.tsx**: AuthModeSection and LocalBypassSection mutation flows (mode changes, toast messages, query invalidation) have no interaction tests. (discovered in #11)
- **src/client/pages/settings/LibrarySettingsSection.tsx**: Token insertion, Save button pending state, cursor position, and folderFormat validation tests added in #82. Remaining: fileFormat title-missing, preview output assertions, dirty-reset after save. (was: discovered in #50, #18)
- **src/client/pages/activity/ActivityPage.tsx**: `usePagination.clampToTotal()` useEffect not covered by tests — pagination clamping behavior when totals shrink is untested. (discovered in #58)
- **src/client/pages/activity/DownloadCard.tsx**: Usenet seeders guard test added in #82. (was: discovered in #58)

## Code Hardening

- **src/core/metadata/ (audible.ts, audnexus.ts)**: Direct `fetch()` calls without timeout or redirect protection — consider migrating to `fetchWithTimeout`. (discovered in #23)
- **scripts/lib.ts**: No `git push` helper that embeds a fresh installation token — `git push` fails with stale GH_TOKEN; workaround is manual inline token refresh each session. (discovered in #79)
- **src/server/services/import.service.test.ts**: Large describe block complexity — the main describe has 80+ tests with a complex `beforeEach` setup. Could be split by concern (getEligibleDownloads, importDownload, getImportContext). (discovered in #79)

- **src/client/components/manual-import/BookEditModal.tsx + ImportCard.tsx + DirectoryBrowserModal.tsx**: Coverage subagent (issue #80) identified 17 pre-existing behavioral gaps: Windows backslash path handling in parseBreadcrumbs/ImportCard, search results slice(0,6) boundary not tested, applyMetadata() multi-author edge case, confidence label text for non-medium cases, narrator display in alternatives list, singular "1 file" form, selected/unselected row background classes, showPencilAlways high-confidence visibility. None are new regressions — all existed before #80. (discovered in #80)

- **src/client/pages/manual-import/PathStep.tsx**: frontend-design skill was unavailable — visual polish pass not applied; amber accent hover states and glass-card styling may need review for consistency with the rest of the app (discovered in #81)
