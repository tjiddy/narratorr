# Technical Debt

## Auth Test Failures (BLOCKING)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 auth integration tests failing on `main` — tests expect 401 but get 500/200. Blocks `scripts/verify.ts` from returning `VERIFY: pass` on any branch. Auth tests depend on `vi.mock('../config.js')` to override `AUTH_BYPASS=true` — this mock was applied, reverted, and re-applied during #57; root cause not documented. Recurring blocker since #16, rediscovered in #17, #21, #24, #28, #30, #37, #40, #50, #54, #57, #58, #62.

## Test Coverage Gaps

- **src/server/services/auth.service.test.ts**: `updateLocalBypass()`, `changePassword()` selective field updates (username-only vs password-only), and timing-safe comparison have no direct unit tests — only covered via route integration tests. (discovered in #8)
- **src/client/pages/settings/SecuritySettings.test.tsx**: `LocalBypassSection` toggle behavior and `ApiKeySection` clipboard copy button have no interaction tests — only existence tests. (discovered in #8)
- **src/client/pages/settings/SecuritySettings.tsx**: AuthModeSection and LocalBypassSection mutation flows (mode changes, toast messages, query invalidation) have no interaction tests. (discovered in #11)
- **src/client/pages/settings/LibrarySettingsSection.tsx**: File format token insertion test missing. Also missing: file format title-missing error, preview output assertions, Save button disabled-during-mutation test, cursor position after token insertion, pending button state text, dirty-reset after save. (discovered in #50, #18)
- **src/client/pages/activity/ActivityPage.tsx**: `usePagination.clampToTotal()` useEffect not covered by tests — pagination clamping behavior when totals shrink is untested. (discovered in #58)
- **src/client/pages/activity/DownloadCard.tsx**: Seeders visibility for usenet protocol (`download.protocol !== 'usenet'` guard) has no test. (discovered in #58)

## Code Hardening

- **src/core/metadata/ (audible.ts, audnexus.ts)**: Direct `fetch()` calls without timeout or redirect protection — consider migrating to `fetchWithTimeout`. (discovered in #23)
- **src/core/utils/parse.ts:315**: Server-side `formatBytes` helper has no guards for `bytes < 0`, `!isFinite`, or out-of-bounds index. Low urgency. (discovered in #29)
- **src/client/components/ConfirmModal.tsx**: Buttons lack `type="button"` — safe only when rendered outside a `<form>`, but any future usage inside a form would silently break. (discovered in #18)
- **src/shared/download-status-registry.ts**: `getReplacableStatuses` has a spelling typo (should be `getReplaceable`) — rename in a future chore. (discovered in #63)
