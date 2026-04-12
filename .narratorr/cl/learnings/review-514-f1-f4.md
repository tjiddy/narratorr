---
scope: [frontend, backend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/activity/DownloadsTabSection.tsx, src/server/routes/discover.ts, src/server/routes/books.ts]
issue: 514
source: review
date: 2026-04-12
---
New guard branches and UI behavior changes (errorInputClass adoption, per-item mutation state, optional-dep guards) need direct assertions proving the new behavior works — not just that existing tests still pass. Reviewer caught 4 blocking gaps: (1) error border styling untested, (2) per-row cancelling state untested with multiple rows, (3-4) missing-dep route guards not exercised. Root cause: implementation treated these as "refactors that keep behavior the same" rather than "new branches that need new tests." Each new if-condition is testable behavior per testing.md.
