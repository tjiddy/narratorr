import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============ LIBRARY ============

export const authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const books = sqliteTable('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  authorId: integer('author_id').references(() => authors.id),
  narrator: text('narrator'),
  description: text('description'),
  coverUrl: text('cover_url'),
  goodreadsId: text('goodreads_id'),
  audibleId: text('audible_id'),
  status: text('status', {
    enum: ['wanted', 'searching', 'downloading', 'imported', 'missing'],
  })
    .notNull()
    .default('wanted'),
  path: text('path'),
  size: integer('size'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ============ INTEGRATIONS ============

export const indexers = sqliteTable('indexers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: ['abb', 'torznab'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(50),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const downloadClients = sqliteTable('download_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: ['qbittorrent', 'transmission', 'sabnzbd'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(50),
  settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ============ ACTIVITY ============

export const downloads = sqliteTable('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id),
  indexerId: integer('indexer_id').references(() => indexers.id),
  downloadClientId: integer('download_client_id').references(() => downloadClients.id),
  title: text('title').notNull(),
  infoHash: text('info_hash'),
  magnetUri: text('magnet_uri'),
  size: integer('size'),
  seeders: integer('seeders'),
  status: text('status', {
    enum: ['queued', 'downloading', 'paused', 'completed', 'importing', 'imported', 'failed'],
  })
    .notNull()
    .default('queued'),
  progress: real('progress').notNull().default(0),
  externalId: text('external_id'),
  errorMessage: text('error_message'),
  addedAt: integer('added_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

// ============ SETTINGS ============

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull().$type<unknown>(),
});
