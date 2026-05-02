import { describe, it, expectTypeOf } from 'vitest';
import type {
  BlacklistRow,
  BookEventRow,
  DownloadClientRow,
  ImportJobRow,
  ImportListRow,
  IndexerRow,
  NotifierRow,
  SuggestionRow,
  SuggestionStatus,
} from './types.js';
import type { IndexerType } from '../../shared/indexer-registry.js';
import type { DownloadClientType } from '../../shared/download-client-registry.js';
import type { NotifierType } from '../../shared/notifier-registry.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import type { EventSource, EventType } from '../../shared/schemas/event-history.js';
import type { BlacklistReason, BlacklistType } from '../../shared/schemas/blacklist.js';
import type { SuggestionReason } from '../../shared/schemas/discovery.js';
import type {
  ImportJobPhase,
  ImportJobStatus,
  ImportJobType,
} from '../../shared/schemas/import-job.js';

describe('canonical row type narrowing', () => {
  it('narrows enum columns to their registry/schema types', () => {
    expectTypeOf<IndexerRow['type']>().toEqualTypeOf<IndexerType>();
    expectTypeOf<DownloadClientRow['type']>().toEqualTypeOf<DownloadClientType>();
    expectTypeOf<NotifierRow['type']>().toEqualTypeOf<NotifierType>();
    expectTypeOf<ImportListRow['type']>().toEqualTypeOf<ImportListType>();

    expectTypeOf<BookEventRow['eventType']>().toEqualTypeOf<EventType>();
    expectTypeOf<BookEventRow['source']>().toEqualTypeOf<EventSource>();

    expectTypeOf<BlacklistRow['reason']>().toEqualTypeOf<BlacklistReason>();
    expectTypeOf<BlacklistRow['blacklistType']>().toEqualTypeOf<BlacklistType>();

    expectTypeOf<SuggestionRow['reason']>().toEqualTypeOf<SuggestionReason>();
    expectTypeOf<SuggestionRow['status']>().toEqualTypeOf<SuggestionStatus>();

    expectTypeOf<ImportJobRow['type']>().toEqualTypeOf<ImportJobType>();
    expectTypeOf<ImportJobRow['status']>().toEqualTypeOf<ImportJobStatus>();
    expectTypeOf<ImportJobRow['phase']>().toEqualTypeOf<ImportJobPhase | null>();
  });

  it('rejects out-of-union enum literals without an assertion', () => {
    // @ts-expect-error — 'tornaab' is not a valid IndexerType
    const badIndexer: Pick<IndexerRow, 'type'> = { type: 'tornaab' };
    void badIndexer;

    // @ts-expect-error — 'sftp' is not a valid DownloadClientType
    const badDownloadClient: Pick<DownloadClientRow, 'type'> = { type: 'sftp' };
    void badDownloadClient;

    // @ts-expect-error — 'sms' is not a valid NotifierType
    const badNotifier: Pick<NotifierRow, 'type'> = { type: 'sms' };
    void badNotifier;

    // @ts-expect-error — 'goodreads' is not a valid ImportListType
    const badImportList: Pick<ImportListRow, 'type'> = { type: 'goodreads' };
    void badImportList;

    // @ts-expect-error — 'invented_event' is not a valid EventType
    const badEvent: Pick<BookEventRow, 'eventType'> = { eventType: 'invented_event' };
    void badEvent;

    // @ts-expect-error — 'cron' is not a valid EventSource
    const badEventSource: Pick<BookEventRow, 'source'> = { source: 'cron' };
    void badEventSource;

    // @ts-expect-error — 'meh' is not a valid BlacklistReason
    const badBlacklistReason: Pick<BlacklistRow, 'reason'> = { reason: 'meh' };
    void badBlacklistReason;

    // @ts-expect-error — 'forever' is not a valid BlacklistType
    const badBlacklistType: Pick<BlacklistRow, 'blacklistType'> = { blacklistType: 'forever' };
    void badBlacklistType;

    // @ts-expect-error — 'editor' is not a valid SuggestionReason
    const badSuggestionReason: Pick<SuggestionRow, 'reason'> = { reason: 'editor' };
    void badSuggestionReason;

    // @ts-expect-error — 'archived' is not a valid SuggestionStatus
    const badSuggestionStatus: Pick<SuggestionRow, 'status'> = { status: 'archived' };
    void badSuggestionStatus;

    // @ts-expect-error — 'rss' is not a valid ImportJobType
    const badImportJobType: Pick<ImportJobRow, 'type'> = { type: 'rss' };
    void badImportJobType;

    // @ts-expect-error — 'queued' is not a valid ImportJobStatus
    const badImportJobStatus: Pick<ImportJobRow, 'status'> = { status: 'queued' };
    void badImportJobStatus;

    // @ts-expect-error — 'extracting' is not a valid ImportJobPhase
    const badImportJobPhase: Pick<ImportJobRow, 'phase'> = { phase: 'extracting' };
    void badImportJobPhase;
  });
});
