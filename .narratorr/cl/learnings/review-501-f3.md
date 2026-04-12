---
scope: [frontend]
files: [src/client/pages/discover/DiscoverPage.test.tsx]
issue: 501
source: review
date: 2026-04-12
---
When a page depends on multiple queries (suggestions + settings), always test the cross-product where one succeeds and the other fails. The settings-failure case is especially important when derived state (filtering) depends on settings — a rejection must degrade gracefully to "no filtering" rather than crash or filter everything out.
