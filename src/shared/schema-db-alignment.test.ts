import { describe, it, expect } from 'vitest';
import { bookStatusSchema, BOOK_STATUSES } from './schemas/book.js';
import { enrichmentStatusSchema, ENRICHMENT_STATUSES } from './schemas/enrichment.js';
import { indexerTypeSchema } from './schemas/indexer.js';
import { downloadClientTypeSchema } from './schemas/download-client.js';
import { notifierTypeSchema } from './schemas/notifier.js';
import { importListTypeSchema } from './schemas/import-list.js';
import { downloadStatusSchema, DOWNLOAD_STATUSES } from './schemas/activity.js';
import { INDEXER_REGISTRY, INDEXER_TYPES } from './indexer-registry.js';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES } from './download-client-registry.js';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from './notifier-registry.js';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES } from './import-list-registry.js';
import { blacklistReasonSchema, BLACKLIST_REASONS } from './schemas/blacklist.js';
import { suggestionReasonSchema, SUGGESTION_REASONS } from './schemas/discovery.js';
import { blacklist, books, indexers, downloadClients, notifiers, importLists, downloads, suggestions } from '../db/schema.js';

describe('schema-DB alignment', () => {
  describe('adapter type enums derive from registries', () => {
    it('indexerTypeSchema.options matches INDEXER_TYPES tuple', () => {
      expect([...indexerTypeSchema.options].sort()).toEqual([...INDEXER_TYPES].sort());
    });

    it('indexerTypeSchema.options matches INDEXER_REGISTRY keys', () => {
      expect([...indexerTypeSchema.options].sort()).toEqual(Object.keys(INDEXER_REGISTRY).sort());
    });

    it('downloadClientTypeSchema.options matches DOWNLOAD_CLIENT_TYPES tuple', () => {
      expect([...downloadClientTypeSchema.options].sort()).toEqual([...DOWNLOAD_CLIENT_TYPES].sort());
    });

    it('downloadClientTypeSchema.options matches DOWNLOAD_CLIENT_REGISTRY keys', () => {
      expect([...downloadClientTypeSchema.options].sort()).toEqual(Object.keys(DOWNLOAD_CLIENT_REGISTRY).sort());
    });

    it('notifierTypeSchema.options matches NOTIFIER_TYPES tuple', () => {
      expect([...notifierTypeSchema.options].sort()).toEqual([...NOTIFIER_TYPES].sort());
    });

    it('notifierTypeSchema.options matches NOTIFIER_REGISTRY keys', () => {
      expect([...notifierTypeSchema.options].sort()).toEqual(Object.keys(NOTIFIER_REGISTRY).sort());
    });

    it('importListTypeSchema.options matches IMPORT_LIST_TYPES tuple', () => {
      expect([...importListTypeSchema.options].sort()).toEqual([...IMPORT_LIST_TYPES].sort());
    });

    it('importListTypeSchema.options matches IMPORT_LIST_REGISTRY keys', () => {
      expect([...importListTypeSchema.options].sort()).toEqual(Object.keys(IMPORT_LIST_REGISTRY).sort());
    });

    it('blacklistReasonSchema.options matches BLACKLIST_REASONS tuple', () => {
      expect([...blacklistReasonSchema.options].sort()).toEqual([...BLACKLIST_REASONS].sort());
    });

    it('blacklist.reason DB column enum matches BLACKLIST_REASONS tuple', () => {
      expect([...blacklist.reason.enumValues].sort()).toEqual([...BLACKLIST_REASONS].sort());
    });

    it('suggestionReasonSchema.options matches SUGGESTION_REASONS tuple', () => {
      expect([...suggestionReasonSchema.options].sort()).toEqual([...SUGGESTION_REASONS].sort());
    });
  });

  describe('DB column enums match canonical tuple sources', () => {
    it('books.status DB column enum matches BOOK_STATUSES', () => {
      expect([...books.status.enumValues].sort()).toEqual([...BOOK_STATUSES].sort());
    });

    it('books.enrichmentStatus DB column enum matches ENRICHMENT_STATUSES', () => {
      expect([...books.enrichmentStatus.enumValues].sort()).toEqual([...ENRICHMENT_STATUSES].sort());
    });

    it('indexers.type DB column enum matches INDEXER_TYPES', () => {
      expect([...indexers.type.enumValues].sort()).toEqual([...INDEXER_TYPES].sort());
    });

    it('downloadClients.type DB column enum matches DOWNLOAD_CLIENT_TYPES', () => {
      expect([...downloadClients.type.enumValues].sort()).toEqual([...DOWNLOAD_CLIENT_TYPES].sort());
    });

    it('notifiers.type DB column enum matches NOTIFIER_TYPES', () => {
      expect([...notifiers.type.enumValues].sort()).toEqual([...NOTIFIER_TYPES].sort());
    });

    it('importLists.type DB column enum matches IMPORT_LIST_TYPES', () => {
      expect([...importLists.type.enumValues].sort()).toEqual([...IMPORT_LIST_TYPES].sort());
    });

    it('downloads.status DB column enum matches DOWNLOAD_STATUSES', () => {
      expect([...downloads.status.enumValues].sort()).toEqual([...DOWNLOAD_STATUSES].sort());
    });

    it('suggestions.reason DB column enum matches SUGGESTION_REASONS', () => {
      expect([...suggestions.reason.enumValues].sort()).toEqual([...SUGGESTION_REASONS].sort());
    });
  });

  describe('new const array exports match schema options', () => {
    it('BOOK_STATUSES equals bookStatusSchema.options', () => {
      expect([...BOOK_STATUSES].sort()).toEqual([...bookStatusSchema.options].sort());
    });

    it('ENRICHMENT_STATUSES equals enrichmentStatusSchema.options', () => {
      expect([...ENRICHMENT_STATUSES].sort()).toEqual([...enrichmentStatusSchema.options].sort());
    });

    it('DOWNLOAD_STATUSES equals downloadStatusSchema.options', () => {
      expect([...DOWNLOAD_STATUSES].sort()).toEqual([...downloadStatusSchema.options].sort());
    });
  });

  describe('backward compatibility — all original values preserved', () => {
    it('book status values match original hardcoded enum', () => {
      const original = ['wanted', 'searching', 'downloading', 'importing', 'imported', 'missing', 'failed'];
      expect([...bookStatusSchema.options].sort()).toEqual(original.sort());
    });

    it('enrichment status values match original hardcoded enum', () => {
      const original = ['pending', 'enriched', 'failed', 'skipped', 'file-enriched'];
      expect([...enrichmentStatusSchema.options].sort()).toEqual(original.sort());
    });

    it('download status values match (already derived — baseline)', () => {
      const original = ['queued', 'downloading', 'paused', 'completed', 'checking', 'pending_review', 'processing_queued', 'importing', 'imported', 'failed'];
      expect([...downloadStatusSchema.options].sort()).toEqual(original.sort());
    });

    it('indexer type values match original hardcoded enum', () => {
      const original = ['abb', 'torznab', 'newznab', 'myanonamouse'];
      expect([...indexerTypeSchema.options].sort()).toEqual(original.sort());
    });

    it('download client type values match original hardcoded enum', () => {
      const original = ['qbittorrent', 'transmission', 'sabnzbd', 'nzbget', 'deluge', 'blackhole'];
      expect([...downloadClientTypeSchema.options].sort()).toEqual(original.sort());
    });

    it('notifier type values match original hardcoded enum', () => {
      const original = ['webhook', 'discord', 'script', 'email', 'telegram', 'slack', 'pushover', 'ntfy', 'gotify'];
      expect([...notifierTypeSchema.options].sort()).toEqual(original.sort());
    });

    it('import list type values match original hardcoded enum', () => {
      const original = ['abs', 'nyt', 'hardcover'];
      expect([...importListTypeSchema.options].sort()).toEqual(original.sort());
    });
  });
});
