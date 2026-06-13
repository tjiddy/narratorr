import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { inject } from '../__tests__/helpers.js';
import authPlugin from '../plugins/auth.js';
import type { AuthService } from '../services/auth.service.js';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';

vi.mock('../config.js', () => ({
  config: { authBypass: false, isDev: true },
}));

const mockLog = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
};

describe('GET /api/events', () => {
  let broadcaster: EventBroadcasterService;

  beforeEach(() => {
    broadcaster = new EventBroadcasterService(inject<FastifyBaseLogger>(mockLog));
  });

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
    // Import the route handler factory
    const { eventsRoutes } = await import('./events.js');

    // Create a mock Fastify app that captures the route handler
    let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
    const mockApp = {
      get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        routeHandler = handler;
      },
    };

    await eventsRoutes(mockApp as never, broadcaster);
    expect(routeHandler).not.toBeNull();

    const { reply, request, writeHead, write, hijack, onClose } = createMockReplyAndRequest();
    await routeHandler!(request, reply);

    // Verifies Content-Type header
    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    }));

    // Verifies keepalive comment sent on connect
    expect(write).toHaveBeenCalledWith(':keepalive\n\n');

    // Verifies client added to broadcaster
    expect(broadcaster.clientCount).toBe(1);

    // Verifies hijack called to keep connection open
    expect(hijack).toHaveBeenCalled();

    // Verifies cleanup on close
    expect(onClose).toHaveBeenCalledWith('close', expect.any(Function));

    // Simulate close
    const closeHandler = onClose.mock.calls[0]![1] as () => void;
    closeHandler();
    expect(broadcaster.clientCount).toBe(0);
  });

  it('multiple clients receive same broadcast event', async () => {
    const { eventsRoutes } = await import('./events.js');

    let routeHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null;
    const mockApp = {
      get: (_path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
        routeHandler = handler;
      },
    };

    await eventsRoutes(mockApp as never, broadcaster);

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

  describe('auth integration', () => {
    // Auth plugin rejects before the SSE handler runs, so inject() completes normally
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
      await eventsRoutes(app, broadcaster);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events' });
      expect(res.statusCode).toBe(401);

      await app.close();
    });

    it('rejects the API key on /api/events even when valid (de-god-moded #1453)', async () => {
      // Post-#1453 the SSE endpoints are no longer API-key-reachable — they use a
      // short-lived stream token. A valid key on `/api/events` (a non-`v*` path)
      // is ignored; the forms-mode chain (no cookie) returns 401, and the key is
      // never validated.
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
      await eventsRoutes(app, broadcaster);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events?apikey=valid-key' });
      expect(res.statusCode).toBe(401);
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
      await eventsRoutes(app, broadcaster);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/events?token=bogus' });
      expect(res.statusCode).toBe(401);
      expect(authService.verifyStreamToken).toHaveBeenCalledWith('bogus', 'test-secret');

      await app.close();
    });
  });
});
