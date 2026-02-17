# Project Context Cache

## Recent Changes
- PR #136 — #135 Remove Google Books metadata provider: deleted provider, test, fixtures, MSW handlers; removed all references from core index, MetadataService, and tests (807 lines removed)
- PR #123 — #122 Enrich directory-scanned books with audio file metadata: extracted shared `enrichBookFromAudio` utility from ImportService, wired into LibraryScanService.confirmImport(), expanded ImportResult with enrichment counts, updated modal summary
- PR #120 — #63 Prowlarr integration: ProwlarrClient in core, ProwlarrSyncService with preview/apply pattern, 5 API routes, ProwlarrImport UI with segmented sync mode toggle and animated preview table, source tracking via `source`/`sourceIndexerId` columns, 30 new tests
- PR #116 — #64 Show protocol badges: New ProtocolBadge component (emerald torrent, violet usenet), wired into SearchReleasesModal and ActivityPage metadata rows, 4 new tests
- PR #115 — #87 Metadata provider rate limiting: RateLimitError class, 429 detection in Hardcover/Google Books, RequestThrottle + backoff in MetadataService, warnings in search response, enrichment job batch-break
- PR #114 — #76 Normalize and deduplicate genre metadata: normalizeGenres() function, wired into all 3 providers, unmatched_genres DB table, top 3 genre pills on search cards
- PR #113 — #81 Fuzzy library search: Fuse.js-based useLibrarySearch hook with multi-field weighted search, debounce, wired into LibraryPage
- PR #111 — #86 Google Books metadata provider: new provider with search, getBook, getAuthor, test endpoint
- PR #109 — #107 API-level E2E tests: createE2EApp() helper with real libSQL DB, CRUD flow tests
- PR #108 — #106 CI pipeline: Gitea Actions workflow for lint/test/typecheck/build on PRs
- PR #105 — #82 Audio file-based enrichment: ID3 tag scanning, quality analysis, embedded cover extraction
