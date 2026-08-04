import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { CLIENT_STATUSES, PIPELINE_STAGES } from '@shared/schemas/activity';
import { SUGGESTION_REASONS } from '@shared/schemas/discovery';
import { BOOK_STATUSES, ENRICHMENT_STATUSES, PRODUCTION_TYPES } from '@shared/schemas/book';
import { BLACKLIST_REASONS } from '@shared/schemas/blacklist';
import { COMPANION_EBOOK_STATUSES } from '@shared/schemas/companion-ebook';
import { INDEXER_TYPES } from '@shared/indexer-registry';
import { DOWNLOAD_CLIENT_TYPES } from '@shared/download-client-registry';
import { NOTIFIER_TYPES } from '@shared/notifier-registry';
import { IMPORT_LIST_TYPES } from '@shared/import-list-registry';
import { CONNECTOR_TYPES } from '@shared/connector-registry';
import { IMPORT_JOB_TYPES, IMPORT_JOB_STATUSES, IMPORT_JOB_PHASES } from '@shared/schemas/import-job';
import { PROTOCOLS } from '@shared/schemas/download-protocol';
import { SUBMISSION_STATUSES, SUBMISSION_SOURCES, ITEM_DISPOSITIONS } from '@core/import-staging/schemas';
import type { StagedImportItem } from '@core/import-staging/schemas';
import type { NotificationEvent } from '@shared/notification-events';

// ============ LIBRARY ============

