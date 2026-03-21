# Technical Debt

No active items. All prior debt graduated and resolved in #448.

- **src/server/services/auth.service.test.ts**: `updateLocalBypass()`, `changePassword()` selective field updates (username-only vs password-only), and timing-safe comparison have no direct unit tests — only covered via route integration tests. (discovered in #8)
- **src/client/pages/settings/SecuritySettings.test.tsx**: `LocalBypassSection` toggle behavior and `ApiKeySection` clipboard copy button have no interaction tests — only existence tests. (discovered in #8)
- **src/client/pages/settings/SecuritySettings.tsx**: AuthModeSection mutation flow (immediate mode changes without confirmation, toast messages, query invalidation) and LocalBypassSection mutation flow (checkbox onChange, success/error toasts, query invalidation) have no interaction tests. These are pre-existing gaps unrelated to the clipboard fix. (discovered in #11)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 auth integration tests failing on main — pre-existing, unrelated to CSP work. Root cause unknown but blocks `node scripts/verify.ts` from returning `VERIFY: pass` even on unrelated changes. (discovered in #16)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 pre-existing auth integration test failures on main — these poison `scripts/verify.ts` for all branches. Root cause unrelated to #17 but discovered during quality gate run. (discovered in #17)

- **src/server/routes/discover.test.ts** and **src/server/routes/prowlarr-compat.test.ts**: 5 auth-integration tests failing on `main` ("returns 401" getting 500 instead) — pre-existing failures unrelated to CSP work. Need investigation into why the auth plugin isn't rejecting unauthenticated requests in these test setups. (discovered in #21)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 auth integration tests failing on main — pre-existing before #28, unrelated to size parsing. Blocks `scripts/verify.ts` from returning `VERIFY: pass` on any branch. (discovered in #28)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 pre-existing auth test failures — tests assert 401 but something in the auth integration is broken; unrelated to #30 but blocking `verify.ts` pass for every branch (discovered in #30)

- **src/server/routes/discover.test.ts, src/server/routes/prowlarr-compat.test.ts**: 5 pre-existing auth test failures on `main` — unrelated to qBittorrent but block `scripts/verify.ts` from returning `VERIFY: pass` on any branch (discovered in #24)
- **src/core/metadata/ (audible.ts, audnexus.ts)**: These use direct `fetch()` calls without timeout or redirect protection — they won't benefit from auth-proxy detection or timeout enforcement. Consider migrating to `fetchWithTimeout` in a follow-up. (discovered in #23)

- **src/core/utils/parse.ts:315**: Second `formatBytes` helper with same negative/Infinity edge-case profile as the client formatter — no guards for `bytes < 0`, `!isFinite`, or out-of-bounds index. Server-side metadata display, low urgency, but should be hardened for consistency. (discovered in #29)

- **src/server/routes/discover.test.ts, src/server/routes/prowlarr-compat.test.ts**: Pre-existing auth test failures (5 tests) noted again in #40 — still present on main, still blocking `VERIFY: pass`. These need investigation and a fix, not just a note. (rediscovered in #40)

- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 pre-existing auth test failures (`returns 401 when no auth credentials provided`, `rejects /api/v1/* without credentials`) poison `verify.ts` on all branches. Needs investigation into the auth plugin test setup. (discovered in #37)

- **src/client/pages/settings/LibrarySettingsSection.tsx**: File format token insertion test missing (folder format token insertion is tested but not file format). Also missing: file format title-missing error, preview output assertions, Save button disabled-during-mutation test. (discovered in #50)
- **src/server/routes/discover.test.ts + prowlarr-compat.test.ts**: 5 pre-existing auth 401 test failures exist on main — these tests expect 401 but get 500/200. Root cause unknown; unrelated to frontend work but blocks verify.ts from returning VERIFY:pass. (discovered in #50)
