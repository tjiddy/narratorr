import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { EventBroadcasterService, HEARTBEAT_INTERVAL_MS, type SSEClient } from './event-broadcaster.service.js';

function createMockClient(id: string): SSEClient {
  return {
    id,
    reply: {
      raw: {
        write: vi.fn(),
      },
    } as unknown as SSEClient['reply'],
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('EventBroadcasterService', () => {
  let broadcaster: EventBroadcasterService;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    broadcaster = new EventBroadcasterService(log);
  });

  describe('addClient / removeClient', () => {
    it('adds client to connection set', () => {
      const client = createMockClient('c1');
      broadcaster.addClient(client);
      expect(broadcaster.clientCount).toBe(1);
    });

    it('removes client from connection set', () => {
      const client = createMockClient('c1');
      broadcaster.addClient(client);
      broadcaster.removeClient(client);
      expect(broadcaster.clientCount).toBe(0);
    });

    it('concurrent connects and disconnects do not corrupt the set', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      const c3 = createMockClient('c3');
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);
      broadcaster.removeClient(c1);
      broadcaster.addClient(c3);
      broadcaster.removeClient(c2);
      expect(broadcaster.clientCount).toBe(1);
    });
  });

  describe('emit', () => {
    it('sends formatted SSE message to all connected clients', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);

      broadcaster.emit('download_progress', {
        download_id: 1, book_id: 2, percentage: 0.5, speed: 1024, eta: 300,
      });

      const expected = 'event: download_progress\ndata: {"download_id":1,"book_id":2,"percentage":0.5,"speed":1024,"eta":300}\n\n';
      expect(c1.reply.raw.write).toHaveBeenCalledWith(expected);
      expect(c2.reply.raw.write).toHaveBeenCalledWith(expected);
    });

    it('is a no-op with zero connected clients', () => {
      // Should not throw
      broadcaster.emit('grab_started', {
        download_id: 1, book_id: 2, book_title: 'Test', release_title: 'test.torrent',
      });
    });

    it('failure on one client does not prevent delivery to others', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      (c1.reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);

      broadcaster.emit('import_complete', {
        download_id: 1, book_id: 2, book_title: 'My Book',
      });

      // c2 still received the message
      expect(c2.reply.raw.write).toHaveBeenCalledTimes(1);
    });

    it('failed write removes client from connection set', () => {
      const c1 = createMockClient('c1');
      (c1.reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });
      broadcaster.addClient(c1);

      broadcaster.emit('review_needed', {
        download_id: 1, book_id: 2, book_title: 'Test',
      });

      expect(broadcaster.clientCount).toBe(0);
      expect(log.warn).toHaveBeenCalled();
    });

    it('handles null fields in event data safely', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);

      broadcaster.emit('download_progress', {
        download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null,
      });

      const expected = 'event: download_progress\ndata: {"download_id":1,"book_id":2,"percentage":0,"speed":null,"eta":null}\n\n';
      expect(c1.reply.raw.write).toHaveBeenCalledWith(expected);
    });

    it('handles progress at boundary values (0 and 1)', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);

      broadcaster.emit('download_progress', {
        download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null,
      });
      broadcaster.emit('download_progress', {
        download_id: 1, book_id: 2, percentage: 1, speed: 0, eta: 0,
      });

      expect(c1.reply.raw.write).toHaveBeenCalledTimes(2);
    });
  });

  // #1776 — periodic heartbeat keeps idle reverse proxies from cutting the stream.
  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      broadcaster.stop();
      vi.useRealTimers();
    });

    it('writes a heartbeat frame to every connected client at the fixed interval', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(c1.reply.raw.write).toHaveBeenCalledWith(':hb\n\n');
      expect(c2.reply.raw.write).toHaveBeenCalledWith(':hb\n\n');
    });

    it('fires periodically, not once (second interval sends another heartbeat)', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      const hbWrites = (c1.reply.raw.write as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === ':hb\n\n');
      expect(hbWrites).toHaveLength(2);
    });

    it('unref()s the heartbeat timer so it never holds the process open', () => {
      const unref = vi.fn();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
        .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

      broadcaster.addClient(createMockClient('c1'));

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('does not start a second timer when more clients connect', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      broadcaster.addClient(createMockClient('c1'));
      broadcaster.addClient(createMockClient('c2'));

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });

    it('stops the heartbeat once the last client disconnects — no dangling writes', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);
      broadcaster.removeClient(c1);
      (c1.reply.raw.write as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

      expect(c1.reply.raw.write).not.toHaveBeenCalled();
    });

    it('stop() halts the heartbeat even while clients remain connected', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);

      broadcaster.stop();
      (c1.reply.raw.write as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

      expect(c1.reply.raw.write).not.toHaveBeenCalled();
    });

    it('prunes a client that fails on a heartbeat write', () => {
      const c1 = createMockClient('c1');
      (c1.reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });
      broadcaster.addClient(c1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(broadcaster.clientCount).toBe(0);
    });
  });
});
