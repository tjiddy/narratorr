---
scope: [core]
files: [src/core/utils/naming.ts]
issue: 228
date: 2026-03-30
---
When adding prefix syntax to an existing suffix-only grammar, regex alone can't disambiguate `{author?title}` (suffix) from `{ - pt?trackNumber:00}` (prefix). Post-match logic checking the first \w+ against known token names resolves this cleanly. The key insight: extract the first word from the candidate prefix group, check if it's a known token. If yes, re-interpret as suffix syntax. This preserves backward compatibility without requiring syntax changes.
