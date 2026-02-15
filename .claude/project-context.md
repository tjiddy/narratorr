# Project Context Cache

Auto-maintained reference for workflow skills. Read this before exploring the codebase.

## Core Interfaces
<!-- last-updated: 2026-02-14 -->

### IndexerAdapter (`packages/core/src/indexers/types.ts`)
```ts
interface IndexerAdapter {
  readonly type: string;
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  test(): Promise<{ success: boolean; message?: string }>;
}
// SearchResult: title, author?, narrator?, protocol, downloadUrl?, infoHash?, size?, seeders?, leechers?, grabs?, indexer, detailsUrl?, coverUrl?
// SearchOptions: limit?, author?
// DownloadProtocol = 'torrent' | 'usenet'
```

### DownloadClientAdapter (`packages/core/src/download-clients/types.ts`)
```ts
interface DownloadClientAdapter {
  readonly type: string;
  readonly name: string;
  readonly protocol: DownloadProtocol;
  addDownload(url: string, options?: AddDownloadOptions): Promise<string>;
  getDownload(id: string): Promise<DownloadItemInfo | null>;
  getAllDownloads(category?: string): Promise<DownloadItemInfo[]>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  removeDownload(id: string, deleteFiles?: boolean): Promise<void>;
  test(): Promise<{ success: boolean; message?: string }>;
}
// DownloadItemInfo: id, name, progress, status, savePath, size, downloaded, uploaded, ratio, seeders, leechers, eta?, addedAt, completedAt?
```

### MetadataProvider (`packages/core/src/metadata/types.ts`)
```ts
interface MetadataProvider {
  readonly name: string;
  readonly type: string;
  search(query: string): Promise<MetadataSearchResults>;
  searchBooks(query: string): Promise<BookMetadata[]>;
  searchAuthors(query: string): Promise<AuthorMetadata[]>;
  searchSeries(query: string): Promise<SeriesMetadata[]>;
  getBook(asin: string): Promise<BookMetadata | null>;
  getAuthor(asin: string): Promise<AuthorMetadata | null>;
  getAuthorBooks(asin: string): Promise<BookMetadata[]>;
  getSeries(asin: string): Promise<SeriesMetadata | null>;
  test(): Promise<{ success: boolean; message?: string }>;
}
```

### NotifierAdapter (`packages/core/src/notifiers/types.ts`)
```ts
interface NotifierAdapter {
  readonly type: string;
  send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }>;
  test(): Promise<{ success: boolean; message?: string }>;
}
// NotificationEvent = 'on_grab' | 'on_download_complete' | 'on_import' | 'on_failure'
// EventPayload: event, book?, release?, download?, import?, error?
// Adapters: WebhookNotifier, DiscordNotifier, ScriptNotifier
```

## Service Pattern
<!-- last-updated: 2026-02-14 -->

Constructor injection with `(db: Db, log: FastifyBaseLogger)`. Some services take additional service deps (e.g., `DownloadService(db, downloadClient, log)`, `ImportService(db, downloadClient, settings, log)`).

All services instantiated in `routes/index.ts:createServices()` and passed to route handlers. Logger type: `FastifyBaseLogger` from `fastify` (NOT `BaseLogger` from `pino`).

Services: `SettingsService`, `IndexerService`, `DownloadClientService`, `BookService`, `DownloadService`, `MetadataService`, `ImportService`, `LibraryScanService`, `NotifierService`, `BlacklistService`

## Route Wiring
<!-- last-updated: 2026-02-14 -->

`apps/narratorr/src/server/routes/index.ts`:
- `createServices(db, log)` → instantiates all services
- `registerRoutes(app, services)` → registers: books, search, activity, indexers, downloadClients, settings, metadata, system, libraryScan, notifiers
- Route files export `async function xxxRoutes(app, ...services)`

## Test Patterns
<!-- last-updated: 2026-02-14 -->

| Layer | Example File | Pattern |
|-------|-------------|---------|
| Service (mock DB) | `services/book.service.test.ts` | Mock db + logger, test business logic |
| Route (inject) | `routes/search.test.ts` | Fastify `inject()`, mock services |
| Core adapter (MSW) | `packages/core/src/indexers/abb.test.ts` | MSW `setupServer()` for HTTP mocking |
| Frontend component | `pages/SearchPage.test.tsx` | `renderWithProviders` from `__tests__/helpers.tsx` |
| Frontend hook | `hooks/useLibrary.test.tsx` | `renderHook` from Testing Library |
| Schema validation | `packages/core/src/metadata/schemas.test.ts` | Direct Zod parse assertions |

