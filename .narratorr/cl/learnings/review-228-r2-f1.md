---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 228
source: review
date: 2026-03-30
---
When adding a new preview row that consumes the same `namingOptions` as existing rows, the spy-based token-map test is insufficient — it only proves the data contract, not that the options (separator/case) flow through. A separate assertion must verify that option changes propagate to all three consumers independently, because a bug in just one row's memo dependencies would be masked by the other rows passing.
