import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { confirmImport, copyToLibrary, type ImportPipelineDeps } from './import-orchestration.helpers.js';

vi.mock('./enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('./enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('./library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

function createMockLogger(): FastifyBaseLogger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('confirmImport — import_jobs creation (#635)', () => {
  let deps: ImportPipelineDeps;
  let mockBookService: { findDuplicate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  let mockBookImportService: { enqueue: ReturnType<typeof vi.fn> };
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let insertValues: ReturnType<typeof vi.fn>;
  let nudgeWorker: () => void;

  beforeEach(() => {
    insertValues = vi.fn().mockResolvedValue(undefined);
    const chainMethods = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockReturnThis(),
    };
    const db = {
      select: vi.fn().mockReturnValue(chainMethods),
      update: vi.fn().mockReturnValue(chainMethods),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      delete: vi.fn().mockReturnValue(chainMethods),
      transaction: vi.fn(),
    };

    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({
        id: 1, title: data.title, status: 'importing',
      })),
    };
    let nextJobId = 100;
    mockBookImportService = {
      enqueue: vi.fn().mockImplementation(async () => ({ jobId: nextJobId++ })),
    };
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    nudgeWorker = vi.fn() as unknown as () => void;

    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library' } });

    deps = {
      db: inject<Db>(db),
      log,
      bookService: inject<BookService>(mockBookService),
      bookImportService: inject<BookImportService>(mockBookImportService),
      settingsService: inject<SettingsService>(mockSettingsService),
      eventHistory: inject<EventHistoryService>(mockEventHistory),
      enrichmentDeps: {
        db: inject<Db>(db),
        log,
        settingsService: inject<SettingsService>(mockSettingsService),
        bookService: inject<BookService>(mockBookService),
        metadataService: { searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() } as never,
      } satisfies EnrichmentDeps,
      broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
    };
  });

  it('creates book placeholder AND import_jobs row for each accepted item', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    const result = await confirmImport(
      [{ path: '/audiobooks/Author/Title', title: 'Test', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 1 });
    expect(mockBookService.create).toHaveBeenCalledTimes(1);
    expect(mockBookImportService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      type: 'manual',
    }));

    // Verify metadata contains mode
    const enqueueCall = mockBookImportService.enqueue.mock.calls[0]![0];
    const metadata = JSON.parse(enqueueCall.metadata);
    expect(metadata.mode).toBe('copy');
    expect(metadata.title).toBe('Test');
    expect(metadata.authorName).toBe('Author');
  });

  it('pointer mode: metadata JSON omits mode key', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 10, title: 'Pointer', status: 'importing' });

    await confirmImport(
      [{ path: '/audiobooks/X', title: 'Pointer' }],
      deps,
      undefined, // pointer mode
      nudgeWorker,
    );

    const enqueueCall = mockBookImportService.enqueue.mock.calls[0]![0];
    const metadata = JSON.parse(enqueueCall.metadata);
    expect(metadata.mode).toBeUndefined();
  });

  it('nudges worker after creating import_jobs rows', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 1, title: 'A', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'A' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(nudgeWorker).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when no items accepted', async () => {
    mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Dup' });

    await confirmImport(
      [{ path: '/a/b', title: 'Dup', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(nudgeWorker).not.toHaveBeenCalled();
  });

  it('does not nudge when nudgeWorker is undefined', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 1, title: 'A', status: 'importing' });

    // No nudgeWorker passed — should not throw
    await confirmImport(
      [{ path: '/a', title: 'A' }],
      deps,
      'copy',
    );

    // Just verify it didn't throw
    expect(mockBookImportService.enqueue).toHaveBeenCalled();
  });

  it('skips duplicates without creating import_jobs row', async () => {
    mockBookService.findDuplicate.mockResolvedValueOnce({ id: 99, title: 'Dup' });

    const result = await confirmImport(
      [{ path: '/a/b', title: 'Dup', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 0 });
    expect(mockBookImportService.enqueue).not.toHaveBeenCalled();
  });

  it('logs serialized error shape when bookService.create throws (#621)', async () => {
    mockBookService.create.mockRejectedValueOnce(new TypeError('DB constraint violated'));

    await confirmImport(
      [{ path: '/fail', title: 'FailBook' }],
      deps,
      undefined,
      nudgeWorker,
    );

    expect(deps.log.error).toHaveBeenCalledWith(
      {
        error: expect.objectContaining({
          message: 'DB constraint violated',
          type: 'TypeError',
          stack: expect.any(String),
        }),
        title: 'FailBook',
      },
      'Failed to create placeholder for import',
    );
  });

  it('creates multiple import_jobs rows for multiple items', async () => {
    mockBookService.create
      .mockResolvedValueOnce({ id: 1, title: 'Book1', status: 'importing' })
      .mockResolvedValueOnce({ id: 2, title: 'Book2', status: 'importing' });

    const result = await confirmImport(
      [
        { path: '/a', title: 'Book1' },
        { path: '/b', title: 'Book2' },
      ],
      deps,
      'move',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 2 });
    expect(mockBookImportService.enqueue).toHaveBeenCalledTimes(2);
    expect(nudgeWorker).toHaveBeenCalledTimes(1); // Nudge once, not per item
  });

  it('skips item from accepted when enqueue returns active-job-exists conflict', async () => {
    mockBookService.create
      .mockResolvedValueOnce({ id: 50, title: 'BookA', status: 'importing' })
      .mockResolvedValueOnce({ id: 51, title: 'BookB', status: 'importing' });
    mockBookImportService.enqueue
      .mockResolvedValueOnce({ jobId: 200 })
      .mockResolvedValueOnce({ error: 'active-job-exists', status: 409 });

    const result = await confirmImport(
      [
        { path: '/a', title: 'BookA' },
        { path: '/b', title: 'BookB' },
      ],
      deps,
      'copy',
      nudgeWorker,
    );

    // Only the non-conflict item is counted
    expect(result).toEqual({ accepted: 1 });
    expect(mockBookImportService.enqueue).toHaveBeenCalledTimes(2);
    // Conflict surfaced as warn log including the title
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 51, title: 'BookB' }),
      expect.stringContaining('active job already exists'),
    );
    // Nudge still fires once because at least one item was accepted
    expect(nudgeWorker).toHaveBeenCalledTimes(1);
  });

  it('records book_added event for each accepted item', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'Test' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      eventType: 'book_added',
      source: 'manual',
    }));
  });

  it('forwards narrators and seriesPosition through to bookService.create payload (#1028)', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{
        path: '/a',
        title: 'Test',
        authorName: 'Author',
        narrators: ['Jim Dale'],
        seriesPosition: 27,
        seriesName: 'Discworld',
      }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockBookService.create).toHaveBeenCalledWith(expect.objectContaining({
      narrators: ['Jim Dale'],
      seriesPosition: 27,
      seriesName: 'Discworld',
    }));
  });

  it('forwards seriesPosition: 0 through to bookService.create (regression guard) (#1028)', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'Test', seriesName: 'Series', seriesPosition: 0 }],
      deps,
      'copy',
      nudgeWorker,
    );

    const callArgs = mockBookService.create.mock.calls[0]![0] as { seriesPosition: number | undefined };
    expect(callArgs.seriesPosition).toBe(0);
  });
});

