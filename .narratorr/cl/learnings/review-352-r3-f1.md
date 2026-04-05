---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.url-restore.test.tsx]
issue: 352
source: review
date: 2026-04-04
---
Back-navigation restoration tests must assert something that distinguishes the restored state from the default state. If a book appears in both the filtered and unfiltered views, asserting its presence proves nothing. Always assert both presence of expected items AND absence of items that should be filtered out. Prevention: when writing filter-restoration tests, always include a negative assertion (`queryByText('excluded item')).not.toBeInTheDocument()`).
