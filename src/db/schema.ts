import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { DOWNLOAD_STATUSES } from '../shared/schemas/activity';
import { SUGGESTION_REASONS } from '../shared/schemas/discovery';
import { BOOK_STATUSES, ENRICHMENT_STATUSES } from '../shared/schemas/book';
import { BLACKLIST_REASONS } from '../shared/schemas/blacklist';
import { INDEXER_TYPES } from '../shared/indexer-registry';
import { DOWNLOAD_CLIENT_TYPES } from '../shared/download-client-registry';
import { NOTIFIER_TYPES } from '../shared/notifier-registry';
import { IMPORT_LIST_TYPES } from '../shared/import-list-registry';
import { IMPORT_JOB_TYPES, IMPORT_JOB_STATUSES, IMPORT_JOB_PHASES } from '../shared/schemas/import-job';
import type { NotificationEvent } from '../shared/notification-events';

// ============ LIBRARY ============

export const authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const books = sqliteTable('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  coverUrl: text('cover_url'),
  goodreadsId: text('goodreads_id'),
  audibleId: text('audible_id'),
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
  monitorForUpgrades: integer('monitor_for_upgrades', { mode: 'boolean' }).notNull().default(false),
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
  uniqueIndex('idx_books_asin_unique').on(table.asin).where(sql`asin IS NOT NULL`),
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

// ============ ACTIVITY ============

export const downloads = sqliteTable('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  indexerId: integer('indexer_id').references(() => indexers.id, { onDelete: 'set null' }),
  downloadClientId: integer('download_client_id').references(() => downloadClients.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  protocol: text('protocol', { enum: ['torrent', 'usenet'] }).notNull().default('torrent'),
  infoHash: text('info_hash'),
  downloadUrl: text('download_url'),
  size: integer('size'),
  seeders: integer('seeders'),
  status: text('status', {
    enum: DOWNLOAD_STATUSES,
  })
    .notNull()
    .default('queued'),
  progress: real('progress').notNull().default(0),
  externalId: text('external_id'),
  errorMessage: text('error_message'),
  guid: text('guid'),
  outputPath: text('output_path'),
  addedAt: integer('added_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  progressUpdatedAt: integer('progress_updated_at', { mode: 'timestamp' }),
  pendingCleanup: integer('pending_cleanup', { mode: 'timestamp' }),
}, (table) => [
  index('idx_downloads_status').on(table.status),
  index('idx_downloads_status_completed').on(table.status, table.completedAt),
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
      'imported', 'import_failed', 'upgraded',
      'deleted', 'renamed', 'merged',
      'file_tagged', 'held_for_review',
      'merge_started', 'merge_failed',
      'wrong_release',
      'book_added',
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
  firstSeen: integer('first_seen', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
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
  snoozeUntil: integer('snooze_until', { mode: 'timestamp' }),
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
]);

// ============ SETTINGS ============

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull().$type<unknown>(),
});
