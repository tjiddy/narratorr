import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { safeEmit } from './safe-emit.js';

function mockBroadcaster(): EventBroadcasterService {
  return { emit: vi.fn() } as unknown as EventBroadcasterService;
}

function mockLog(): FastifyBaseLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('safeEmit', () => {
  describe('happy path', () => {
    it('calls broadcaster.emit with correct event type and payload', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();
      const payload = { download_id: 1, book_id: 2, percentage: 50, speed: null, eta: null };

      safeEmit(broadcaster, 'download_progress', payload, log);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', payload);
      expect(log.debug).not.toHaveBeenCalled();
    });

    it('returns void (fire-and-forget)', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();
      const result = safeEmit(broadcaster, 'download_progress', { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null }, log);

      expect(result).toBeUndefined();
    });
  });

  describe('null/undefined broadcaster', () => {
    it('null broadcaster is a no-op with no error and no log call', () => {
      const log = mockLog();

      expect(() => safeEmit(null, 'download_progress', { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null }, log)).not.toThrow();
      expect(log.debug).not.toHaveBeenCalled();
    });

    it('undefined broadcaster is a no-op with no error and no log call', () => {
      const log = mockLog();

      expect(() => safeEmit(undefined, 'download_progress', { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null }, log)).not.toThrow();
      expect(log.debug).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('catches Error thrown by broadcaster.emit and logs at debug level', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();
      const error = new Error('write failed');
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw error; });

      expect(() => safeEmit(broadcaster, 'download_progress', { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null }, log)).not.toThrow();
      expect(log.debug).toHaveBeenCalledWith(error, 'SSE emit failed for download_progress');
    });

    it('catches non-Error value thrown by broadcaster.emit and logs at debug level', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw 'string error'; });

      expect(() => safeEmit(broadcaster, 'grab_started', { book_id: 1, book_title: 'test', release_title: 'y', download_id: 1 }, log)).not.toThrow();
      expect(log.debug).toHaveBeenCalledWith('string error', 'SSE emit failed for grab_started');
    });

    it('log message includes event type for diagnostics', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();
      vi.mocked(broadcaster.emit).mockImplementation(() => { throw new Error('fail'); });

      safeEmit(broadcaster, 'merge_complete', { book_id: 1, book_title: 'test', success: true, message: 'done' }, log);

      expect(log.debug).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('merge_complete'),
      );
    });
  });

  describe('type safety', () => {
    it('rejects invalid event names at compile time', () => {
      const broadcaster = mockBroadcaster();
      const log = mockLog();

      // Valid event compiles fine
      safeEmit(broadcaster, 'download_progress', { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null }, log);

      // @ts-expect-error — invalid event name must fail compilation
      safeEmit(broadcaster, 'not_a_real_event', {}, log);
    });
  });
});
