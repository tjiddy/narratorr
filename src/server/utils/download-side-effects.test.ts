import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';

import {
  emitGrabStarted,
  emitBookStatusChangeOnGrab,
  emitDownloadProgress,
  emitDownloadStatusChange,
  emitBookStatusChange,
  notifyGrab,
  recordGrabbedEvent,
  recordDownloadCompletedEvent,
  recordDownloadFailedEvent,
} from './download-side-effects.js';

function createMockBroadcaster(): EventBroadcasterService {
  return { emit: vi.fn() } as unknown as EventBroadcasterService;
}

function createMockNotifier(): NotifierService {
  return { notify: vi.fn().mockResolvedValue(undefined) } as unknown as NotifierService;
}

function createMockEventHistory(): EventHistoryService {
  return { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
}

function createMockLog(): FastifyBaseLogger {
  return { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('emitGrabStarted', () => {
  it('emits grab_started SSE with correct payload', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitGrabStarted({ broadcaster, downloadId: 1, bookId: 2, bookTitle: 'Test Book', releaseTitle: 'Test Release', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('grab_started', {
      download_id: 1, book_id: 2, book_title: 'Test Book', release_title: 'Test Release',
    });
  });

  it('skips emission when broadcaster is undefined', () => {
    const log = createMockLog();
    // Should not throw
    emitGrabStarted({ broadcaster: undefined, downloadId: 1, bookId: 2, bookTitle: 'Test', releaseTitle: 'Test', log });
  });

  it('catches and logs SSE emission errors', () => {
    const broadcaster = createMockBroadcaster();
    (broadcaster.emit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
    const log = createMockLog();
    emitGrabStarted({ broadcaster, downloadId: 1, bookId: 2, bookTitle: 'Test', releaseTitle: 'Test', log });
    expect(log.debug).toHaveBeenCalled();
  });
});

describe('emitBookStatusChangeOnGrab', () => {
  it('emits book_status_change SSE with old_status=wanted, new_status=downloading', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitBookStatusChangeOnGrab({ broadcaster, bookId: 2, isHandoff: false, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
      book_id: 2, old_status: 'wanted', new_status: 'downloading',
    });
  });

  it('emits book_status_change SSE with new_status=missing for handoff clients', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitBookStatusChangeOnGrab({ broadcaster, bookId: 2, isHandoff: true, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
      book_id: 2, old_status: 'wanted', new_status: 'missing',
    });
  });

  it('skips emission when broadcaster is undefined', () => {
    const log = createMockLog();
    emitBookStatusChangeOnGrab({ broadcaster: undefined, bookId: 2, isHandoff: false, log });
  });

  it('catches and logs SSE emission errors', () => {
    const broadcaster = createMockBroadcaster();
    (broadcaster.emit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
    const log = createMockLog();
    emitBookStatusChangeOnGrab({ broadcaster, bookId: 2, isHandoff: false, log });
    expect(log.debug).toHaveBeenCalled();
  });
});

describe('emitDownloadProgress', () => {
  it('emits download_progress SSE with correct payload', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitDownloadProgress({ broadcaster, downloadId: 1, bookId: 2, progress: 0.5, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
      download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null,
    });
  });

  it('skips emission when broadcaster is undefined', () => {
    const log = createMockLog();
    emitDownloadProgress({ broadcaster: undefined, downloadId: 1, bookId: 2, progress: 0.5, log });
  });

  it('catches and logs SSE emission errors', () => {
    const broadcaster = createMockBroadcaster();
    (broadcaster.emit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
    const log = createMockLog();
    emitDownloadProgress({ broadcaster, downloadId: 1, bookId: 2, progress: 0.5, log });
    expect(log.debug).toHaveBeenCalled();
  });

  it('forwards a numeric speed into the payload', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitDownloadProgress({ broadcaster, downloadId: 1, bookId: 2, progress: 0.5, speed: 1_048_576, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
      download_id: 1, book_id: 2, percentage: 0.5, speed: 1_048_576, eta: null,
    });
  });

  it('preserves speed=0 (stalled) rather than coercing to null', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitDownloadProgress({ broadcaster, downloadId: 1, bookId: 2, progress: 0.5, speed: 0, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
      download_id: 1, book_id: 2, percentage: 0.5, speed: 0, eta: null,
    });
  });

  it('coerces explicit null speed to null (orchestrator caller pattern)', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitDownloadProgress({ broadcaster, downloadId: 1, bookId: 2, progress: 0.5, speed: null, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
      download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null,
    });
  });
});

describe('emitDownloadStatusChange', () => {
  it('emits download_status_change SSE with correct old/new status', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitDownloadStatusChange({ broadcaster, downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'completed', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
      download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed',
    });
  });

  it('skips emission when broadcaster is undefined', () => {
    const log = createMockLog();
    emitDownloadStatusChange({ broadcaster: undefined, downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'completed', log });
  });

  it('catches and logs SSE emission errors', () => {
    const broadcaster = createMockBroadcaster();
    (broadcaster.emit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
    const log = createMockLog();
    emitDownloadStatusChange({ broadcaster, downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'completed', log });
    expect(log.debug).toHaveBeenCalled();
  });
});

describe('emitBookStatusChange', () => {
  it('emits book_status_change SSE with correct old/new status', () => {
    const broadcaster = createMockBroadcaster();
    const log = createMockLog();
    emitBookStatusChange({ broadcaster, bookId: 2, oldStatus: 'downloading', newStatus: 'wanted', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
      book_id: 2, old_status: 'downloading', new_status: 'wanted',
    });
  });

  it('skips emission when broadcaster is undefined', () => {
    const log = createMockLog();
    emitBookStatusChange({ broadcaster: undefined, bookId: 2, oldStatus: 'downloading', newStatus: 'wanted', log });
  });

  it('catches and logs SSE emission errors', () => {
    const broadcaster = createMockBroadcaster();
    (broadcaster.emit as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
    const log = createMockLog();
    emitBookStatusChange({ broadcaster, bookId: 2, oldStatus: 'downloading', newStatus: 'wanted', log });
    expect(log.debug).toHaveBeenCalled();
  });
});

describe('notifyGrab', () => {
  it('calls notifierService.notify with on_grab event and correct payload', () => {
    const notifier = createMockNotifier();
    const log = createMockLog();
    notifyGrab({ notifierService: notifier, title: 'Test Book', size: 500_000, log });
    expect(notifier.notify).toHaveBeenCalledWith('on_grab', {
      event: 'on_grab',
      book: { title: 'Test Book' },
      release: { title: 'Test Book', size: 500_000 },
    });
  });

  it('skips notification when notifierService is undefined', () => {
    const log = createMockLog();
    notifyGrab({ notifierService: undefined, title: 'Test', size: undefined, log });
  });

  it('catches and logs notification failures (fire-and-forget)', async () => {
    const notifier = createMockNotifier();
    (notifier.notify as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notify fail'));
    const log = createMockLog();
    notifyGrab({ notifierService: notifier, title: 'Test', size: undefined, log });
    // Allow microtask to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('recordGrabbedEvent', () => {
  let eventHistory: EventHistoryService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    eventHistory = createMockEventHistory();
    log = createMockLog();
  });

  it('records grabbed event with bookId, title, downloadId, source, and reason metadata', () => {
    recordGrabbedEvent({ eventHistory, bookId: 1, bookTitle: 'Test', downloadId: 5, source: 'auto', reason: { indexerId: 3, size: 100, protocol: 'torrent' }, log });
    expect(eventHistory.create).toHaveBeenCalledWith({
      bookId: 1, bookTitle: 'Test', downloadId: 5, eventType: 'grabbed', source: 'auto',
      reason: { indexerId: 3, size: 100, protocol: 'torrent' },
    });
  });

  it('preserves source parameter (e.g., rss)', () => {
    recordGrabbedEvent({ eventHistory, bookId: 1, bookTitle: 'Test', downloadId: 5, source: 'rss', reason: {}, log });
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'rss' }));
  });

  it('skips recording when eventHistory is undefined', () => {
    recordGrabbedEvent({ eventHistory: undefined, bookId: 1, bookTitle: 'Test', downloadId: 5, source: 'auto', reason: {}, log });
  });

  it('skips recording when bookId is undefined', () => {
    recordGrabbedEvent({ eventHistory, bookId: undefined, bookTitle: 'Test', downloadId: 5, source: 'auto', reason: {}, log });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('catches and logs recording failures with canonical serialized payload (fire-and-forget)', async () => {
    (eventHistory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('record fail'));
    recordGrabbedEvent({ eventHistory, bookId: 1, bookTitle: 'Test', downloadId: 5, source: 'auto', reason: {}, log });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'record fail', type: 'Error' }) }),
      'Failed to record grabbed event',
    );
  });
});