describe('copyToLibrary — token precedence (#1028)', () => {
  // The same-path short-circuit lets us read the rendered targetPath without performing fs ops.
  function buildDeps(folderFormat: string): ImportPipelineDeps {
    const log = createMockLogger();
    return {
      db: inject<Db>({}),
      log,
      bookService: inject<BookService>({}),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: '/library', folderFormat },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  it('meta.series[0] wins over item series fields (#1071 provider-truth precedence)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Item tags say `Mistborn #5`; provider match says `Wax and Wayne #1` — provider wins.
    const targetPath = '/library/Author/Wax and Wayne #1/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Mistborn', seriesPosition: 5 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'copy',
      deps,
    );
    expect(path).toBe(targetPath);
  });

  it('item.narrators wins over meta.narrators in {narrator} token', async () => {
    const deps = buildDeps('{narrator}/{title}');
    const targetPath = '/library/Jim Dale/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', narrators: ['Jim Dale'] },
      { title: 'Title', authors: [{ name: 'Author' }], narrators: ['Stephen Fry'] },
      'copy',
      deps,
    );
    expect(path).toBe(targetPath);
  });

  it('meta.series[0].position: 0 wins over item (#1071 falsy regression guard)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Provider says position 0 (prequel); item tags say 5; provider wins, position 0 preserved.
    const targetPath = '/library/Author/Prequels #0/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Prequels', seriesPosition: 5 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Prequels', position: 0 }] },
      'copy',
      deps,
    );
    expect(path).toBe(targetPath);
  });

  it('falls back to meta.series[0].position when item.seriesPosition is undefined', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    const targetPath = '/library/Author/Discworld #99/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Discworld' },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Discworld', position: 99 }] },
      'copy',
      deps,
    );
    expect(path).toBe(targetPath);
  });

  it('falls back to meta.narrators when item.narrators is empty', async () => {
    const deps = buildDeps('{narrator}/{title}');
    const targetPath = '/library/Stephen Fry/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author' },
      { title: 'Title', authors: [{ name: 'Author' }], narrators: ['Stephen Fry'] },
      'copy',
      deps,
    );
    expect(path).toBe(targetPath);
  });
});