Global setup: `src/client/__tests__/setup.ts` (matchMedia mock, cleanup)

## DB Schema Summary
<!-- last-updated: 2026-02-14 -->

| Table | Key Columns | Enums |
|-------|-------------|-------|
| `authors` | id, name, slug (unique), asin, monitored, imageUrl, bio | — |
| `books` | id, title, authorId (FK), narrator, asin, isbn, seriesName, seriesPosition, path, size | status: wanted/searching/downloading/imported/missing; enrichmentStatus: pending/enriched/failed/skipped |
| `indexers` | id, name, type, enabled, priority, settings (JSON) | type: abb/torznab/newznab |
| `downloadClients` | id, name, type, enabled, priority, settings (JSON) | type: qbittorrent/transmission/sabnzbd/nzbget |
| `downloads` | id, bookId (FK), indexerId (FK), downloadClientId (FK), title, protocol, infoHash, externalId, status, progress | status: queued/downloading/paused/completed/importing/imported/failed; protocol: torrent/usenet |
| `searchHistory` | id, query, type, resultsCount, searchedAt | type: metadata/indexer |
| `blacklist` | id, bookId (FK), infoHash, title, reason, note | reason: wrong_content/bad_quality/wrong_narrator/spam/other |
| `notifiers` | id, name, type, enabled, events (JSON), settings (JSON) | type: webhook/discord/script |
| `settings` | key (PK), value (JSON) | — |

## Shared Schemas (`shared/schemas.ts`)
<!-- last-updated: 2026-02-14 -->

- `idParamSchema` — string→int ID param
- `indexerTypeSchema` / `createIndexerSchema` / `updateIndexerSchema` / `createIndexerFormSchema`
- `downloadClientTypeSchema` / `createDownloadClientSchema` / `updateDownloadClientSchema` / `createDownloadClientFormSchema`
- `searchQuerySchema` / `grabSchema`
- `librarySettingsSchema` / `searchSettingsSchema` / `importSettingsSchema` / `generalSettingsSchema` / `appSettingsSchema` / `updateSettingsSchema` / `updateSettingsFormSchema`
- `metadataSearchQuerySchema` / `asinParamSchema`
- `downloadStatusSchema`
- `folderFormatSchema` — template validation with tokens: author, title, series, seriesPosition, year, narrator
- `notifierTypeSchema` / `createNotifierSchema` / `updateNotifierSchema` / `createNotifierFormSchema`

## Frontend Wiring
<!-- last-updated: 2026-02-14 -->

**Routes** (`App.tsx`): `/` → redirect to `/library`, `/library`, `/search`, `/activity`, `/books/:id`, `/authors/:asin`, `/settings/*`

**Nav** (`Layout.tsx`): Library, Search, Activity, Settings (with icons)

**Pages**: `LibraryPage`, `SearchPage`, `ActivityPage`, `SettingsPage`, `BookPage`, `AuthorPage`

**Settings sub-routes** (`SettingsPage.tsx`): `/settings/indexers`, `/settings/download-clients`, `/settings/notifications`, `/settings/general`

## Recent Changes
<!-- last-updated: 2026-02-14 -->

- PR #102 — #12 Implement blacklist functionality: BlacklistService CRUD, search result filtering, blacklist button in SearchReleasesModal, Settings > Blacklist management page, 16 new tests
- PR #101 — #41 Fix turbo test warnings and gitignore nul file: removed coverage/** from test outputs, added nul to .gitignore
- PR #100 — #79 Notification/Connect system: WebhookNotifier, DiscordNotifier, ScriptNotifier adapters; NotifierService with fan-out notify; fire-and-forget integration at 4 event points; Settings > Notifications UI; 44 new tests
- PR #99 — #77 Directory-based library import: LibraryScanService with folder name parsing, scan/confirm routes, ImportLibraryModal with multi-step flow
- PR #98 — #59 Transmission download client adapter: JSON-RPC, session-id CSRF rotation, Basic Auth, status mapping
- PR #97 — #57 Torznab indexer adapter: TorznabIndexer with torrent-specific fields (seeders, leechers, infoHash), magnet URI fallback, service wiring
- PR #96 — #61 NZBGet download client adapter (open)
- PR #95 — #60 SABnzbd download client adapter (open)
- PR #94 — #58 Newznab indexer adapter (open)
- PR #93 — #62 Type-specific settings forms for indexers and download clients