export const authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  asin: text('asin'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const narrators = sqliteTable('narrators', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const books = sqliteTable('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  description: text('description'),
  publisher: text('publisher'),
  coverUrl: text('cover_url'),
  asin: text('asin'),
  isbn: text('isbn'),
  seriesName: text('series_name'),
  seriesPosition: real('series_position'),
  duration: integer('duration'),
  publishedDate: text('published_date'),
  genres: text('genres', { mode: 'json' }).$type<string[]>(),
  status: text('status', {
    enum: BOOK_STATUSES,
  })
    .notNull()
    .default('wanted'),
  enrichmentStatus: text('enrichment_status', {
    enum: ENRICHMENT_STATUSES,
  })
    .notNull()
    .default('pending'),
  // Recording production form (#1710). Populated at manual-import/enrichment from
  // metadata `formatType` via `normalizeProductionType`; defaults to `unknown`
  // for every path that doesn't supply it. Additive, no behavior change in 1/3.
  productionType: text('production_type', {
    enum: PRODUCTION_TYPES,
  })
    .notNull()
    .default('unknown'),
  // Edition discriminator for multiple-narration coexistence (#1711, Multiple
  // Narrations 2/3). NULL/absent for single-recording books (their on-disk path
  // renders unchanged); set to a deterministic, stable-metadata-derived label
  // (primary narrator / production form) the first time a different-recording
  // path collision is disambiguated, so a rescan reuses the same folder rather
  // than re-deriving from later-enriched metadata and spawning a phantom folder.
  editionLabel: text('edition_label'),
  // Persisted count of background-enrichment failure attempts. Incremented on
  // every `failed`/no-match transition through markFailedGuarded so the
  // candidate query can cap unresolvable rows (they rest as terminal `failed`,
  // recoverable via manual Fix Match which resets the row to `pending`).
  enrichmentAttempts: integer('enrichment_attempts').notNull().default(0),
  // Operator-asserted absences (#2069) — a JSON-encoded array of the clearable
  // field names the operator explicitly emptied through Edit Metadata, so
  // fill-empty enrichment and the provider display fallback can tell "deliberately
  // removed" from "never had a value". SQL NULL means "no tombstones".
  //
  // Declared PLAIN TEXT, deliberately NOT `{ mode: 'json' }`: Drizzle's JSON-mode
  // mapper `JSON.parse`s unconditionally inside the driver, so one corrupt row
  // would throw on EVERY whole-row `books` select (download/quality-gate/discovery
  // included), not just the readers that care. Keeping the value inert until a
  // reader opts in is the same shape `import_jobs.phase_history` uses; the only
  // behavioral reader is `parseClearedFields` (src/server/utils/cleared-fields.ts),
  // which warn-and-degrades. Every in-app write goes through
  // `serializeClearedFields` (canonical: sorted, deduped, empty set → NULL).
  userClearedFields: text('user_cleared_fields'),
  path: text('path'),
  size: integer('size'),
  // Audio technical info (populated by file-based enrichment)
  audioCodec: text('audio_codec'),
  audioBitrate: integer('audio_bitrate'),
  audioSampleRate: integer('audio_sample_rate'),
  audioChannels: integer('audio_channels'),
  audioBitrateMode: text('audio_bitrate_mode'),
  audioFileFormat: text('audio_file_format'),
  audioFileCount: integer('audio_file_count'),
  topLevelAudioFileCount: integer('top_level_audio_file_count'),
  audioTotalSize: integer('audio_total_size'),
  audioDuration: integer('audio_duration'),
  // Last grab identifiers (populated from download record at import time, cleared on wrong-release)
  lastGrabGuid: text('last_grab_guid'),
  lastGrabInfoHash: text('last_grab_info_hash'),
  importListId: integer('import_list_id').references(() => importLists.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_books_status').on(table.status),
  index('idx_books_path').on(table.path),
  index('idx_books_enrichment_status').on(table.enrichmentStatus),
  // Case-insensitive durable ASIN identity (#1733). The unique index is on the
  // `upper(asin)` EXPRESSION (not the raw column) so it matches the resolver's
  // case-insensitive equality and the canonicalize-on-write boundary — a
  // case-drifted duplicate ('b0..' vs a stored 'B0..') is rejected at the DB.
  // The partial `WHERE asin IS NOT NULL` predicate is preserved so multiple
  // null-ASIN rows still coexist ([[sqlite-null-unique-index]]). Hand-managed via
  // drizzle/0000_baseline.sql (drizzle-kit can't auto-generate the expression index +
  // the data canonicalization/quarantine); keep this mirrored with that migration.
  uniqueIndex('idx_books_asin_unique').on(sql`upper(${table.asin})`).where(sql`asin IS NOT NULL`),
]);

export const bookAuthors = sqliteTable('book_authors', {
  bookId: integer('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => authors.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.bookId, table.authorId] }),
  index('idx_book_authors_author_id').on(table.authorId),
]);

export const bookNarrators = sqliteTable('book_narrators', {
  bookId: integer('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  narratorId: integer('narrator_id').notNull().references(() => narrators.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.bookId, table.narratorId] }),
  index('idx_book_narrators_narrator_id').on(table.narratorId),
]);

// ============ COMPANION EBOOKS ============

// Literal list for `ck_companion_ebooks_status_domain`, derived from the canonical
// tuple so the DB-level domain can never drift from the TS one. It goes through
// `sql.raw` below because a `${...}` interpolation would emit a bound parameter,
// which is not valid inside a CHECK in the generated DDL.
const COMPANION_EBOOK_STATUS_LITERALS = COMPANION_EBOOK_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * One-to-one companion-ebook observation per book (#1957, plan §2).
 *
 * `book_id` is `NOT NULL UNIQUE`, deliberately **not** `.primaryKey()`: on SQLite an
 * `INTEGER PRIMARY KEY` is a rowid alias, so an insert that omits the column (or passes
 * NULL) gets a value *generated* for it and silently attaches the observation to some
 * other real book — and Drizzle marks such columns `primaryKeyHasDefault`, making
 * `bookId` optional in `$inferInsert`. `.unique()` emits the separate
 * `companion_ebooks_book_id_unique` index, which is what serves lookups by book.
 *
 * Unit split: `created_at`/`updated_at` are `mode: 'timestamp'` (unix **seconds**, repo
 * convention), while `mtime_ms`/`ctime_ms` are raw **milliseconds** straight off
 * `fs.Stats` — writers must `Math.trunc` them, on both write and comparison, or the
 * fingerprint short-circuit silently never matches.
 *
 * Every CHECK predicate below must evaluate to 0 or 1 and never to NULL — SQLite treats
 * a NULL CHECK as satisfied, so a naive form lets half-set rows through. That holds
 * because `status`/`candidate_count` are NOT NULL, `ck_companion_ebooks_status_domain`
 * closes the status domain (so the `<>`/`NOT IN` guards are never vacuously true for an
 * unrecognised value), and every reference to a nullable column goes through a total
 * operator (`IS NULL`, `IS NOT NULL`, `typeof(...)`) or is guarded by an `IS NOT NULL`
 * term in the same conjunction.
 */
export const companionEbooks = sqliteTable('companion_ebooks', {
  bookId: integer('book_id').notNull().unique().references(() => books.id, { onDelete: 'cascade' }),
  status: text('status', { enum: COMPANION_EBOOK_STATUSES }).notNull(),
  /** Top-level basename only, never a path. */
  filename: text('filename'),
  sizeBytes: integer('size_bytes'),
  mtimeMs: integer('mtime_ms'),
  ctimeMs: integer('ctime_ms'),
  /** Authority is `EpubValidationCode` (src/core/epub, #1956); narrowed at the repository boundary. */
  validationCode: text('validation_code'),
  candidateCount: integer('candidate_count').notNull().default(0),
  /** The owner's pick when more than one candidate exists. */
  selectedFilename: text('selected_filename'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (t) => [
  // No constraint name may be a prefix of another: rejection tests assert *which*
  // invariant fired, and SQLite reports only the first failing constraint.
  check(
    'ck_companion_ebooks_status_domain',
    sql`${t.status} IN (${sql.raw(COMPANION_EBOOK_STATUS_LITERALS)})`,
  ),
  check(
    'ck_companion_ebooks_file_present',
    sql`${t.status} NOT IN ('available', 'invalid', 'drm_protected') OR (${t.filename} IS NOT NULL AND ${t.sizeBytes} IS NOT NULL AND ${t.mtimeMs} IS NOT NULL AND ${t.ctimeMs} IS NOT NULL)`,
  ),
  check(
    'ck_companion_ebooks_file_absent',
    sql`${t.status} NOT IN ('none', 'ambiguous') OR (${t.filename} IS NULL AND ${t.sizeBytes} IS NULL AND ${t.mtimeMs} IS NULL AND ${t.ctimeMs} IS NULL)`,
  ),
  check(
    'ck_companion_ebooks_validation_code',
    sql`(${t.status} <> 'invalid' OR ${t.validationCode} IS NOT NULL) AND (${t.status} = 'invalid' OR ${t.validationCode} IS NULL)`,
  ),
  // `typeof(...) = 'integer'` is the only thing that pins integer storage: a plain
  // `integer()` column has no mapToDriverValue and SQLite's INTEGER affinity keeps a
  // genuinely fractional value as a REAL.
  check(
    'ck_companion_ebooks_candidate_count',
    sql`typeof(${t.candidateCount}) = 'integer' AND ${t.candidateCount} >= 0 AND (${t.status} <> 'none' OR ${t.candidateCount} = 0) AND (${t.status} <> 'ambiguous' OR ${t.candidateCount} >= 2) AND (${t.status} NOT IN ('available', 'invalid', 'drm_protected') OR ${t.candidateCount} >= 1)`,
  ),
  // Forward implication: a selection, if present, is well-formed. Positive membership
  // plus the explicit `filename IS NOT NULL` guard is what keeps the trailing equality
  // from ever being reached with a NULL operand. Deliberately does not require
  // `candidate_count >= 2` — deleting the unselected sibling of a pair leaves a live
  // selection at count 1.
  check(
    'ck_companion_ebooks_selection',
    sql`${t.selectedFilename} IS NULL OR (${t.status} IN ('available', 'invalid', 'drm_protected') AND ${t.filename} IS NOT NULL AND ${t.selectedFilename} = ${t.filename})`,
  ),
  // Reverse implication: a row that resolved to one file while more than one candidate
  // is still on disk must record whose pick it was.
  check(
    'ck_companion_ebooks_multi_candidate_selection',
    sql`${t.status} NOT IN ('available', 'invalid', 'drm_protected') OR ${t.candidateCount} < 2 OR ${t.selectedFilename} IS NOT NULL`,
  ),
  // Timestamps are deliberately not floored at 0 — filesystem times are signed and a
  // user-preserved pre-1970 mtime is legitimate. Nonnegativity is a real invariant for
  // `size_bytes` only.
  check(
    'ck_companion_ebooks_fingerprint',
    sql`(${t.sizeBytes} IS NULL OR (typeof(${t.sizeBytes}) = 'integer' AND ${t.sizeBytes} >= 0)) AND (${t.mtimeMs} IS NULL OR typeof(${t.mtimeMs}) = 'integer') AND (${t.ctimeMs} IS NULL OR typeof(${t.ctimeMs}) = 'integer')`,
  ),
]);

// ============ SERIES ============

export const series = sqliteTable('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  hardcoverSeriesId: integer('hardcover_series_id'),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  authorName: text('author_name'),
  description: text('description'),
  imageUrl: text('image_url'),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('idx_series_hardcover_series_id_unique')
    .on(table.hardcoverSeriesId)
    .where(sql`hardcover_series_id IS NOT NULL`),
  index('idx_series_normalized_name').on(table.normalizedName),
]);

export const seriesMembers = sqliteTable('series_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  seriesId: integer('series_id').notNull().references(() => series.id, { onDelete: 'cascade' }),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  hardcoverBookId: integer('hardcover_book_id'),
  slug: text('slug'),
  imageUrl: text('image_url'),
  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  authorName: text('author_name'),
  position: real('position'),
  source: text('source', { enum: ['hardcover', 'local'] }).notNull().default('hardcover'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('idx_series_members_hardcover_book_unique')
    .on(table.seriesId, table.hardcoverBookId)
    .where(sql`hardcover_book_id IS NOT NULL`),
  uniqueIndex('idx_series_members_local_unique')
    .on(table.seriesId, table.bookId)
    .where(sql`hardcover_book_id IS NULL`),
  index('idx_series_members_series_id').on(table.seriesId),
  index('idx_series_members_book_id').on(table.bookId),
]);

// ============ INTEGRATIONS ============

export const indexers = sqliteTable('indexers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: INDEXER_TYPES }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(50),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  source: text('source'),
  sourceIndexerId: integer('source_indexer_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_indexers_enabled').on(table.enabled),
]);

export const downloadClients = sqliteTable('download_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: DOWNLOAD_CLIENT_TYPES }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(50),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_download_clients_enabled').on(table.enabled),
]);

export const remotePathMappings = sqliteTable('remote_path_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  downloadClientId: integer('download_client_id')
    .notNull()
    .references(() => downloadClients.id, { onDelete: 'cascade' }),
  remotePath: text('remote_path').notNull(),
  localPath: text('local_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_remote_path_mappings_client').on(table.downloadClientId),
]);

export const notifiers = sqliteTable('notifiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: NOTIFIER_TYPES }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  events: text('events', { mode: 'json' }).notNull().$type<NotificationEvent[]>(),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_notifiers_enabled').on(table.enabled),
]);

