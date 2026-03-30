---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.tsx, src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 226
source: review
date: 2026-03-30
---
Boundary guard branches (pos === 0, pos === val.length) are easy no-op paths that feel "obvious" but still need explicit tests. The self-review coverage subagent flagged these as gaps but they were deprioritized since "they're just guard conditions." The reviewer correctly elevated them to blocking — a regression removing the guard would cause out-of-bounds access or unexpected deletion at field edges with no test failure. Always test every new guard condition, even when it seems like a trivial no-op.
