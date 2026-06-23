import { describe, it, expect } from 'vitest';
import { bookStatusSchema, BOOK_STATUSES } from './schemas/book.js';
import { enrichmentStatusSchema, ENRICHMENT_STATUSES } from './schemas/enrichment.js';
import { indexerTypeSchema } from './schemas/indexer.js';
import { downloadClientTypeSchema } from './schemas/download-client.js';
import { notifierTypeSchema } from './schemas/notifier.js';
import { importListTypeSchema } from './schemas/import-list.js';
import { downloadStatusSchema, DOWNLOAD_STATUSES, clientStatusSchema, CLIENT_STATUSES, pipelineStageSchema, PIPELINE_STAGES } from './schemas/activity.js';
import { eventSourceSchema, eventTypeSchema } from './schemas/event-history.js';
import { INDEXER_REGISTRY, INDEXER_TYPES } from './indexer-registry.js';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES } from './download-client-registry.js';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from './notifier-registry.js';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES } from './import-list-registry.js';
import { blacklistReasonSchema, blacklistTypeSchema, BLACKLIST_REASONS } from './schemas/blacklist.js';
import { suggestionReasonSchema, SUGGESTION_REASONS } from './schemas/discovery.js';
import { connectorTypeSchema } from './schemas/connector.js';
import { importJobTypeSchema, importJobStatusSchema, importJobPhaseSchema } from './schemas/import-job.js';
import { protocolSchema, PROTOCOLS } from './schemas/download-protocol.js';
import { blacklist, books, indexers, downloadClients, notifiers, importLists, downloads, suggestions, bookEvents, connectors, importJobs } from '../db/schema.js';

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

    // The two-axis split (#1445): Drizzle SQLite text-enums emit no DB CHECK, so
    // these set-equality tests are the only guard against the Zod enum and the
    // Drizzle column drifting apart for each axis.
    it('downloads.clientStatus DB column enum matches CLIENT_STATUSES', () => {
      expect([...downloads.clientStatus.enumValues].sort()).toEqual([...CLIENT_STATUSES].sort());
    });

    it('downloads.pipelineStage DB column enum matches PIPELINE_STAGES', () => {
      expect([...downloads.pipelineStage.enumValues].sort()).toEqual([...PIPELINE_STAGES].sort());
    });

    // #1599: PROTOCOLS is the single source for the torrent/usenet enum across the
    // Zod schemas, the DownloadProtocol type, and this DB column. SQLite text-enums
    // emit no DB CHECK, so this set-equality test is the guard against drift.
    it('downloads.protocol DB column enum matches protocolSchema.options', () => {
      expect([...downloads.protocol.enumValues].sort()).toEqual([...protocolSchema.options].sort());
    });

    it('suggestions.reason DB column enum matches SUGGESTION_REASONS', () => {
      expect([...suggestions.reason.enumValues].sort()).toEqual([...SUGGESTION_REASONS].sort());
    });

    it('bookEvents.source DB column enum matches eventSourceSchema.options', () => {
      expect([...bookEvents.source.enumValues].sort()).toEqual([...eventSourceSchema.options].sort());
    });

    it('bookEvents.eventType DB column enum matches eventTypeSchema.options', () => {
      expect([...bookEvents.eventType.enumValues].sort()).toEqual([...eventTypeSchema.options].sort());
    });

    it('connectors.type DB column enum matches connectorTypeSchema.options', () => {
      expect([...connectors.type.enumValues].sort()).toEqual([...connectorTypeSchema.options].sort());
    });

    it('importJobs.type DB column enum matches importJobTypeSchema.options', () => {
      expect([...importJobs.type.enumValues].sort()).toEqual([...importJobTypeSchema.options].sort());
    });

    it('importJobs.status DB column enum matches importJobStatusSchema.options', () => {
      expect([...importJobs.status.enumValues].sort()).toEqual([...importJobStatusSchema.options].sort());
    });

    it('importJobs.phase DB column enum matches importJobPhaseSchema.options', () => {
      expect([...importJobs.phase.enumValues].sort()).toEqual([...importJobPhaseSchema.options].sort());
    });

    // blacklist.blacklistType inlines its enum literal (schema.ts) rather than
    // importing blacklistTypeSchema, so the two can genuinely drift — this is the
    // only guard. (SQLite text-enums emit no DB CHECK: drizzle-sqlite-text-enum-no-db-check.)
    it('blacklist.blacklistType DB column enum matches blacklistTypeSchema.options', () => {
      expect([...blacklist.blacklistType.enumValues].sort()).toEqual([...blacklistTypeSchema.options].sort());
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

    it('CLIENT_STATUSES equals clientStatusSchema.options', () => {
      expect([...CLIENT_STATUSES].sort()).toEqual([...clientStatusSchema.options].sort());
    });

    it('PIPELINE_STAGES equals pipelineStageSchema.options', () => {
      expect([...PIPELINE_STAGES].sort()).toEqual([...pipelineStageSchema.options].sort());
    });

    it('PROTOCOLS equals protocolSchema.options', () => {
      expect([...PROTOCOLS].sort()).toEqual([...protocolSchema.options].sort());
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
      const original = ['queued', 'downloading', 'paused', 'completed', 'checking', 'pending_review', 'importing', 'imported', 'failed'];
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

    it('protocol values match original hardcoded enum', () => {
      const original = ['torrent', 'usenet'];
      expect([...protocolSchema.options].sort()).toEqual(original.sort());
    });
  });
});
