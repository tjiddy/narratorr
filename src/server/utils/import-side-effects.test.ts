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
    const notifierService = { notify: notifyMock } as any;

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
        error: new Error('copy failed'),
        log: mockLog,
      }),
    ).not.toThrow();
  });

  it('calls eventHistory.create with error message from getErrorMessage()', () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: createMock } as any;

    recordImportFailedEvent({
      eventHistory,
      bookId: 1,
      bookTitle: 'Test Book',
      authorName: 'Author',
      downloadId: 10,
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
  });
});
