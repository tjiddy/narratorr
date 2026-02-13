# Narratorr Codebase Audit Report

**Date:** 2026-02-13
**Scope:** Full sweep — error handling, logging, consistency, duplication, React best practices, test coverage, DB schema

---

## Table of Contents

1. [Error Handling](#1-error-handling)
2. [Logging Gaps](#2-logging-gaps)
3. [Code Duplication](#3-code-duplication)
4. [Long Files & Component Extraction](#4-long-files--component-extraction)
5. [React Best Practices](#5-react-best-practices)
6. [Core Adapter Issues](#6-core-adapter-issues)
7. [Database & Schema](#7-database--schema)
8. [Test Coverage Gaps](#8-test-coverage-gaps)
9. [Prioritized Action Plan](#9-prioritized-action-plan)

---

## 1. Error Handling

### 1.1 Routes Missing try-catch (HIGH)

Most route handlers call services directly without error handling. If a service throws unexpectedly, the error is an unhandled promise rejection.

**activity.ts — 3 unprotected endpoints:**
```typescript
// Line 8 — no try-catch
app.get('/api/activity', async (request) => {
  const { status } = request.query as { status?: string };
  return downloadService.getAll(status);  // throws = unhandled
});

// Line 13 — no try-catch
app.get('/api/activity/active', async () => {
  return downloadService.getActive();
});
```

**books.ts — GET/PUT unprotected:**
```typescript
// Line 39 — no try-catch
app.get('/api/books/:id', async (request, reply) => {
  const id = parseInt((request.params as { id: string }).id, 10);
  const book = await bookService.getById(id);  // throws = unhandled
  if (!book) return reply.status(404).send({ error: 'Book not found' });
  return book;
});

// Line 103 — no try-catch
app.put('/api/books/:id', async (request, reply) => {
  // ...
  const updated = await bookService.update(id, data);  // throws = unhandled
});
```

**Also affected:** `metadata.ts` (3 endpoints), `indexers.ts` (4 endpoints), `download-clients.ts` (4 endpoints), `settings.ts` (PUT)

**Fix pattern:**
```typescript
app.get('/api/books/:id', async (request, reply) => {
  try {
    const id = parseInt((request.params as { id: string }).id, 10);
    const book = await bookService.getById(id);
    if (!book) return reply.status(404).send({ error: 'Book not found' });
    return book;
  } catch (error) {
    request.log.error(error, 'Failed to get book');
    return reply.status(500).send({ error: 'Internal server error' });
  }
});
```

### 1.2 Input Validation Inconsistency (MEDIUM)

Some routes use Zod schemas for validation (download-clients, indexers, search, metadata, settings) while others do manual parsing (books, activity).

**activity.ts — manual parseInt without validation:**
```typescript
// Lines 18, 30 — parseInt returns NaN for "abc", then service gets NaN as ID
const id = parseInt(request.params.id, 10);
```

**books.ts — manual validation instead of schema:**
```typescript
// Line 53-54 — manual check
if (!data.title) {
  return reply.status(400).send({ error: 'Title is required' });
}
```

**Fix:** Add Zod schemas for books and activity routes (like download-clients already has `idParamSchema`).

### 1.3 books.ts Delete Loop (MEDIUM)

```typescript
// Lines 119-125 — if one cancel fails, remaining cancels may not execute
for (const download of activeDownloads) {
  await downloadService.cancel(download.id);  // no individual error handling
}
```

**Fix:** Wrap each cancel in try-catch so one failure doesn't block others.

### 1.4 Server Startup (MEDIUM)

**config.ts — no PORT validation:**
```typescript
// Current — NaN silently passes
const port = parseInt(process.env.PORT || '3000', 10);

// Fix
const port = parseInt(process.env.PORT || '3000', 10);
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
```

**index.ts:114 — untyped catch:**
```typescript
// Current
catch((err) => { console.error(...) })

// Fix
catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Failed to start server:', message);
  process.exit(1);
});
```

---

## 2. Logging Gaps

### 2.1 SettingsService Has No Logger (HIGH)

`SettingsService` is the only service that doesn't receive a logger in its constructor. All `set()` and `update()` calls are completely silent.

**routes/index.ts — missing injection:**
```typescript
// Current
const settings = new SettingsService(db);

// Fix
const settings = new SettingsService(db, log);
```

**settings.service.ts — add logger:**
```typescript
// Current
constructor(private db: Db) {}

// Fix
constructor(private db: Db, private log: FastifyBaseLogger) {}

async set<K extends keyof AppSettings>(category: K, value: AppSettings[K]) {
  this.log.info({ category }, 'Settings updated');
  // ... existing logic
}
```

### 2.2 Missing Info-Level Logs (CRUD per CLAUDE.md)

| Service | Method | Current Level | Should Be |
|---------|--------|---------------|-----------|
| `BookService.update()` (L153) | No log | — | `info` |
| `DownloadService.updateProgress()` (L172) | No log | — | `info` on completion |
| `DownloadClientService.update()` (L65) | `debug` | `info` |
| `IndexerService.update()` (L36) | `debug` | `info` |

### 2.3 Missing Error Context in Logs

```typescript
// download-clients.ts:99 — missing { id }
request.log.error(error, 'Failed to delete download client');
// Fix:
request.log.error({ id, error }, 'Failed to delete download client');

// indexers.ts:96 — same issue
request.log.error(error, 'Failed to delete indexer');

// activity.ts:72 — missing download ID
request.log.error(error, 'Retry failed');
// Fix:
request.log.error({ id, error }, 'Retry failed');
```

### 2.4 Debug Logging Opportunities

**Routes — log request params:**
```typescript
app.get('/api/books', async (request) => {
  const { status } = request.query as { status?: string };
  request.log.debug({ status }, 'Fetching books');
  // ...
});
```

**Services — log method entry:**
```typescript
async grab(params: GrabParams) {
  this.log.debug({ bookId: params.bookId, indexer: params.indexerName }, 'Starting grab');
  // ...
}
```

**Frontend — log API calls:**
```typescript
const { data: books } = useQuery({
  queryKey: ['books'],
  queryFn: async () => {
    console.debug('[API] Fetching books...');
    const result = await api.getBooks();
    console.debug('[API] Books fetched:', result.length);
    return result;
  },
});
```

---

## 3. Code Duplication

### 3.1 Frontend — Duplicated Utility Functions (HIGH)

**`formatDuration()` — identical in 3 files:**

- `SearchPage.tsx:208-215`
- `BookPage.tsx:10-17`
- `AuthorPage.tsx:13-20`

```typescript
function formatDuration(minutes?: number): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
```

**`mapBookMetadataToPayload()` — identical in 2 files:**

- `SearchPage.tsx:588-604`
- `AuthorPage.tsx:22-38`

```typescript
function mapBookMetadataToPayload(book: BookMetadata): CreateBookPayload {
  const author = book.authors[0];
  return {
    title: book.title,
    authorName: author?.name,
    // ... 10+ fields
  };
}
```

**`isBookInLibrary()` — identical in 2 files:**

- `SearchPage.tsx:606-615`
- `AuthorPage.tsx:40-49`

**Fix:** Create `src/client/lib/helpers.ts` and import everywhere.

### 3.2 Frontend — Inline Icon Definitions (HIGH)

Icon components are redefined in nearly every page file despite `icons.tsx` existing:

- `LibraryPage.tsx:22-103` — ~80 lines of icon SVGs
- `SearchPage.tsx:13-203` — ~190 lines of icon SVGs
- `ActivityPage.tsx:4-215` — ~210 lines of icon SVGs
- `BookPage.tsx:25-49` — icon definitions
- `AuthorPage.tsx` — more icon definitions

**Fix:** Add missing icons to `@/components/icons.tsx`, update all imports.

### 3.3 Frontend — Status Config Objects (MEDIUM)

Similar status color/label/icon mappings in:
- `LibraryPage.tsx:119-145`
- `ActivityPage.tsx:217-276`
- `BookPage.tsx:108-114`

**Fix:** Extract to `lib/status.ts`:
```typescript
export const BOOK_STATUS_CONFIG = { wanted: { label, color, icon }, ... };
export const DOWNLOAD_STATUS_CONFIG = { queued: { label, color, icon }, ... };
```

### 3.4 Frontend — Image Error Handling (MEDIUM)

Same pattern in 8+ components:
```typescript
const [imageError, setImageError] = useState(false);

{imageError ? (
  <div className="...">placeholder</div>
) : (
  <img src={url} onError={() => setImageError(true)} />
)}
```

**Fix:** Extract `useImageError()` hook.

### 3.5 Frontend — Delete Confirmation Pattern (MEDIUM)

Repeated in `LibraryPage` and `SettingsPage`:
```typescript
const [deleteTarget, setDeleteTarget] = useState<T | null>(null);
const deleteMutation = useMutation({...});
// ... render ConfirmModal
```

**Fix:** Extract `useDeleteConfirmation(mutationFn)` hook.

### 3.6 Backend — Join+Map Pattern (MEDIUM)

Repeated 7 times across `BookService` and `DownloadService`:

**BookService — repeated 3 times (getAll, getById, findDuplicate):**
```typescript
const results = await this.db
  .select({ book: books, author: authors })
  .from(books)
  .leftJoin(authors, eq(books.authorId, authors.id))
  // ... different WHERE clause each time
results.map((r) => ({ ...r.book, author: r.author || undefined }))
```

**DownloadService — repeated 3-4 times (getAll, getById, getActive, getActiveByBookId):**
```typescript
const results = await this.db
  .select({ download: downloads, book: books })
  .from(downloads)
  .leftJoin(books, eq(downloads.bookId, books.id))
  // ... different WHERE clause each time
results.map((r) => ({ ...r.download, book: r.book || undefined }))
```

**Fix:** Extract private helpers:
```typescript
// BookService
private mapBookWithAuthor(rows: { book: BookRow; author: AuthorRow | null }[]) {
  return rows.map((r) => ({ ...r.book, author: r.author || undefined }));
}

// DownloadService
private mapDownloadWithBook(rows: { download: DownloadRow; book: BookRow | null }[]) {
  return rows.map((r) => ({ ...r.download, book: r.book || undefined }));
}
```

### 3.7 Backend — qBittorrent Repeated Request Pattern (LOW)

`qbittorrent.ts` lines 172-196: pause/resume/remove all follow identical pattern:
```typescript
await this.request('/api/v2/torrents/{action}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ hashes: hash.toLowerCase() }),
});
```

**Fix:** Extract `torrentAction(action: string, hash: string)` helper.

### 3.8 Backend — 404 Check Pattern (LOW)

Repeated ~12 times across routes:
```typescript
if (!entity) {
  return reply.status(404).send({ error: 'Entity not found' });
}
```

Could extract as Fastify plugin/decorator, but low priority since it's simple.

---

## 4. Long Files & Component Extraction

| File | Lines | Suggested Extractions |
|------|-------|-----------------------|
| `SearchPage.tsx` | **950** | `DiscoverResults.tsx`, `IndexerResults.tsx`, `AuthorCard.tsx`, `DiscoverBookCard.tsx`, `IndexerResultCard.tsx` |
| `SettingsPage.tsx` | **797** | `settings/GeneralSettings.tsx`, `settings/IndexersSettings.tsx`, `settings/DownloadClientsSettings.tsx` |
| `LibraryPage.tsx` | **694** | `LibraryToolbar.tsx`, `LibraryBookCard.tsx`, `useLibraryFilters` hook |
| `AuthorPage.tsx` | **588** | `SeriesSection.tsx`, `BookRow.tsx` |
| `ActivityPage.tsx` | **552** | `DownloadCard.tsx` |
| `BookPage.tsx` | **305** | Borderline — could split hero section but acceptable |

### Reusable Components to Create

**EmptyState component** — repeated pattern across pages:
```tsx
// Used in LibraryPage (EmptyLibraryState, NoMatchState), SearchPage (EmptyState), etc.
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="w-12 h-12 text-muted-foreground/50 mb-4" />
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="text-muted-foreground mt-1">{description}</p>
      {action}
    </div>
  );
}
```

---

## 5. React Best Practices

### 5.1 Unnecessary Re-renders (MEDIUM)

**LibraryPage.tsx:322-335** — new callbacks created on every render in `.map()`:
```typescript
{filteredBooks.map((book, index) => (
  <LibraryBookCard
    key={book.id}
    book={book}
    onMenuToggle={(e) => { e.stopPropagation(); setOpenMenuId(...) }}  // new fn every render
    onDelete={() => setDeleteTarget(book)}  // new fn every render
    // ...
  />
))}
```

**Fix:** Use `useCallback` with book ID parameter, or pass setters directly and let child component handle.

### 5.2 Inconsistent Error Feedback (LOW)

**SearchPage.tsx:262** uses `alert()`:
```typescript
if (!result.downloadUrl) {
  alert('No download link available for this result');  // should be toast.error()
  return;
}
```

Rest of app uses `toast.error()`. Replace for consistency.

### 5.3 Unconditional Polling (MEDIUM)

**ActivityPage.tsx:281-285** — polls every 5s even when no downloads are active:
```typescript
const { data: downloads = [], isLoading } = useQuery({
  queryKey: ['activity'],
  queryFn: api.getActivity,
  refetchInterval: 5000,  // always polling
});
```

**Fix:**
```typescript
refetchInterval: downloads.some(d =>
  ['queued', 'downloading', 'importing'].includes(d.status)
) ? 5000 : false,
```

### 5.4 Missing Accessibility (LOW)

- `ConfirmModal` — missing `role="dialog"`, `aria-labelledby`, `aria-describedby`
- `LibraryPage` context menu — no keyboard navigation (Escape, arrow keys)
- `SearchPage` mode toggle buttons — missing `aria-label`
- `ActivityPage` action buttons — missing `aria-label`

### 5.5 Type Safety Issues (LOW)

**SettingsPage.tsx:471,754** — unsafe type assertions:
```typescript
(indexer.settings as { hostname?: string }).hostname || indexer.type
(client.settings as { host?: string; port?: number }).host
```

**Fix:** Use type guards or safe access:
```typescript
function getSettingsField<T>(settings: unknown, field: string): T | undefined {
  if (typeof settings === 'object' && settings !== null && field in settings) {
    return (settings as Record<string, unknown>)[field] as T;
  }
  return undefined;
}
```

### 5.6 Other React Items

- **No `loading="lazy"` on images** — add to all `<img>` tags for book covers
- **No query key factory** — keys are scattered string arrays. Create:
  ```typescript
  export const queryKeys = {
    books: () => ['books'] as const,
    book: (id: number) => ['books', id] as const,
    activity: () => ['activity'] as const,
    search: (q: string) => ['search', q] as const,
  };
  ```
- **`SearchPage` two-state search** — `query` and `searchTerm` maintained separately. Could consolidate with debounced pattern.
- **`api.ts:32`** — silently catches JSON parse errors. Add `console.warn`.

---

## 6. Core Adapter Issues

### 6.1 qBittorrent Client (HIGH)

**Infinite retry loop (line 91-95):**
```typescript
if (response.status === 403) {
  await this.login();
  return this.request<T>(path, options);  // recursive, no depth limit
}
```
**Fix:** Add `retries` parameter, max 1.

**JSON type violation (line 102-111):**
```typescript
try {
  return JSON.parse(text) as T;
} catch {
  return text as T;  // returns string typed as T — violates contract
}
```
**Fix:** Throw on parse failure, or validate before returning.

**base32ToHex (line 263-279) — no input validation:**
```typescript
// Silently skips invalid chars, no length check
```
**Fix:** Validate `base32.length === 32` before processing.

**Unsafe non-null assertion (line 86):**
```typescript
Cookie: this.cookie!  // should check before using
```

### 6.2 AudioBookBay Indexer (MEDIUM)

**Uses console.warn instead of throwing (lines 58, 72):**
```typescript
catch (err) {
  console.warn('Failed to fetch details:', err);  // violates CLAUDE.md
}
```
**Fix:** Throw errors — the calling service handles logging.

**parseSize with potentially undefined match groups (line 250-251):**
```typescript
result.size = this.parseSize(sizeMatch[1], sizeMatch[2]);  // groups could be undefined
```
**Fix:** Guard: `if (sizeMatch?.[1] && sizeMatch?.[2]) result.size = this.parseSize(...)`

### 6.3 Audnexus Provider (MEDIUM)

**fetchJson swallows all errors (line 128-136):**
```typescript
private async fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;  // 404? 500? timeout? all null
    return await response.json() as T;
  } catch {
    return null;  // network error? parse error? all null
  }
}
```
**Fix:** Throw specific errors so calling service can log meaningfully.

**Deduplication flaw (line 50-56):**
```typescript
const key = item.asin ?? item.name ?? '';  // items with no asin/name all map to ''
```
**Fix:** Use `item.asin ?? item.name ?? \`unnamed_${index}\``

### 6.4 Hardcover Provider (MEDIUM)

**test() duplicates gql() error handling (lines 287-334):**
```typescript
// test() has its own fetch + error handling
// gql() has identical fetch + error handling
```
**Fix:** Have `test()` use `gql()` internally.

**Unsafe type assertions in mappers (lines 524-554):**
```typescript
const title = doc.title as string;
const authors = doc.author_names as string[] | undefined;
```
**Fix:** Define concrete interfaces for search documents instead of `Record<string, unknown>`.

### 6.5 Cross-Adapter Consistency

| Adapter | HTTP Pattern | Error Strategy | Issue |
|---------|-------------|----------------|-------|
| abb.ts | Direct fetch | console.warn (swallows) | Should throw |
| qbittorrent.ts | Private request() | Throws on !ok | Good (except JSON issue) |
| audnexus.ts | Private fetchJson() | Returns null | Silent failures |
| hardcover.ts | Private gql() | Returns null | Silent failures |

No unified error strategy. Metadata providers return null (acceptable for optional enrichment), but indexers/download clients should throw.

---

## 7. Database & Schema

### 7.1 Missing Indexes (HIGH — easy win)

```sql
-- These columns are queried frequently but have no indexes
CREATE INDEX idx_books_author_id ON books(author_id);
CREATE INDEX idx_books_status ON books(status);
CREATE INDEX idx_downloads_status ON downloads(status);
CREATE INDEX idx_downloads_book_id ON downloads(book_id);
CREATE INDEX idx_indexers_enabled ON indexers(enabled);
CREATE INDEX idx_download_clients_enabled ON download_clients(enabled);
CREATE INDEX idx_search_history_searched_at ON search_history(searched_at);
```

### 7.2 Enum Duplication (MEDIUM)

Indexer types defined in both Drizzle and Zod:
```typescript
// packages/db/src/schema.ts L64
type: text('type', { enum: ['abb', 'torznab', 'newznab'] }).notNull(),

// apps/narratorr/src/shared/schemas.ts L25
export const indexerTypeSchema = z.enum(['abb', 'torznab', 'newznab']);
```

**Fix:** Extract to shared constants:
```typescript
// shared/constants.ts
export const INDEXER_TYPES = ['abb', 'torznab', 'newznab'] as const;
```

### 7.3 Settings Type Duplication (MEDIUM)

`AppSettings` defined independently in:
- `services/settings.service.ts` (TypeScript interface)
- `shared/schemas.ts` (Zod schema)
- `client/lib/api.ts` (client interface)

Three sources of truth. Should derive all from Zod schema.

### 7.4 Foreign Key Policies (LOW)

All foreign keys use `ON DELETE no action` — deleting an author orphans books, deleting a book orphans downloads. Consider:
- `books.authorId` → `ON DELETE SET NULL`
- `downloads.bookId` → `ON DELETE CASCADE`

### 7.5 Query Optimization (LOW)

**BookService.findDuplicate()** — 2-3 separate queries could be one:
```typescript
// Current: separate query by ASIN, then by title+author
// Fix: combine with OR
.where(or(
  eq(books.asin, asin),
  and(eq(books.title, title), eq(authors.slug, authorSlug))
))
```

**DownloadClientService.getFirstEnabledForProtocol()** — fetches all then filters in JS:
```typescript
// Fix: add SQL filter
.where(and(eq(downloadClients.enabled, true), eq(downloadClients.type, protocol)))
.orderBy(downloadClients.priority)
.limit(1)
```

---

## 8. Test Coverage Gaps

### Current Coverage: ~80% of meaningful source files

### Missing Tests — Priority Order

| File | Type | Priority | Risk |
|------|------|----------|------|
| `server/jobs/monitor.ts` | Background job | **CRITICAL** | Complex state machine: syncs downloads, updates book status, handles completion. No tests at all. |
| `client/pages/ActivityPage.tsx` | React page | **HIGH** | Complex page with polling, cancel/retry mutations, filtering. No tests. |
| `core/download-clients/qbittorrent.ts` | Adapter | **HIGH** | Login flow, hash conversion, session recovery, state mapping. No tests. |
| `server/routes/system.ts` | Routes | MEDIUM | Health check endpoints. Simple but untested. |
| `client/hooks/useLibrary.ts` | Hook | MEDIUM | Library query hook. |
| `client/components/TestButton.tsx` | Component | LOW | UI variant component. |
| `client/components/TestResultMessage.tsx` | Component | LOW | Display component. |

### Existing Test Quality Assessment

**Strengths:**
- Backend services: excellent mock DB patterns, edge case coverage
- API routes: proper Fastify `inject()`, happy + error paths
- Core adapters: MSW HTTP mocking, real HTML fixtures for parsing
- Frontend: Testing Library best practices, proper async/waitFor

**Weaknesses:**
- Some tests cover happy path only, missing error path coverage
- No snapshot tests (could help catch UI regressions in large components)

---

## 9. Prioritized Action Plan

### Tier 1 — High Impact, Fix First

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | Add try-catch to all route handlers | 7 route files | Medium |
| 2 | Fix qBittorrent infinite retry + JSON type safety | `qbittorrent.ts` | Small |
| 3 | Add database indexes | `schema.ts` + migration | Small |
| 4 | Inject logger into SettingsService | `settings.service.ts`, `routes/index.ts` | Small |
| 5 | Extract duplicated utils (`formatDuration`, `isBookInLibrary`, `mapBookMetadataToPayload`) | Create `lib/helpers.ts`, update 3 pages | Small |
| 6 | Write tests for `monitor.ts` job | New test file | Medium |
| 7 | Migrate inline icons to `@/components/icons` | All page files | Medium (tedious) |

### Tier 2 — Medium Impact, Good Improvements

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 8 | Split SearchPage (950 lines) | New component files | Medium |
| 9 | Split SettingsPage (797 lines) | New component files | Medium |
| 10 | Split LibraryPage (694 lines) + extract `useLibraryFilters` | New files + hook | Medium |
| 11 | Add debug logging throughout services and routes | All service/route files | Medium |
| 12 | Fix abb.ts to throw instead of console.warn | `abb.ts` | Small |
| 13 | Extract custom hooks (`useImageError`, `useDeleteConfirmation`) | New hook files | Small |
| 14 | Write tests for ActivityPage, qbittorrent.ts | New test files | Medium |
| 15 | Extract shared enum constants (single source of truth) | New constants file | Small |
| 16 | Fix unconditional activity polling | `ActivityPage.tsx` | Small |
| 17 | Extract status config objects to `lib/status.ts` | New file, update pages | Small |

### Tier 3 — Polish

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 18 | Add accessibility (aria-*, keyboard nav, dialog roles) | Modal, menu components | Medium |
| 19 | Add `loading="lazy"` to images | All image tags | Small |
| 20 | Create query key factory | New file, update queries | Small |
| 21 | Add max length to search query schema | `schemas.ts` | Small |
| 22 | Validate PORT in config.ts | `config.ts` | Small |
| 23 | Add cascading delete policies | Schema migration | Small |
| 24 | Consolidate AppSettings type (derive from Zod) | 3 files | Small |
| 25 | Fix Hardcover test() to use gql() helper | `hardcover.ts` | Small |
| 26 | Create reusable EmptyState component | New component | Small |
| 27 | Write tests for system.ts, useLibrary.ts | New test files | Small |
| 28 | Fix audnexus deduplication flaw | `audnexus.ts` | Small |
| 29 | Extract backend join+map helpers | `book.service.ts`, `download.service.ts` | Small |
| 30 | Replace alert() with toast.error() in SearchPage | `SearchPage.tsx` | Small |