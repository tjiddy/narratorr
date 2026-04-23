import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { notifyImportFailure, recordImportFailedEvent } from './import-side-effects.js';

const mockLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(), silent: vi.fn(), level: 'info' } as unknown as FastifyBaseLogger;

describe('notifyImportFailure', () => {
  it('skips notification when notifierService is undefined', () => {
    // Should not throw when notifierService is undefined
    expect(() =>
      notifyImportFailure({
        notifierService: undefined,
        downloadTitle: 'Test Book',
        error: new Error('disk full'),
        log: mockLog,
      }),
    ).not.toThrow();
  });

  it('calls notifierService.notify with error message from getErrorMessage()', () => {
    const notifyMock = vi.fn().mockResolvedValue(undefined);
    const notifierService = { notify: notifyMock } as unknown as Parameters<typeof notifyImportFailure>[0]['notifierService'];

    notifyImportFailure({
      notifierService,
      downloadTitle: 'Test Book',
      error: new Error('disk full'),
      log: mockLog,
    });

    expect(notifyMock).toHaveBeenCalledWith('on_failure', {
      event: 'on_failure',
      book: { title: 'Test Book' },
      error: { message: 'disk full', stage: 'import' },
    });
  });
});

describe('recordImportFailedEvent', () => {
  it('skips recording when eventHistory is undefined', () => {
    expect(() =>
      recordImportFailedEvent({
        eventHistory: undefined,
        bookId: 1,
        bookTitle: 'Test Book',
        authorName: 'Author',
        downloadId: 10,
        source: 'auto',
        error: new Error('copy failed'),
        log: mockLog,
      }),
    ).not.toThrow();
  });

  it('auto source: calls eventHistory.create with source=auto and omits narratorName', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];

    recordImportFailedEvent({
      eventHistory,
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: 10,
      source: 'auto',
      error: new Error('copy failed'),
      log: mockLog,
    });

    expect(createMock).toHaveBeenCalledWith({
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: 10,
      eventType: 'import_failed',
      source: 'auto',
      reason: { error: 'copy failed' },
    });
    // narratorName should NOT be present on the payload when not passed
    expect(createMock.mock.calls[0][0]).not.toHaveProperty('narratorName');
  });

  it('manual source with narratorName: forwards both', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];

    recordImportFailedEvent({
      eventHistory,
      bookId: 42,
      bookTitle: 'Test Book',
      authorName: 'Author',
      narratorName: 'Alice',
      downloadId: null,
      source: 'manual',
      error: new Error('copy failed'),
      log: mockLog,
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      source: 'manual',
      narratorName: 'Alice',
      downloadId: null,
    }));
  });

  it('manual source with narratorName=null: forwards null explicitly', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];

    recordImportFailedEvent({
      eventHistory,
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      narratorName: null,
      downloadId: null,
      source: 'manual',
      error: new Error('fail'),
      log: mockLog,
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ narratorName: null }));
  });

  it('bookId=null (creation failed): forwards bookId: null', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];

    recordImportFailedEvent({
      eventHistory,
      bookId: null,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: null,
      source: 'manual',
      error: new Error('fail'),
      log: mockLog,
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ bookId: null }));
  });

  it('downloadId=null: forwards downloadId: null', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];

    recordImportFailedEvent({
      eventHistory,
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: null,
      source: 'manual',
      error: new Error('fail'),
      log: mockLog,
    });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ downloadId: null }));
  });

  it('eventHistory.create rejects: logs via log.warn and does not throw', async () => {
    const rejection = new Error('db gone');
    const createMock = vi.fn().mockRejectedValue(rejection);
    const eventHistory = { create: createMock } as unknown as Parameters<typeof recordImportFailedEvent>[0]['eventHistory'];
    const warn = vi.fn();
    const log = { ...mockLog, warn } as unknown as FastifyBaseLogger;

    recordImportFailedEvent({
      eventHistory,
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: null,
      source: 'manual',
      error: new Error('original'),
      log,
    });

    // Flush the rejected promise
    await new Promise(r => setImmediate(r));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: rejection.message, type: 'Error' }) }),
      expect.stringContaining('import_failed'),
    );
  });
});
