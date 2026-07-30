import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Db } from '@db/index.js';
import {
  mockDbChain,
  createMockServices,
  resetMockServices,
  createTestApp,
  createAuthTestApp,
  stubAuthService,
  inject,
  BASIC_AUTH_HEADER,
  FORMS_SESSION_COOKIE,
  type ZodTestApp,
} from './helpers.js';

describe('mockDbChain', () => {
  describe('core chain behavior', () => {
    it('returns the chain when calling any Drizzle method', () => {
      const chain = mockDbChain();
      const result = chain.where('x');
      expect(result).toBe(chain);
    });

    it('supports arbitrary method ordering', () => {
      const chain = mockDbChain();
      const result = chain.limit(10).where('x').orderBy('y');
      expect(result).toBe(chain);
    });

    it('supports same method called multiple times', () => {
      const chain = mockDbChain();
      const result = chain.where('a').where('b');
      expect(result).toBe(chain);
    });

    it('resolves to configured result when awaited', async () => {
      const data = [{ id: 1, title: 'Test' }];
      const chain = mockDbChain(data);
      const result = await chain;
      expect(result).toBe(data);
    });

    it('resolves to configured result with no chain methods called', async () => {
      const data = [{ id: 1 }];
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });

    it('defaults to empty array when no result argument provided', async () => {
      const result = await mockDbChain();
      expect(result).toEqual([]);
    });
  });

  describe('Proxy auto-discovery', () => {
    it('auto-generates stubs for previously unsupported methods', () => {
      const chain = mockDbChain();
      // These methods were never in the old hard-coded list
      const result = chain.having('x').onConflictDoNothing().distinct();
      expect(result).toBe(chain);
    });

    it('returns the same vi.fn() instance on repeat property access', () => {
      const chain = mockDbChain();
      const first = chain.where;
      const second = chain.where;
      expect(first).toBe(second);
    });

    it('returns promise protocol handlers for then/catch/finally, not chainable stubs', () => {
      const chain = mockDbChain();
      expect(typeof chain.then).toBe('function');
      expect(typeof chain.catch).toBe('function');
      expect(typeof chain.finally).toBe('function');
      // These should NOT be vi.fn() stubs
      expect(chain.then).not.toHaveProperty('mock');
      expect(chain.catch).not.toHaveProperty('mock');
      expect(chain.finally).not.toHaveProperty('mock');
    });

    it('returns undefined for Symbol property access', () => {
      const chain = mockDbChain();
      expect(chain[Symbol.toPrimitive]).toBeUndefined();
      expect(chain[Symbol.iterator]).toBeUndefined();
    });
  });

  describe('argument capture', () => {
    it('captures arguments passed to where() via mock.calls', () => {
      const chain = mockDbChain();
      chain.where('id = ?', 42);
      expect(chain.where).toHaveBeenCalledWith('id = ?', 42);
    });

    it('captures arguments for set(), values(), onConflictDoUpdate()', () => {
      const chain = mockDbChain();
      chain.set({ title: 'New' });
      chain.values({ id: 1 });
      chain.onConflictDoUpdate({ target: 'id' });
      expect(chain.set).toHaveBeenCalledWith({ title: 'New' });
      expect(chain.values).toHaveBeenCalledWith({ id: 1 });
      expect(chain.onConflictDoUpdate).toHaveBeenCalledWith({ target: 'id' });
    });

    it('captures per-call arguments when method is called multiple times', () => {
      const chain = mockDbChain();
      chain.where('a');
      chain.where('b');
      expect(chain.where.mock.calls).toEqual([['a'], ['b']]);
    });
  });

  describe('terminal methods', () => {
    it('get() returns Promise.resolve(result) instead of chain', async () => {
      const data = { id: 1, title: 'Test' };
      const chain = mockDbChain(data);
      const result = await chain.where('x').get();
      expect(result).toBe(data);
    });

    it('all() returns Promise.resolve(result) instead of chain', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await chain.all();
      expect(result).toBe(data);
    });

    it('run() returns Promise.resolve(result) instead of chain', async () => {
      const data = { changes: 1 };
      const chain = mockDbChain(data);
      const result = await chain.run();
      expect(result).toBe(data);
    });

    it('execute() returns Promise.resolve(result) instead of chain', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await chain.execute();
      expect(result).toBe(data);
    });
  });

  describe('thenable protocol — success path', () => {
    it('then() resolves to configured result', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await new Promise(resolve => chain.then(resolve));
      expect(result).toBe(data);
    });

    it('catch() is not invoked on success', async () => {
      const chain = mockDbChain([{ id: 1 }]);
      const catchFn = vi.fn();
      await chain.then(() => {}).catch(catchFn);
      expect(catchFn).not.toHaveBeenCalled();
    });

    it('finally() handler executes on success', async () => {
      const chain = mockDbChain([{ id: 1 }]);
      const finallyFn = vi.fn();
      await chain.then(() => {}).finally(finallyFn);
      expect(finallyFn).toHaveBeenCalled();
    });
  });

  describe('thenable protocol — error path', () => {
    it('rejects with configured error when error option is set', async () => {
      const error = new Error('UNIQUE constraint failed');
      const chain = mockDbChain(undefined, { error });
      await expect(chain).rejects.toThrow('UNIQUE constraint failed');
    });

    it('catch() handler receives the configured error', async () => {
      const error = new Error('fail');
      const chain = mockDbChain(undefined, { error });
      const caught = await chain.catch((e: Error) => e);
      expect(caught).toBe(error);
    });

    it('finally() handler executes on rejection', async () => {
      const error = new Error('fail');
      const chain = mockDbChain(undefined, { error });
      const finallyFn = vi.fn();
      await chain.catch(() => {}).finally(finallyFn);
      expect(finallyFn).toHaveBeenCalled();
    });

    it('existing mockDbChain(data) without error option still resolves', async () => {
      const data = [{ id: 1 }];
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });
  });

  describe('edge cases', () => {
    it('resolves to null when result is configured as null', async () => {
      const result = await mockDbChain(null);
      expect(result).toBeNull();
    });

    it('resolves to single object when result is not an array', async () => {
      const data = { id: 1, title: 'Test' };
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });

    it('returns same result on multiple awaits', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const first = await chain;
      const second = await chain;
      expect(first).toBe(data);
      expect(second).toBe(data);
    });
  });
});

