import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  EventBroadcasterService,
  HEARTBEAT_INTERVAL_MS,
  MAX_STREAM_AGE_MS,
  type SSEClient,
} from './event-broadcaster.service.js';

function createMockClient(id: string, connectedAt = Date.now()): SSEClient {
  return {
    id,
    connectedAt,
    reply: {
      raw: {
        write: vi.fn(),
        end: vi.fn(),
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

  // Heartbeats keep idle reverse proxies from cutting the stream.
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

      expect(c1.reply.raw.write).toHaveBeenCalledWith('event: hb\ndata: {}\n\n');
      expect(c2.reply.raw.write).toHaveBeenCalledWith('event: hb\ndata: {}\n\n');
    });

    it('fires periodically, not once (second interval sends another heartbeat)', () => {
      const c1 = createMockClient('c1');
      broadcaster.addClient(c1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      const hbWrites = (c1.reply.raw.write as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === 'event: hb\ndata: {}\n\n');
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

  // Fastify cannot reap hijacked SSE replies until shutdown ends them.
  describe('stop() ends client replies', () => {
    it('ends every connected client and clears the set', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);

      broadcaster.stop();

      expect(c1.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(c2.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(broadcaster.clientCount).toBe(0);
    });

    it('a client whose end() throws does not prevent the others being ended or the set clearing', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      (c1.reply.raw.end as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });
      broadcaster.addClient(c1);
      broadcaster.addClient(c2);

      expect(() => broadcaster.stop()).not.toThrow();

      expect(c2.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(broadcaster.clientCount).toBe(0);
    });

    it('is a no-op with zero connected clients', () => {
      expect(() => broadcaster.stop()).not.toThrow();
      expect(broadcaster.clientCount).toBe(0);
    });
  });

  // A reconnect during the shutdown drain must be ended or it blocks app.close() again.
  describe('addClient after stop() (drain-window reconnect)', () => {
    it('ends the late client immediately, does not register it, and clientCount stays 0', () => {
      broadcaster.stop();

      const late = createMockClient('late');
      broadcaster.addClient(late);

      expect(late.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(broadcaster.clientCount).toBe(0);
    });

    it('does not restart the heartbeat timer for a late client', () => {
      vi.useFakeTimers();
      try {
        broadcaster.stop();

        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        broadcaster.addClient(createMockClient('late'));

        expect(setIntervalSpy).not.toHaveBeenCalled();
        setIntervalSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a late client whose end() throws is still not registered and does not crash the shutdown path', () => {
      broadcaster.stop();

      const late = createMockClient('late');
      (late.reply.raw.end as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });

      expect(() => broadcaster.addClient(late)).not.toThrow();
      expect(broadcaster.clientCount).toBe(0);
    });
  });

  // Bound stream lifetime so replayed tokens cannot keep a stream indefinitely.
  describe('max-age sweep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      broadcaster.stop();
      vi.useRealTimers();
    });

    it('ends and removes a stale client while leaving a fresh client untouched and still heartbeating', () => {
      const now = Date.now();
      const stale = createMockClient('stale', now - (MAX_STREAM_AGE_MS + 1_000));
      const fresh = createMockClient('fresh', now);
      broadcaster.addClient(stale);
      broadcaster.addClient(fresh);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(stale.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(fresh.reply.raw.end).not.toHaveBeenCalled();
      expect(broadcaster.clientCount).toBe(1);
      expect(fresh.reply.raw.write).toHaveBeenCalledWith('event: hb\ndata: {}\n\n');
    });

    it('does not end a client whose age is exactly at the cap (> not >=)', () => {
      const now = Date.now();
      // First tick lands exactly at the cap; only strictly older clients expire.
      const atCap = createMockClient('at-cap', now - (MAX_STREAM_AGE_MS - HEARTBEAT_INTERVAL_MS));
      broadcaster.addClient(atCap);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(atCap.reply.raw.end).not.toHaveBeenCalled();
      expect(broadcaster.clientCount).toBe(1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(atCap.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(broadcaster.clientCount).toBe(0);
    });

    it('is fault-tolerant: a stale client whose end() throws is still removed, the sweep continues, and fresh clients still heartbeat', () => {
      const now = Date.now();
      const throwing = createMockClient('throwing', now - (MAX_STREAM_AGE_MS + 1_000));
      const otherStale = createMockClient('other-stale', now - (MAX_STREAM_AGE_MS + 1_000));
      const fresh = createMockClient('fresh', now);
      (throwing.reply.raw.end as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });
      broadcaster.addClient(throwing);
      broadcaster.addClient(otherStale);
      broadcaster.addClient(fresh);

      // A throw inside the setInterval callback would crash the process.
      expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)).not.toThrow();

      expect(otherStale.reply.raw.end).toHaveBeenCalledTimes(1);
      expect(broadcaster.clientCount).toBe(1);
      expect(fresh.reply.raw.write).toHaveBeenCalledWith('event: hb\ndata: {}\n\n');
    });
  });
  describe('emitTo', () => {
    const SNAPSHOT = { active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing' as const, percentage: 0.35 }], queued: [] };
    const FRAME = `event: merge_state\ndata: ${JSON.stringify(SNAPSHOT)}\n\n`;

    it('writes the framed event to the target client only', () => {
      const target = createMockClient('target');
      const bystander = createMockClient('bystander');
      broadcaster.addClient(target);
      broadcaster.addClient(bystander);

      broadcaster.emitTo(target, 'merge_state', SNAPSHOT);

      expect(target.reply.raw.write).toHaveBeenCalledWith(FRAME);
      expect(bystander.reply.raw.write).not.toHaveBeenCalled();
    });

    it('frames identically to the broadcast path', () => {
      const viaEmitTo = createMockClient('per-client');
      const viaEmit = createMockClient('broadcast');
      broadcaster.addClient(viaEmitTo);
      broadcaster.addClient(viaEmit);

      broadcaster.emitTo(viaEmitTo, 'merge_state', SNAPSHOT);
      broadcaster.emit('merge_state', SNAPSHOT);

      expect((viaEmitTo.reply.raw.write as ReturnType<typeof vi.fn>).mock.calls[0]![0])
        .toBe((viaEmit.reply.raw.write as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    });

    it('is a no-op for a client that was never registered', () => {
      const stranger = createMockClient('stranger');

      expect(() => broadcaster.emitTo(stranger, 'merge_state', SNAPSHOT)).not.toThrow();
      expect(stranger.reply.raw.write).not.toHaveBeenCalled();
    });

    it('is a no-op for a client refused during the shutdown drain — its reply is already ended', () => {
      broadcaster.stop();
      const lateClient = createMockClient('late');
      broadcaster.addClient(lateClient);
      (lateClient.reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('write after end');
      });

      expect(() => broadcaster.emitTo(lateClient, 'merge_state', SNAPSHOT)).not.toThrow();
      expect(lateClient.reply.raw.write).not.toHaveBeenCalled();
      expect(broadcaster.clientCount).toBe(0);
    });

    it('prunes the client and does not throw when the write fails', () => {
      const broken = createMockClient('broken');
      const healthy = createMockClient('healthy');
      broadcaster.addClient(broken);
      broadcaster.addClient(healthy);
      (broken.reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('broken pipe');
      });

      expect(() => broadcaster.emitTo(broken, 'merge_state', SNAPSHOT)).not.toThrow();

      expect(broadcaster.clientCount).toBe(1);
      expect(log.warn).toHaveBeenCalledWith({ clientId: 'broken' }, 'SSE client removed after write failure');
      broadcaster.emit('merge_state', SNAPSHOT);
      expect(healthy.reply.raw.write).toHaveBeenCalled();
    });
  });
});
