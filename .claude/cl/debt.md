# Technical Debt

No active items. All prior debt graduated and resolved in #448.

- **src/server/services/auth.service.test.ts**: `updateLocalBypass()`, `changePassword()` selective field updates (username-only vs password-only), and timing-safe comparison have no direct unit tests — only covered via route integration tests. (discovered in #8)
- **src/client/pages/settings/SecuritySettings.test.tsx**: `LocalBypassSection` toggle behavior and `ApiKeySection` clipboard copy button have no interaction tests — only existence tests. (discovered in #8)
