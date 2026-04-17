import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { confirmImport, type ImportPipelineDeps } from './import-orchestration.helpers.js';

function createMockLogger(): FastifyBaseLogger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('confirmImport — import_jobs creation (#635)', () => {
  let deps: ImportPipelineDeps;
  let mockBookService: { findDuplicate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
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
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    nudgeWorker = vi.fn() as unknown as () => void;

    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library' } });

    deps = {
      db: inject<Db>(db),
      log,
      bookService: inject<BookService>(mockBookService),
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
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      type: 'manual',
      status: 'pending',
      phase: 'queued',
    }));

    // Verify metadata contains mode
    const insertCall = insertValues.mock.calls[0][0];
    const metadata = JSON.parse(insertCall.metadata);
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

    const insertCall = insertValues.mock.calls[0][0];
    const metadata = JSON.parse(insertCall.metadata);
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
    expect(insertValues).toHaveBeenCalled();
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
    expect(insertValues).not.toHaveBeenCalled();
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
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(nudgeWorker).toHaveBeenCalledTimes(1); // Nudge once, not per item
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
});
