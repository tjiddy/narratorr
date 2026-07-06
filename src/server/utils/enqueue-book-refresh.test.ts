import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { enqueueBookRefresh, enqueueRetagRefresh } from './enqueue-book-refresh.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorService } from '../services/connector.service.js';
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
