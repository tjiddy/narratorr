# Technical Debt

## Test Coverage Gaps

- **src/client/pages/settings/SecuritySettings.tsx**: AuthModeSection and LocalBypassSection mutation flows (mode changes, toast messages, query invalidation) have no interaction tests. (discovered in #11)
- **src/client/pages/settings/LibrarySettingsSection.tsx**: Remaining: fileFormat title-missing, preview output assertions, dirty-reset after save. (discovered in #50, #18)
- **src/client/pages/activity/ActivityPage.tsx**: `usePagination.clampToTotal()` useEffect not covered by tests — pagination clamping behavior when totals shrink is untested. (discovered in #58)

## Code Hardening

- **src/core/metadata/ (audible.ts, audnexus.ts)**: Redirect protection still absent — `AbortSignal.timeout()` was added in #94 but `redirect: 'manual'` (via `fetchWithTimeout`) was explicitly kept out of scope. (discovered in #23, partially resolved in #94)
- **scripts/lib.ts**: No `git push` helper that embeds a fresh installation token — `git push` fails with stale GH_TOKEN; workaround is manual inline token refresh each session. (discovered in #79)
- **src/client/components/manual-import/BookEditModal.tsx + ImportCard.tsx + DirectoryBrowserModal.tsx**: 17 pre-existing behavioral gaps identified by coverage subagent (issue #80). #97 addressed 7 (Windows paths, slice boundary ×2, applyMetadata multi-author, narrator display, singular file form). Remaining untested: row background classes, showPencilAlways visibility (CSS-only, no behavioral contract). (discovered in #80, partially resolved in #97)
- **src/client/pages/manual-import/PathStep.tsx**: frontend-design skill was unavailable — visual polish pass not applied; amber accent hover states and glass-card styling may need review for consistency. (discovered in #81)
- **src/client/pages/activity/ActivityPage.tsx + useActivity.ts**: `useActivitySection` lacks `placeholderData: keepPreviousData` — when navigating pages, data briefly becomes `undefined`, causing `queueTotal = 0` and the clamp effect resetting the page to 1. Production behavior may differ from tests due to browser microtask timing. (discovered in #93)
- **src/server/services/library-scan.service.ts**: `importSingleBook()` failure-path test uses `null` metadata so the narrator snapshot in `import_failed` events is never exercised with real metadata. The `import_failed` narrator assertion relies on correct catch-block code but has no test that actually verifies a non-null narrator on failure. (discovered in #104)
- **src/client/pages/library/LibraryPage.test.tsx**: Page-level integration tests directly interact with toolbar UI controls; any toolbar refactor requires updating many tests in this file. Consider extracting toolbar interaction helpers. (discovered in #106)
- **LibraryBookCard.test.tsx**: `onMenuToggle` callback is mocked in `defaultProps()` but never asserted against — clicking the options button and verifying the callback fires is untested; a wiring regression would go undetected (discovered in #105)
- **src/client/components/SSEProvider**: No dedicated test for subscription/unsubscription lifecycle or connection error handling — integration is exercised indirectly via Layout tests only (discovered in #108)

- **src/client/pages/settings/ImportSettingsSection.tsx**: `importFormSchema` (local to component, lines 13-17) duplicates `importSettingsSchema` from shared schemas — must be kept in sync manually when new fields are added. Each new boolean setting requires editing both the shared schema and the component's local form schema. (discovered in #118)

- **src/client/pages/library-import/useLibraryImport.ts**: `handleRetry()` resets `prevMatchCountRef.current = 0` but does not call `startMatching()` after new scan results arrive — retry flow relies on `scanMutation.onSuccess` to call `startMatching()`, which works, but the explicit reset is subtle and undocumented. (discovered in #133)

- **src/client/pages/library-import/LibraryImportPage.tsx**: `getRelativePath()` uses `startsWith()` for path ancestor check — the same anti-pattern CLAUDE.md prohibits. The correct POSIX-safe utility was added in `pathUtils.ts` for Manual Import (#134) but not applied to this file; a follow-up should converge both on the shared util. (discovered in #134)
- **src/server/services/library-scan.service.ts**: No server-side enforcement of the library-root guardrail — `copyToLibrary()` only skips when source === target (exact match), not when source is nested under the library root. A Manual Import with a library-internal path would attempt to copy already-managed files. Frontend guardrail (#134) is the only protection. (discovered in #134)
