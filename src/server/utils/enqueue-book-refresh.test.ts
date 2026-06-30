import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { enqueueBookRefresh, enqueueBookRefreshById, enqueueRetagRefresh } from './enqueue-book-refresh.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorService } from '../services/connector.service.js';
import type { BookService } from '../services/book.service.js';
import type { RetagResult } from '../services/tagging.service.js';

function makeLog() {
  return inject<FastifyBaseLogger>(createMockLogger());
}

function makeConnector() {
  return inject<ConnectorService>({ notifyRefresh: vi.fn().mockResolvedValue(undefined) });
}

describe('enqueueBookRefresh', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fires notifyRefresh with the given reason and item', () => {
    const connector = makeConnector();
    enqueueBookRefresh(connector, makeLog(), 'convert', { bookId: 7, title: 'T', authorName: 'A', libraryPath: '/lib/A/T' });
    expect(connector.notifyRefresh).toHaveBeenCalledWith('convert', [
      { bookId: 7, title: 'T', authorName: 'A', libraryPath: '/lib/A/T' },
    ]);
  });

  it('is a no-op when no connector is configured', () => {
    // No connector → no throw, nothing to assert beyond not crashing.
    expect(() => enqueueBookRefresh(undefined, makeLog(), 'convert', { bookId: 1, title: 'T', libraryPath: '/x' })).not.toThrow();
  });
});

describe('enqueueRetagRefresh', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const tagged: RetagResult = {
    bookId: 1, tagged: 2, skipped: 0, failed: 0, warnings: [],
    refreshItem: { bookId: 1, title: 'Book', authorName: 'A', libraryPath: '/lib/A/Book' },
  };

  it("fires a 'metadata' refresh from the result's refreshItem when ≥1 file was tagged", () => {
    const connector = makeConnector();
    enqueueRetagRefresh(connector, makeLog(), tagged);
    expect(connector.notifyRefresh).toHaveBeenCalledWith('metadata', [
      expect.objectContaining({ bookId: 1, libraryPath: '/lib/A/Book' }),
    ]);
  });

  it('does NOT fire when tagged === 0 (all-skipped)', () => {
    const connector = makeConnector();
    enqueueRetagRefresh(connector, makeLog(), { ...tagged, tagged: 0, skipped: 3 });
    expect(connector.notifyRefresh).not.toHaveBeenCalled();
  });

  it('does NOT fire when there is no usable refreshItem (null path guard)', () => {
    const connector = makeConnector();
    enqueueRetagRefresh(connector, makeLog(), { ...tagged, refreshItem: null });
    expect(connector.notifyRefresh).not.toHaveBeenCalled();
  });
});

describe('enqueueBookRefreshById — reload-miss diagnostics', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('debug-logs the skip and does NOT fire when the book reloads as null while a connector is configured', async () => {
    const connector = makeConnector();
    const bookService = inject<BookService>({ getById: vi.fn().mockResolvedValue(null) });
    const log = makeLog();

    await enqueueBookRefreshById(connector, bookService, log, 'convert', 42);

    expect(connector.notifyRefresh).not.toHaveBeenCalled();
    expect(log.debug as Mock).toHaveBeenCalledWith(
      { bookId: 42, reason: 'convert' },
      expect.stringContaining('skipped'),
    );
  });

  it('debug-logs the skip when the reloaded book has no path', async () => {
    const connector = makeConnector();
    const bookService = inject<BookService>({ getById: vi.fn().mockResolvedValue({ id: 42, title: 'T', path: null, authors: [] }) });
    const log = makeLog();

    await enqueueBookRefreshById(connector, bookService, log, 'metadata', 42);

    expect(connector.notifyRefresh).not.toHaveBeenCalled();
    expect(log.debug as Mock).toHaveBeenCalledWith({ bookId: 42, reason: 'metadata' }, expect.any(String));
  });

  it('debug-logs the skip when the reload rejects (best-effort, never throws)', async () => {
    const connector = makeConnector();
    const bookService = inject<BookService>({ getById: vi.fn().mockRejectedValue(new Error('libSQL read failed')) });
    const log = makeLog();

    await expect(enqueueBookRefreshById(connector, bookService, log, 'convert', 42)).resolves.toBeUndefined();
    expect(connector.notifyRefresh).not.toHaveBeenCalled();
    expect(log.debug as Mock).toHaveBeenCalledWith({ bookId: 42, reason: 'convert' }, expect.any(String));
  });

  it('does NOT debug-log the miss when no connector is configured (no false-positive noise)', async () => {
    const bookService = inject<BookService>({ getById: vi.fn().mockResolvedValue(null) });
    const log = makeLog();

    await enqueueBookRefreshById(undefined, bookService, log, 'convert', 42);

    // Early return before the reload — getById is never called and nothing is logged for a miss.
    expect(bookService.getById).not.toHaveBeenCalled();
    expect(log.debug as Mock).not.toHaveBeenCalled();
  });

  it('fires the refresh from the reloaded state when the book has a path', async () => {
    const connector = makeConnector();
    const bookService = inject<BookService>({
      getById: vi.fn().mockResolvedValue({ id: 42, title: 'T', path: '/lib/A/T', authors: [{ name: 'A' }] }),
    });

    await enqueueBookRefreshById(connector, bookService, makeLog(), 'metadata', 42);

    expect(connector.notifyRefresh).toHaveBeenCalledWith('metadata', [
      { bookId: 42, title: 'T', authorName: 'A', libraryPath: '/lib/A/T' },
    ]);
  });
});
