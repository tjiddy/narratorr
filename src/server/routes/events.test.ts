import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { inject } from '../__tests__/helpers.js';
import authPlugin from '../plugins/auth.js';
import { fetchSseEvents } from '../__tests__/sse-helpers.js';
import type { AuthService } from '../services/auth.service.js';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { MergeStateSource } from './events.js';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';

vi.mock('../config.js', () => ({
  config: { authBypass: false, isDev: true },
}));

const mockLog = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
};

describe('GET /api/events', () => {
  let broadcaster: EventBroadcasterService;
  // Reassignable so tests can change the connect-time snapshot at a precise moment.
  let snapshot: MergeStateSnapshot;
  let mergeState: MergeStateSource;

  beforeEach(() => {
    broadcaster = new EventBroadcasterService(inject<FastifyBaseLogger>(mockLog));
    snapshot = { active: [], queued: [] };
    mergeState = { getMergeStateSnapshot: vi.fn(() => snapshot) };
  });

  function mergeStateFrames(write: ReturnType<typeof vi.fn>): unknown[] {
    return write.mock.calls
      .map((c) => String(c[0]))
      .filter((frame) => frame.startsWith('event: merge_state\n'))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length)));
  }

  function createMockReplyAndRequest() {
    const writeHead = vi.fn();
    const write = vi.fn();
    const hijack = vi.fn();
    const onClose = vi.fn();

    const reply = {
      raw: { writeHead, write },
      hijack,
    } as unknown as FastifyReply;

    const request = {
      raw: { on: onClose },
    } as unknown as FastifyRequest;

    return { reply, request, writeHead, write, hijack, onClose };
  }

  it('sets correct SSE headers and sends keepalive', async () => {
    const { eventsRoutes } = await import('./events.js');

    let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
    const mockApp = {
      get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        routeHandler = handler;
      },
    };

    await eventsRoutes(mockApp as never, broadcaster, mergeState);
    expect(routeHandler).not.toBeNull();

    const { reply, request, writeHead, write, hijack, onClose } = createMockReplyAndRequest();
    await routeHandler!(request, reply);

    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    }));

    expect(write).toHaveBeenCalledWith(':keepalive\n\n');

    expect(broadcaster.clientCount).toBe(1);

    expect(hijack).toHaveBeenCalled();

    expect(onClose).toHaveBeenCalledWith('close', expect.any(Function));

    const closeHandler = onClose.mock.calls[0]![1] as () => void;
    closeHandler();
    expect(broadcaster.clientCount).toBe(0);
  });

  it('stamps the registered client with connectedAt = Date.now() at registration (#1796)', async () => {
    // Broadcaster max-age security depends on connectedAt; service tests use hand-built clients,
    // so freeze and assert the timestamp at the route registration boundary.
    const { eventsRoutes } = await import('./events.js');

    let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
    const mockApp = {
      get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        routeHandler = handler;
      },
    };

    await eventsRoutes(mockApp as never, broadcaster, mergeState);

    const NOW = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const addClientSpy = vi.spyOn(broadcaster, 'addClient');

    const { reply, request } = createMockReplyAndRequest();
    await routeHandler!(request, reply);

    expect(addClientSpy).toHaveBeenCalledTimes(1);
    const registered = addClientSpy.mock.calls[0]![0];
    expect(registered.connectedAt).toBe(NOW);

    dateNowSpy.mockRestore();
  });

  it('multiple clients receive same broadcast event', async () => {
    const { eventsRoutes } = await import('./events.js');

    let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
    const mockApp = {
      get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        routeHandler = handler;
      },
    };

    await eventsRoutes(mockApp as never, broadcaster, mergeState);

    const mock1 = createMockReplyAndRequest();
    const mock2 = createMockReplyAndRequest();

    await routeHandler!(mock1.request, mock1.reply);
    await routeHandler!(mock2.request, mock2.reply);

    expect(broadcaster.clientCount).toBe(2);

    broadcaster.emit('grab_started', {
      download_id: 1, book_id: 2, book_title: 'Test', release_title: 'test.torrent',
    });

    const expected = expect.stringContaining('event: grab_started');
    expect(mock1.write).toHaveBeenCalledWith(expected);
    expect(mock2.write).toHaveBeenCalledWith(expected);
  });

  describe('merge_state connect greeting', () => {
    async function captureHandler(): Promise<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> {
      const { eventsRoutes } = await import('./events.js');
      let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
      const mockApp = {
        get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
          routeHandler = handler;
        },
      };
      await eventsRoutes(mockApp as never, broadcaster, mergeState);
      return routeHandler!;
    }

    it('writes headers, the keepalive comment, then exactly one merge_state frame matching the service snapshot', async () => {
      snapshot = {
        active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing', percentage: 0.35 }],
        queued: [{ book_id: 43, book_title: 'The Shining' }],
      };
      const routeHandler = await captureHandler();
      const { reply, request, writeHead, write } = createMockReplyAndRequest();

      await routeHandler(request, reply);

      expect(writeHead).toHaveBeenCalled();
      const frames = write.mock.calls.map((c) => String(c[0]));
      expect(frames[0]).toBe(':keepalive\n\n');
      expect(frames[1]).toBe(`event: merge_state\ndata: ${JSON.stringify(snapshot)}\n\n`);
      expect(mergeStateFrames(write)).toEqual([snapshot]);
    });

    it('greets with an empty snapshot too — a client reconnecting across a missed terminal event must clear stale chips', async () => {
      const routeHandler = await captureHandler();
      const { reply, request, write } = createMockReplyAndRequest();

      await routeHandler(request, reply);

      expect(mergeStateFrames(write)).toEqual([{ active: [], queued: [] }]);
    });

    it('greets only the connecting client, and no other event type gains a greeting', async () => {
      const routeHandler = await captureHandler();
      const first = createMockReplyAndRequest();
      await routeHandler(first.request, first.reply);
      first.write.mockClear();

      const second = createMockReplyAndRequest();
      await routeHandler(second.request, second.reply);

      expect(mergeStateFrames(second.write)).toHaveLength(1);
      expect(first.write).not.toHaveBeenCalled();
      expect(second.write.mock.calls.map((c) => String(c[0]).split('\n')[0])).toEqual([':keepalive', 'event: merge_state']);
    });

    it('sends the snapshot as it stood at registration — an await in between would ship a stale one (F2)', async () => {
      // A suspension after registration lets a broadcast beat the greeting, then the stale greeting
      // overwrites it. Trigger a microtask at addClient because call-order spies cannot expose that race.
      const AT_REGISTRATION: MergeStateSnapshot = { active: [], queued: [{ book_id: 43, book_title: 'The Shining' }] };
      const AFTER_A_SUSPENSION: MergeStateSnapshot = { active: [], queued: [] };
      snapshot = AT_REGISTRATION;

      const register = broadcaster.addClient.bind(broadcaster);
      const addClientSpy = vi.spyOn(broadcaster, 'addClient').mockImplementation((client) => {
        queueMicrotask(() => { snapshot = AFTER_A_SUSPENSION; });
        register(client);
      });

      const routeHandler = await captureHandler();
      const { reply, request, write } = createMockReplyAndRequest();

      await routeHandler(request, reply);

      expect(addClientSpy).toHaveBeenCalledTimes(1);
      expect(mergeStateFrames(write)).toEqual([AT_REGISTRATION]);
      // Prove the scheduled sentinel ran; otherwise the race assertion is vacuous.
      await Promise.resolve();
      expect(snapshot).toBe(AFTER_A_SUSPENSION);
      addClientSpy.mockRestore();
    });

    it('is a no-op when registration was refused during the shutdown drain window (AC6)', async () => {
      broadcaster.stop();
      const routeHandler = await captureHandler();
      const { reply, request, write } = createMockReplyAndRequest();
      (reply.raw as unknown as { end: () => void }).end = vi.fn();

      await expect(routeHandler(request, reply)).resolves.toBeUndefined();

      expect(broadcaster.clientCount).toBe(0);
      expect(mergeStateFrames(write)).toEqual([]);
    });

    it('delivers merge_state as the first event on a real stream', async () => {
      snapshot = { active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'staging' }], queued: [] };
      const app = Fastify({ logger: false });
      const { eventsRoutes } = await import('./events.js');
      await eventsRoutes(app, broadcaster, mergeState);
      await app.ready();

      // Stop the endless stream so the finite-stream helper can resolve res.text().
      const streamed = fetchSseEvents(app, '/api/events');
      await vi.waitFor(() => expect(broadcaster.clientCount).toBe(1));
      broadcaster.stop();

      const { events } = await streamed;
      expect(events[0]).toMatchObject({ event: 'merge_state', data: snapshot });

      await app.close();
    });
  });

  describe('auth integration', () => {
    // Pre-handler auth rejection keeps inject finite despite the endless SSE handler.
    it('returns 401 when no auth credentials provided and auth mode is forms', async () => {
      const authService = {
        validateApiKey: vi.fn().mockResolvedValue(false),
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        hasUser: vi.fn().mockResolvedValue(true),
      } as unknown as AuthService;

      const app = Fastify({ logger: false });
      await app.register(cookie);
      await app.register(authPlugin, { authService });

      const { eventsRoutes } = await import('./events.js');
      await eventsRoutes(app, broadcaster, mergeState);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events' });
      expect(res.statusCode).toBe(401);

      await app.close();
    });

    it('rejects the API key on /api/events even when valid, with the API-key 401 body (de-god-moded #1453)', async () => {
      // SSE accepts short-lived stream tokens, not API keys; this non-v1 path never validates the key
      // and must return the canonical API-key error body.
      const authService = {
        validateApiKey: vi.fn().mockResolvedValue(true),
        getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
        verifyStreamToken: vi.fn().mockReturnValue(null),
        verifySessionCookie: vi.fn().mockReturnValue(null),
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        hasUser: vi.fn().mockResolvedValue(true),
      } as unknown as AuthService;

      const app = Fastify({ logger: false });
      await app.register(cookie);
      await app.register(authPlugin, { authService });

      const { eventsRoutes } = await import('./events.js');
      await eventsRoutes(app, broadcaster, mergeState);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events?apikey=valid-key' });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid API key' });
      expect(authService.validateApiKey).not.toHaveBeenCalled();

      await app.close();
    });

    it('rejects an invalid stream token on /api/events (forms mode, no cookie)', async () => {
      const authService = {
        validateApiKey: vi.fn().mockResolvedValue(false),
        getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
        verifyStreamToken: vi.fn().mockReturnValue(null),
        verifySessionCookie: vi.fn().mockReturnValue(null),
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        hasUser: vi.fn().mockResolvedValue(true),
      } as unknown as AuthService;

      const app = Fastify({ logger: false });
      await app.register(cookie);
      await app.register(authPlugin, { authService });

      const { eventsRoutes } = await import('./events.js');
      await eventsRoutes(app, broadcaster, mergeState);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events?token=bogus' });
      expect(res.statusCode).toBe(401);
      expect(authService.verifyStreamToken).toHaveBeenCalledWith('bogus', 'test-secret');

      await app.close();
    });
  });
});