describe('createMockServices / resetMockServices — canonical default contract', () => {
  // The Proxy auto-stubs every accessed method at runtime, but TypeScript narrows the
  // service to its production interface. Cast through unknown so we can drive the
  // generic methodName -> Promise contract without depending on a specific signature.
  type AnyMock = ReturnType<typeof vi.fn>;
  const asMock = (fn: unknown): AnyMock => fn as AnyMock;
  const callAsync = (fn: unknown): Promise<unknown> => (fn as () => Promise<unknown>)();

  it('unconfigured service method rejects with a descriptive error when awaited', async () => {
    const services = createMockServices();
    await expect(callAsync(services.book.getById)).rejects.toThrow(
      /mock not configured: book\.getById/,
    );
  });

  it('explicit mockResolvedValue overrides the rejecting default', async () => {
    const services = createMockServices();
    asMock(services.book.getById).mockResolvedValue({ id: 1, title: 'Test' });

    const result = await callAsync(services.book.getById);
    expect(result).toEqual({ id: 1, title: 'Test' });
  });

  it('resetMockServices restores the rejecting default after a successful override', async () => {
    const services = createMockServices();
    const fn = asMock(services.book.getById);
    fn.mockResolvedValue({ id: 7 });

    // Sanity: override is in effect
    await expect(callAsync(services.book.getById)).resolves.toEqual({ id: 7 });

    resetMockServices(services);

    // Default restored
    await expect(callAsync(services.book.getById)).rejects.toThrow(
      /mock not configured: book\.getById/,
    );

    // Post-reset reconfiguration still works
    fn.mockResolvedValue({ id: 99 });
    await expect(callAsync(services.book.getById)).resolves.toEqual({ id: 99 });
  });

  it('fire-and-forget .catch chain swallows the default rejection without leaking', async () => {
    const services = createMockServices();
    const caught: unknown[] = [];
    // Simulate a fire-and-forget production chain like
    // `notifier.notify(...).catch(noop)`. The notifier proxy returns a vi.fn at runtime
    // for any property access, regardless of NotifierService's strict signature.
    await callAsync(services.notifier.notify).catch((err: unknown) => {
      caught.push(err);
    });
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(Error);
    expect((caught[0] as Error).message).toMatch(/mock not configured: notifier\.notify/);
  });
});