describe('recordDownloadCompletedEvent', () => {
  it('records download_completed event with progress:1 reason', () => {
    const eventHistory = createMockEventHistory();
    const log = createMockLog();
    recordDownloadCompletedEvent({ eventHistory, downloadId: 1, bookId: 2, bookTitle: 'Test', log });
    expect(eventHistory.create).toHaveBeenCalledWith({
      bookId: 2, bookTitle: 'Test', downloadId: 1, eventType: 'download_completed', source: 'auto',
      reason: { progress: 1 },
    });
  });

  it('skips recording when eventHistory is undefined', () => {
    const log = createMockLog();
    recordDownloadCompletedEvent({ eventHistory: undefined, downloadId: 1, bookId: 2, bookTitle: 'Test', log });
  });

  it('skips recording when bookId is undefined', () => {
    const eventHistory = createMockEventHistory();
    const log = createMockLog();
    recordDownloadCompletedEvent({ eventHistory, downloadId: 1, bookId: undefined, bookTitle: 'Test', log });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('catches and logs recording failures with canonical serialized payload (fire-and-forget)', async () => {
    const eventHistory = createMockEventHistory();
    (eventHistory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('record fail'));
    const log = createMockLog();
    recordDownloadCompletedEvent({ eventHistory, downloadId: 1, bookId: 2, bookTitle: 'Test', log });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'record fail', type: 'Error' }) }),
      'Failed to record download_completed event',
    );
  });
});

