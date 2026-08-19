import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportService } from './import.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import { createMockLogger, createMockSettingsService, inject } from '../__tests__/helpers.js';
import { ContentFailureError } from '../utils/import-helpers.js';

vi.mock('./rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));
import { blacklistAndRetrySearch } from './rejection-helpers.js';

/**
 * The degraded arm of `importDownload` (#2307). Unlike import-orchestrator.test.ts this suite runs
 * the REAL import-steps helpers, so the event/notification/SSE assertions observe what the
 * collaborators actually receive rather than a spy on the helper itself.
 */
describe('ImportOrchestrator — context-resolution failure (#2307)', () => {
  const contextError = new Error('Download 113 not found');
  const book = { id: 42, title: 'The Stranger' };

  let importService: ImportService;
  let settingsService: SettingsService;
  let log: ReturnType<typeof createMockLogger>;
  let notify: ReturnType<typeof vi.fn>;
  let notifier: NotifierService;
  let eventCreate: ReturnType<typeof vi.fn>;
  let eventHistory: EventHistoryService;
  let emit: ReturnType<typeof vi.fn>;
  let broadcaster: EventBroadcasterService;
  let getById: ReturnType<typeof vi.fn>;
  let bookService: BookService;
  let orchestrator: ImportOrchestrator;

  function build(overrides?: { bookService?: BookService | undefined }): ImportOrchestrator {
    const built = new ImportOrchestrator(
      importService, settingsService, inject<FastifyBaseLogger>(log), notifier, undefined,
      eventHistory, broadcaster, undefined,
      overrides && 'bookService' in overrides ? overrides.bookService : bookService,
    );
    built.wire({
      bookImportService: {} as never,
      blacklistService: inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) }),
      retrySearchDeps: inject<RetrySearchDeps>({ log: createMockLogger() }),
      nudgeImportWorker: vi.fn(),
    });
    return built;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    importService = inject<ImportService>({
      getImportContext: vi.fn().mockRejectedValue(contextError),
      importDownload: vi.fn(),
      getEligibleDownloads: vi.fn().mockResolvedValue([]),
    });
    settingsService = createMockSettingsService();
    log = createMockLogger();
    notify = vi.fn().mockResolvedValue(undefined);
    notifier = inject<NotifierService>({ notify });
    eventCreate = vi.fn().mockResolvedValue({ id: 1 });
    eventHistory = inject<EventHistoryService>({ create: eventCreate });
    emit = vi.fn();
    broadcaster = inject<EventBroadcasterService>({ emit });
    getById = vi.fn().mockResolvedValue(book);
    bookService = inject<BookService>({ getById });
    orchestrator = build();
  });

  /** The single log record the degraded arm emits. */
  function degradedLog(): Record<string, unknown> {
    expect(log.error).toHaveBeenCalledTimes(1);
    return (log.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
  }

  it('records import_failed against the book with a null download id and rethrows the context error', async () => {
    await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledWith({
      bookId: 42,
      bookTitle: 'The Stranger',
      authorName: undefined,
      // The vanished row's id would violate the book_events.download_id FK.
      downloadId: null,
      eventType: 'import_failed',
      source: 'auto',
      reason: { error: 'Download 113 not found' },
    });
  });

  it('notifies on_failure using the book title in place of the unavailable release title', async () => {
    await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('on_failure', {
      event: 'on_failure',
      book: { title: 'The Stranger' },
      error: { message: 'Download 113 not found', stage: 'import' },
    });
  });

  it('emits no SSE and never blacklists or retries — a missing row is not a content failure', async () => {
    await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

    expect(emit).not.toHaveBeenCalled();
    expect(blacklistAndRetrySearch).not.toHaveBeenCalled();
  });

  it('logs the download id, book id and resolved title once, with a serialized error (AC2)', async () => {
    await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

    const record = degradedLog();
    expect(record).toMatchObject({ downloadId: 113, bookId: 42, bookTitle: 'The Stranger' });
    // A raw Error satisfies objectContaining({ message }); only the own-enumerable key set discriminates.
    const logged = record.error as Record<string, unknown>;
    expect(logged).not.toBeInstanceOf(Error);
    expect(Object.keys(logged).sort()).toEqual(['message', 'stack', 'type']);
    expect(logged.type).toBe('Error');
    expect(logged.message).toBe('Download 113 not found');
  });

  it('resolves the title exactly once — the worker owns its own lookup', async () => {
    await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(42);
  });

  describe('no provenance', () => {
    it('does nothing at all when the job argument is omitted', async () => {
      await expect(orchestrator.importDownload(113)).rejects.toBe(contextError);

      expect(log.error).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();
      expect(eventCreate).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('no live book', () => {
    it('skips the event and notification when the book was concurrently deleted', async () => {
      getById.mockResolvedValue(null);

      await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

      expect(eventCreate).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      const record = degradedLog();
      expect(record).toMatchObject({ downloadId: 113, bookId: 42 });
      expect(record).not.toHaveProperty('bookTitle');
    });

    it('skips the event and notification when no bookService is injected', async () => {
      const withoutBookService = build({ bookService: undefined });

      await expect(withoutBookService.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

      expect(eventCreate).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(degradedLog()).toMatchObject({ downloadId: 113, bookId: 42 });
    });

    it('carries the title lookup failure in the same single log and still propagates the CONTEXT error', async () => {
      const lookupError = new Error('SQLITE_BUSY: database is locked');
      getById.mockRejectedValue(lookupError);

      // Both errors could plausibly read "not found"; identity is the assertion.
      await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);

      expect(eventCreate).not.toHaveBeenCalled();
      const record = degradedLog();
      expect(record).toMatchObject({ downloadId: 113, bookId: 42 });
      expect((record.error as Record<string, unknown>).message).toBe('Download 113 not found');
      expect((record.lookupError as Record<string, unknown>).message).toBe('SQLITE_BUSY: database is locked');
      expect((record.lookupError as Record<string, unknown>).type).toBe('Error');
    });
  });

  describe('error-propagation invariant', () => {
    it('propagates the context error when the history write rejects', async () => {
      eventCreate.mockRejectedValue(new Error('event insert failed'));

      await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);
    });

    it('propagates the context error when the notifier rejects', async () => {
      notify.mockRejectedValue(new Error('webhook unreachable'));

      await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contextError);
    });
  });

  describe('positional split', () => {
    // AC8: the degraded arm is failure-only, so a resolving context adds no query and no log.
    it('a successful import runs no degraded work even with job context supplied', async () => {
      vi.mocked(importService.getImportContext).mockResolvedValue({
        downloadId: 113, downloadTitle: 'The Stranger [2026]', downloadStatus: 'completed',
        bookId: 42, bookTitle: 'The Stranger', bookStatus: 'downloading', bookStatusAtGrab: 'wanted',
        bookPath: null, authorName: 'Albert Camus', narratorStr: null,
        book: { id: 42, title: 'The Stranger' } as never,
        infoHash: null, guid: null,
      });
      vi.mocked(importService.importDownload).mockResolvedValue({
        downloadId: 113, bookId: 42, targetPath: '/lib/Albert Camus/The Stranger', fileCount: 3, totalSize: 1,
      });

      await orchestrator.importDownload(113, undefined, { bookId: 42 });

      expect(getById).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    it('a ContentFailureError from the import itself still takes the full failure dispatch', async () => {
      const contentError = new ContentFailureError('No audio files found in /path');
      vi.mocked(importService.getImportContext).mockResolvedValue({
        downloadId: 113, downloadTitle: 'The Stranger [2026]', downloadStatus: 'completed',
        bookId: 42, bookTitle: 'The Stranger', bookStatus: 'downloading', bookStatusAtGrab: 'wanted',
        bookPath: null, authorName: 'Albert Camus', narratorStr: null,
        book: { id: 42, title: 'The Stranger' } as never,
        infoHash: 'abc123', guid: null,
      });
      vi.mocked(importService.importDownload).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(113, undefined, { bookId: 42 })).rejects.toBe(contentError);

      // The full-context arm: SSE, the vanished-row-free download id, and the blacklist branch.
      expect(emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ download_id: 113, new_status: 'failed' }));
      expect(eventCreate).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 113, eventType: 'import_failed' }));
      expect(blacklistAndRetrySearch).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});
