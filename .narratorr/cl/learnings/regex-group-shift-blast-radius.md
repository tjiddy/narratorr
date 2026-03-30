---
scope: [core, frontend]
files: [src/core/utils/naming.ts, src/shared/schemas/settings/library.ts, src/client/pages/settings/NamingSettingsSection.tsx]
issue: 228
date: 2026-03-30
---
When adding a new capture group to a shared regex (TOKEN_PATTERN_SOURCE), every consumer that references match[N] groups must be updated simultaneously. The group index shift from 3 to 4 groups broke validateTokens(), parseTemplate(), and TOKEN_BOUNDARY_REGEX. Enumerate all consumers via grep before changing the regex.