describe('createAuthTestApp', () => {
  /**
   * One multi-method probe plus a dynamic-param probe, so both verbs exist on the
   * same path (the CSRF gate short-circuits on GET but not on POST) and the
   * `maxParamLength` case has a route to match.
   */
  const probeRoutes = (app: ZodTestApp) => {
    app.route({ method: ['GET', 'POST'], url: '/api/__probe', handler: async () => ({ ok: true }) });
    app.get('/api/__probe/:token', async () => ({ ok: true }));
  };

  const SESSION = (value: string) => ({ cookie: `narratorr_session=${value}` });

  it('installs authPlugin where createTestApp does not — the trap, pinned structurally', async () => {
    // `authPlugin` calls `app.decorateRequest('user', null)`; nothing else does. So the
    // decorator's presence observes the plugin's INSTALLATION, not some status code that an
    // unrelated 403/404 could also produce.
    const plain = await createTestApp(createMockServices());
    try {
      expect(plain.hasRequestDecorator('user')).toBe(false);
    } finally {
      await plain.close();
    }

    const { app } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
    try {
      expect(app.hasRequestDecorator('user')).toBe(true);
    } finally {
      await app.close();
    }
  });

  describe('basic mode (default)', () => {
    it('403s a credentialed POST with no X-Requested-With', async () => {
      const { app, authHeader } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
      try {
        const res = await app.inject({ method: 'POST', url: '/api/__probe', headers: { authorization: authHeader } });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error).toMatch(/CSRF/);
      } finally {
        await app.close();
      }
    });

    it('lets a credentialed POST through with X-Requested-With', async () => {
      const { app, authHeader } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/__probe',
          headers: { authorization: authHeader, 'x-requested-with': 'XMLHttpRequest' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });

    it('401s an uncredentialed POST with a Basic challenge', async () => {
      const { app } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
      try {
        const res = await app.inject({ method: 'POST', url: '/api/__probe' });
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Basic realm="Narratorr"');
      } finally {
        await app.close();
      }
    });

    it('lets a credentialed GET through without X-Requested-With — SAFE_METHODS short-circuits CSRF', async () => {
      const { app, authHeader } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: authHeader } });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('matches a >100-char path param — the helper raises maxParamLength off Fastify\'s 100 default', async () => {
      const { app, authHeader } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
      try {
        // Credentialed on purpose: without it the auth hook 401s even on a matched route,
        // so the assertion could not distinguish route matching from auth rejection.
        const res = await app.inject({
          method: 'GET',
          url: `/api/__probe/${'t'.repeat(180)}`,
          headers: { authorization: authHeader },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });
  });

  describe('forms mode', () => {
    const build = () => createAuthTestApp(createMockServices(), { mode: 'forms', routes: probeRoutes });

    it('authenticates the sentinel session cookie', async () => {
      const { app } = await build();
      try {
        const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: SESSION(FORMS_SESSION_COOKIE) });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('401s "Authentication required" with no cookie at all', async () => {
      const { app } = await build();
      try {
        const res = await app.inject({ method: 'GET', url: '/api/__probe' });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload)).toEqual({ error: 'Authentication required' });
      } finally {
        await app.close();
      }
    });

    it('401s "Invalid or expired session" on a cookie that does not verify', async () => {
      const { app } = await build();
      try {
        const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: SESSION('not-the-sentinel') });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid or expired session' });
      } finally {
        await app.close();
      }
    });

    it('does NOT apply CSRF — a cookie-authenticated POST without X-Requested-With reaches the handler', async () => {
      const { app } = await build();
      try {
        const res = await app.inject({ method: 'POST', url: '/api/__probe', headers: SESSION(FORMS_SESSION_COOKIE) });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  it('stubAuthService can re-arm the stubs that resetMockServices tears down', async () => {
    const services = createMockServices();
    const { app, authHeader } = await createAuthTestApp(services, { routes: probeRoutes });
    try {
      const post = () => app.inject({ method: 'POST', url: '/api/__probe', headers: { authorization: authHeader } });

      expect((await post()).statusCode).toBe(403);

      // resetMockServices re-applies the rejecting canonical default to getStatus, so the
      // onRequest hook throws and the global error handler masks it as a 500.
      resetMockServices(services);
      expect((await post()).statusCode).toBe(500);

      stubAuthService(services);
      expect((await post()).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('honours an auth-stub override applied AFTER the app is built', async () => {
    const services = createMockServices();
    const { app, authHeader } = await createAuthTestApp(services, { routes: probeRoutes });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: authHeader } })).statusCode).toBe(200);

      // The onRequest hook resolves authService methods per request, so this takes effect.
      (services.auth.verifyCredentials as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: authHeader } });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid credentials' });
    } finally {
      await app.close();
    }
  });

  it('runs opts.register BEFORE opts.routes', async () => {
    let decoratorVisibleToRoutes: boolean | undefined;
    const { app } = await createAuthTestApp(createMockServices(), {
      register: (instance) => { instance.decorate('probeMarker', 'from-register'); },
      routes: (instance) => {
        // Read at REGISTRATION time — if `register` ran second this would be false.
        decoratorVisibleToRoutes = instance.hasDecorator('probeMarker');
        probeRoutes(instance);
      },
    });
    try {
      expect(decoratorVisibleToRoutes).toBe(true);
    } finally {
      await app.close();
    }
  });

  describe('opts.db', () => {
    it('passes the caller-supplied db through to opts.routes by identity', async () => {
      const sentinelDb = inject<Db>({ marker: 'sentinel' });
      let received: Db | undefined;
      const { app } = await createAuthTestApp(createMockServices(), {
        db: sentinelDb,
        routes: (instance, _services, db) => { received = db; probeRoutes(instance); },
      });
      try {
        expect(received).toBe(sentinelDb);
      } finally {
        await app.close();
      }
    });

    it('defaults to a db stub whose run() resolves', async () => {
      let received: Db | undefined;
      const { app } = await createAuthTestApp(createMockServices(), {
        routes: (instance, _services, db) => { received = db; probeRoutes(instance); },
      });
      try {
        expect(received).toBeDefined();
        await expect((received as unknown as { run: () => Promise<unknown> }).run()).resolves.toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });

  it('refuses to build while AUTH_BYPASS is enabled', async () => {
    // Drive the config MODULE rather than the ambient environment: `config.ts` parses
    // AUTH_BYPASS at boot and only the literal 'true' enables it, and suites hoist their own
    // `../config.js` mocks. Precedent: src/server/routes/import-preview.test.ts.
    vi.resetModules();
    vi.doMock('../config.js', () => ({ config: { authBypass: true, isDev: true } }));
    try {
      const freshHelpers = await import('./helpers.js');
      await expect(
        freshHelpers.createAuthTestApp(freshHelpers.createMockServices(), { routes: () => {} }),
      ).rejects.toThrow(/AUTH_BYPASS/);
    } finally {
      vi.doUnmock('../config.js');
      vi.resetModules();
    }
  });

  it('exposes the first-user setup exemption through a post-build hasUser override', async () => {
    const services = createMockServices();
    const { app } = await createAuthTestApp(services, {
      routes: (instance) => {
        instance.post('/api/auth/setup', async () => ({ ok: true }));
        probeRoutes(instance);
      },
    });
    try {
      const setup = () => app.inject({ method: 'POST', url: '/api/auth/setup' });

      // Profile default hasUser=true: /api/auth/setup is deliberately absent from
      // BASE_PUBLIC_ROUTES, so it is protected once a user exists.
      expect((await setup()).statusCode).toBe(401);

      // The exemption is read per request, ahead of both the AUTH_BYPASS check and the
      // mode dispatch — so flipping it post-build reaches the handler.
      (services.auth.hasUser as Mock).mockResolvedValue(false);
      const exempt = await setup();
      expect(exempt.statusCode).toBe(200);
      expect(JSON.parse(exempt.payload)).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('exports exactly one basic-auth credential and returns it as authHeader', async () => {
    const { app, authHeader } = await createAuthTestApp(createMockServices(), { routes: probeRoutes });
    try {
      expect(authHeader).toBe(BASIC_AUTH_HEADER);
      expect(Buffer.from(authHeader.slice(6), 'base64').toString()).toBe('admin:password123');
    } finally {
      await app.close();
    }
  });
});