export const importLists = sqliteTable('import_lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: IMPORT_LIST_TYPES }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(1440),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  lastSyncError: text('last_sync_error'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_import_lists_enabled').on(table.enabled),
]);

export const connectors = sqliteTable('connectors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: CONNECTOR_TYPES }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_connectors_enabled').on(table.enabled),
]);

// ============ ACTIVITY ============

export const downloads = sqliteTable('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  indexerId: integer('indexer_id').references(() => indexers.id, { onDelete: 'set null' }),
  downloadClientId: integer('download_client_id').references(() => downloadClients.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  protocol: text('protocol', { enum: PROTOCOLS }).notNull().default('torrent'),
  infoHash: text('info_hash'),
  downloadUrl: text('download_url'),
  size: integer('size'),
  seeders: integer('seeders'),
  // Two-axis download state (#1445). `clientStatus` is pure download-client
  // truth (written only by the poller); `pipelineStage` is narratorr's
  // processing overlay (written only by the quality-gate / import pipeline).
  // The legacy single `status` column was split + backfilled into this pair;
  // the derived display status (`deriveDisplayStatus`) is computed from it.
  clientStatus: text('client_status', {
    enum: CLIENT_STATUSES,
  })
    .notNull()
    .default('queued'),
  pipelineStage: text('pipeline_stage', {
    enum: PIPELINE_STAGES,
  })
    .notNull()
    .default('idle'),
  progress: real('progress').notNull().default(0),
  externalId: text('external_id'),
  errorMessage: text('error_message'),
  guid: text('guid'),
  outputPath: text('output_path'),
  // Pre-grab snapshot of `books.status` captured by DownloadOrchestrator BEFORE
  // it flips the book to `downloading`/`missing`. The quality gate reads this
  // (#1144) to distinguish a user-initiated wanted-flow grab from an auto-upgrade
  // replacement, both of which arrive at the gate with `book.status === 'importing'`.
  // Nullable so pre-migration rows coexist; null is treated as `'imported'` (conservative).
  bookStatusAtGrab: text('book_status_at_grab', { enum: BOOK_STATUSES }),
  addedAt: integer('added_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  progressUpdatedAt: integer('progress_updated_at', { mode: 'timestamp' }),
  pendingCleanup: integer('pending_cleanup', { mode: 'timestamp' }),
}, (table) => [
  index('idx_downloads_status').on(table.clientStatus, table.pipelineStage),
  index('idx_downloads_status_completed').on(table.clientStatus, table.completedAt),
  index('idx_downloads_book_id').on(table.bookId),
  index('idx_downloads_pending_cleanup').on(table.pendingCleanup),
]);

// ============ EVENT HISTORY ============

export const bookEvents = sqliteTable('book_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  downloadId: integer('download_id').references(() => downloads.id, { onDelete: 'set null' }),
  bookTitle: text('book_title').notNull(),
  authorName: text('author_name'),
  narratorName: text('narrator_name'),
  eventType: text('event_type', {
    enum: [
      'grabbed', 'download_completed', 'download_failed',
      'imported', 'import_failed',
      'deleted', 'renamed', 'merged',
      'file_tagged', 'held_for_review',
      'merge_started', 'merge_failed',
      'wrong_release',
      'book_added',
      'metadata_fixed',
      'grab_failed',
      'recording_review_skipped',
      'search_relaxed_held',
    ],
  }).notNull(),
  source: text('source', {
    enum: ['manual', 'rss', 'scheduled', 'auto', 'import_list'],
  }).notNull().default('auto'),
  reason: text('reason', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_book_events_book_id').on(table.bookId),
  index('idx_book_events_book_id_created_at').on(table.bookId, table.createdAt),
  index('idx_book_events_event_type').on(table.eventType),
  index('idx_book_events_created_at').on(table.createdAt),
  index('idx_book_events_download_id_event_type').on(table.downloadId, table.eventType),
]);

// ============ SEARCH & BLACKLIST ============

export const blacklist = sqliteTable('blacklist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  infoHash: text('info_hash'),
  guid: text('guid'),
  title: text('title').notNull(),
  reason: text('reason', { enum: [...BLACKLIST_REASONS] }).notNull().default('other'),
  note: text('note'),
  blacklistType: text('blacklist_type', { enum: ['temporary', 'permanent'] }).notNull().default('permanent'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  blacklistedAt: integer('blacklisted_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('idx_blacklist_info_hash_unique').on(table.infoHash).where(sql`info_hash IS NOT NULL`),
  uniqueIndex('idx_blacklist_guid_unique').on(table.guid).where(sql`guid IS NOT NULL`),
  index('idx_blacklist_book_id').on(table.bookId),
]);

// ============ TELEMETRY ============

export const unmatchedGenres = sqliteTable('unmatched_genres', {
  genre: text('genre').primaryKey(),
  count: integer('count').notNull().default(1),
  lastSeen: integer('last_seen', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ============ AUTH ============

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ============ DISCOVERY ============

export const suggestions = sqliteTable('suggestions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  asin: text('asin').notNull(),
  title: text('title').notNull(),
  authorName: text('author_name').notNull(),
  authorAsin: text('author_asin'),
  narratorName: text('narrator_name'),
  coverUrl: text('cover_url'),
  duration: integer('duration'),
  publishedDate: text('published_date'),
  language: text('language'),
  genres: text('genres', { mode: 'json' }).$type<string[]>(),
  seriesName: text('series_name'),
  seriesPosition: real('series_position'),
  reason: text('reason', { enum: SUGGESTION_REASONS }).notNull(),
  reasonContext: text('reason_context').notNull(),
  score: real('score').notNull(),
  status: text('status', { enum: ['pending', 'added', 'dismissed'] })
    .notNull()
    .default('pending'),
  refreshedAt: integer('refreshed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('idx_suggestions_status_score').on(table.status, table.score),
  uniqueIndex('idx_suggestions_asin_unique').on(table.asin),
]);

// ============ IMPORT QUEUE ============

export const importJobs = sqliteTable('import_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  type: text('type', { enum: IMPORT_JOB_TYPES }).notNull(),
  status: text('status', { enum: IMPORT_JOB_STATUSES }).notNull().default('pending'),
  phase: text('phase', { enum: IMPORT_JOB_PHASES }).default('queued'),
  metadata: text('metadata').notNull(),
  phaseHistory: text('phase_history'),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (table) => [
  index('idx_import_jobs_status_created').on(table.status, table.createdAt),
  uniqueIndex('idx_import_jobs_book_active')
    .on(table.bookId)
    .where(sql`status IN ('pending', 'processing')`),
]);

// ============ IMPORT STAGING (#1893) ============

// Inert staged-upload header. A finalized header (status processing/complete) is
// retained INDEFINITELY (the durable record outlives item details); a never-
// finalized 'receiving' header is inert and GC-eligible (48h stale sweep). The
// terminal aggregate counts freeze at completion and survive item-row pruning.
export const importSubmissions = sqliteTable('import_submissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientSubmissionId: text('client_submission_id').notNull().unique(),
  payloadDigest: text('payload_digest').notNull(),
  source: text('source', { enum: SUBMISSION_SOURCES }).notNull(),
  mode: text('mode', { enum: ['copy', 'move'] }),
  expectedCount: integer('expected_count').notNull(),
  status: text('status', { enum: SUBMISSION_STATUSES }).notNull().default('receiving'),
  receivedCount: integer('received_count').notNull().default(0),
  // Cumulative persisted staged-JSON bytes accumulator (F58). Updated in the same
  // PUT transaction as the ordinal writes; a re-PUT of an existing ordinal adds 0.
  receivedBytes: integer('received_bytes').notNull().default(0),
  acceptedCount: integer('accepted_count').notNull().default(0),
  heldCount: integer('held_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (table) => [
  index('idx_import_submissions_status_updated').on(table.status, table.updatedAt),
  // Newest-first reads (#1894). `(source, createdAt, id)` backs the source-filtered
  // latest/attention reads (`WHERE source=? ORDER BY createdAt DESC, id DESC`);
  // `(createdAt, id)` backs the unfiltered cross-source Activity list + Library
  // attention read (a source-leading index cannot serve a global newest order).
  index('idx_import_submissions_source_created_id').on(table.source, table.createdAt, table.id),
  index('idx_import_submissions_created_id').on(table.createdAt, table.id),
]);

// Per-ordinal staged item. `itemPayload` holds the strict staged item; `path`/
// `title` are projected columns (always non-null, independent of payload nulling)
// used for indexing/display/GC. `bookId` is the created placeholder for an
// `accepted` row (set-null on later book delete, disposition stays accepted, F50);
// `existingBookId` is the incumbent owned book for a held/skipped row.
export const importSubmissionItems = sqliteTable('import_submission_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  submissionId: integer('submission_id')
    .notNull()
    .references(() => importSubmissions.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  itemPayload: text('item_payload', { mode: 'json' }).$type<StagedImportItem>(),
  path: text('path').notNull(),
  title: text('title').notNull(),
  disposition: text('disposition', { enum: ITEM_DISPOSITIONS }).notNull().default('pending'),
  reason: text('reason'),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  existingBookId: integer('existing_book_id').references(() => books.id, { onDelete: 'set null' }),
  existingTitle: text('existing_title'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('idx_import_submission_items_ordinal_unique').on(table.submissionId, table.ordinal),
  index('idx_import_submission_items_submission_disposition').on(table.submissionId, table.disposition),
]);

// ============ SETTINGS ============

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull().$type<unknown>(),
});

export const settingsMigrations = sqliteTable('settings_migrations', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});