describe('recordDownloadFailedEvent', () => {
  let eventHistory: EventHistoryService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    eventHistory = createMockEventHistory();
    log = createMockLog();
  });

  it('records download_failed event with eventType, source auto, and error reason', () => {
    recordDownloadFailedEvent({ eventHistory, downloadId: 1, bookId: 2, bookTitle: 'Test', errorMessage: 'Connection lost', log });
    expect(eventHistory.create).toHaveBeenCalledWith({
      bookId: 2, bookTitle: 'Test', downloadId: 1, eventType: 'download_failed', source: 'auto',
      reason: { error: 'Connection lost' },
    });
  });

  it('skips recording when eventHistory is undefined', () => {
    recordDownloadFailedEvent({ eventHistory: undefined, downloadId: 1, bookId: 2, bookTitle: 'Test', errorMessage: 'fail', log });
    // No assertion needed — should not throw
  });

  it('skips recording when bookId is falsy', () => {
    recordDownloadFailedEvent({ eventHistory, downloadId: 1, bookId: undefined, bookTitle: 'Test', errorMessage: 'fail', log });
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('catches and logs recording failures with canonical serialized payload (fire-and-forget)', async () => {
    (eventHistory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('record fail'));
    recordDownloadFailedEvent({ eventHistory, downloadId: 1, bookId: 2, bookTitle: 'Test', errorMessage: 'fail', log });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'record fail', type: 'Error' }) }),
      'Failed to record download_failed event',
    );
  });

  it('passes errorMessage in reason.error field', () => {
    recordDownloadFailedEvent({ eventHistory, downloadId: 1, bookId: 2, bookTitle: 'Test', errorMessage: 'Cancelled by user', log });
    expect(eventHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { error: 'Cancelled by user' } }),
    );
  });
});
