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
  type CreateAuthTestAppOptions,
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
  // Cast through unknown to test the Proxy's generic method contract despite production interface narrowing.
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

    await expect(callAsync(services.book.getById)).resolves.toEqual({ id: 7 });

    resetMockServices(services);

    await expect(callAsync(services.book.getById)).rejects.toThrow(
      /mock not configured: book\.getById/,
    );

    fn.mockResolvedValue({ id: 99 });
    await expect(callAsync(services.book.getById)).resolves.toEqual({ id: 99 });
  });

  it('fire-and-forget .catch chain swallows the default rejection without leaking', async () => {
    const services = createMockServices();
    const caught: unknown[] = [];
    // Runtime Proxy methods remain catchable promises despite the notifier's strict production signature.
    await callAsync(services.notifier.notify).catch((err: unknown) => {
      caught.push(err);
    });
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(Error);
    expect((caught[0] as Error).message).toMatch(/mock not configured: notifier\.notify/);
  });
});

describe('createAuthTestApp', () => {
  // Shared probe covers verb-sensitive CSRF and long dynamic-parameter routing.
  const probeRoutes = (app: ZodTestApp) => {
    app.route({ method: ['GET', 'POST'], url: '/api/__probe', handler: async () => ({ ok: true }) });
    app.get('/api/__probe/:token', async () => ({ ok: true }));
  };

  const SESSION = (value: string) => ({ cookie: `narratorr_session=${value}` });

  it('installs authPlugin where createTestApp does not — the trap, pinned structurally', async () => {
    // Only authPlugin installs the user decorator, avoiding false positives from unrelated HTTP errors.
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
        // Credentials keep auth rejection from masquerading as a route-length failure.
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

      // Reset restores rejecting auth defaults, which the global handler exposes as 500.
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

      (services.auth.verifyCredentials as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: authHeader } });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Invalid credentials' });
    } finally {
      await app.close();
    }
  });

  it('returns the caller\'s own services object, by identity', async () => {
    const services = createMockServices();
    const built = await createAuthTestApp(services, { routes: probeRoutes });
    try {
      expect(built.services).toBe(services);
    } finally {
      await built.app.close();
    }
  });

  it('runs opts.register BEFORE opts.routes', async () => {
    let decoratorVisibleToRoutes: boolean | undefined;
    const { app } = await createAuthTestApp(createMockServices(), {
      register: (instance) => { instance.decorate('probeMarker', 'from-register'); },
      routes: (instance) => {
        // Read during registration so later ordering cannot satisfy the assertion.
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

  // Direct assertions cover profile cells authPlugin never reads on these probe routes.
  describe('stubAuthService — the exact profiles', () => {
    const call = <T>(fn: unknown, ...args: unknown[]): T =>
      (fn as (...a: unknown[]) => T)(...args);

    it('basic: status, hasUser, a rejected API key, and any-password credentials', async () => {
      const services = createMockServices();
      stubAuthService(services);

      await expect(call<Promise<unknown>>(services.auth.getStatus)).resolves.toEqual({
        mode: 'basic', hasUser: true, localBypass: false,
      });
      await expect(call<Promise<unknown>>(services.auth.hasUser)).resolves.toBe(true);
      await expect(call<Promise<unknown>>(services.auth.validateApiKey, 'any-key')).resolves.toBe(false);
      // A different password proves the basic stub accepts any credential for admin.
      await expect(
        call<Promise<unknown>>(services.auth.verifyCredentials, 'admin', 'a-totally-different-password'),
      ).resolves.toEqual({ username: 'admin' });
    });

    it('forms: status, hasUser, a rejected API key, and the exact session-cookie triple', async () => {
      // Fake only Date; full fake timers stall unrelated repository machinery.
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = new Date('2026-07-30T12:00:00.000Z').getTime();
      vi.setSystemTime(now);
      try {
        const services = createMockServices();
        stubAuthService(services, 'forms');

        await expect(call<Promise<unknown>>(services.auth.getStatus)).resolves.toEqual({
          mode: 'forms', hasUser: true, localBypass: false,
        });
        await expect(call<Promise<unknown>>(services.auth.hasUser)).resolves.toBe(true);
        await expect(call<Promise<unknown>>(services.auth.validateApiKey, 'any-key')).resolves.toBe(false);

        await expect(call<Promise<unknown>>(services.auth.getSessionSecret)).resolves.toBe('test-secret');
        expect(call<string>(services.auth.createSessionCookie, 'admin', 'test-secret')).toBe(FORMS_SESSION_COOKIE);

        expect(call<unknown>(services.auth.verifySessionCookie, FORMS_SESSION_COOKIE, 'test-secret')).toEqual({
          payload: { username: 'admin', kind: 'session', issuedAt: now, expiresAt: now + 3_600_000 },
          shouldRenew: false,
        });
        expect(call<unknown>(services.auth.verifySessionCookie, 'some-other-cookie', 'test-secret')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('basic leaves the session methods unstubbed, and forms leaves verifyCredentials unstubbed', async () => {
      // Disjoint profiles retain rejecting defaults for methods the selected mode must not use.
      const basic = createMockServices();
      stubAuthService(basic);
      await expect(call<Promise<unknown>>(basic.auth.getSessionSecret)).rejects.toThrow(
        /mock not configured: auth\.getSessionSecret/,
      );

      const forms = createMockServices();
      stubAuthService(forms, 'forms');
      await expect(call<Promise<unknown>>(forms.auth.verifyCredentials, 'admin', 'pw')).rejects.toThrow(
        /mock not configured: auth\.verifyCredentials/,
      );
    });
  });

  // Synchronous callbacks cannot prove an await; deferred gates pin both Promise-valued callback boundaries.
  describe('Promise-valued callbacks', () => {
    // Drain pending microtasks and one macrotask turn.
    const settle = () => new Promise((resolve) => { setImmediate(resolve); });

    it('awaits a Promise-returning opts.register before invoking opts.routes', async () => {
      const order: string[] = [];
      let releaseRegister!: () => void;
      const gate = new Promise<void>((resolve) => { releaseRegister = resolve; });

      const building = createAuthTestApp(createMockServices(), {
        register: async () => { order.push('register:enter'); await gate; order.push('register:exit'); },
        routes: (instance) => { order.push('routes'); probeRoutes(instance); },
      });

      await settle();
      // Without the register await, routes would already appear here.
      expect(order).toEqual(['register:enter']);

      releaseRegister();
      const { app } = await building;
      try {
        expect(order).toEqual(['register:enter', 'register:exit', 'routes']);
      } finally {
        await app.close();
      }
    });

    it('does not resolve — or call ready() — until a Promise-returning opts.routes completes', async () => {
      let releaseRoutes!: () => void;
      const gate = new Promise<void>((resolve) => { releaseRoutes = resolve; });
      let resolved = false;

      const building = createAuthTestApp(createMockServices(), {
        routes: async (instance) => { await gate; probeRoutes(instance); },
      }).then((built) => { resolved = true; return built; });

      await settle();
      expect(resolved).toBe(false);

      releaseRoutes();
      const { app, authHeader } = await building;
      try {
        expect(resolved).toBe(true);
        // A live route proves ready() waited for asynchronous registration.
        const res = await app.inject({
          method: 'GET',
          url: '/api/__probe',
          headers: { authorization: authHeader },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
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
    // Mock the parsed config module; ambient env changes cannot affect its boot-time value.
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

      // The default existing user keeps setup protected.
      expect((await setup()).statusCode).toBe(401);

      // hasUser is read per request, so a post-build first-user override reaches the handler.
      (services.auth.hasUser as Mock).mockResolvedValue(false);
      const exempt = await setup();
      expect(exempt.statusCode).toBe(200);
      expect(JSON.parse(exempt.payload)).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  /**
   * The options surface is deliberately closed: `mode` is the single source of truth for the
   * auth profile, and the service-controlled variants (`mode: 'none'`, `localBypass`,
   * `hasUser`) plus registration-time `urlBase` must never become a second configuration
   * channel. A runtime test cannot observe a NEW optional field appearing, so these are
   * typecheck-backed — `pnpm typecheck` is the assertion, and each `@ts-expect-error` goes
   * unused (TS2578) the moment the shape opens up.
   *
   * Every negative case carries exactly ONE defect, and the requiredness case OMITS `routes`
   * rather than mis-typing it: a wrong VALUE would satisfy the directive while leaving
   * requiredness unpinned.
   */
  describe('CreateAuthTestAppOptions — the closed surface (typecheck-backed)', () => {
    it('accepts the full four-field shape and the routes-only minimum', () => {
      const full: CreateAuthTestAppOptions = {
        mode: 'forms',
        routes: () => {},
        register: () => {},
        db: inject<Db>({ run: vi.fn() }),
      };
      const minimal: CreateAuthTestAppOptions = { routes: () => {} };

      expect(full.mode).toBe('forms');
      expect(minimal.mode).toBeUndefined();
    });

    it('requires routes', () => {
      // @ts-expect-error — `routes` is required; omission (not a bad value) is what pins that
      const noRoutes: CreateAuthTestAppOptions = { mode: 'basic' };
      expect(noRoutes.mode).toBe('basic');
    });

    it('closes mode to basic | forms', () => {
      // @ts-expect-error — `mode: 'none'` is an auth.plugin.test.ts matrix, not a helper option
      const modeNone: CreateAuthTestAppOptions = { mode: 'none', routes: () => {} };
      expect(modeNone.mode).toBe('none');
    });

    it('refuses a second, service-controlled auth channel', () => {
      // @ts-expect-error — `authStatus` would be a second source of truth over `mode`
      const authStatus: CreateAuthTestAppOptions = { routes: () => {}, authStatus: { mode: 'none' } };
      // @ts-expect-error — `localBypass` is a request-time AuthService fact; override the stub
      const localBypass: CreateAuthTestAppOptions = { routes: () => {}, localBypass: true };
      // @ts-expect-error — `hasUser` is a request-time AuthService fact; override the stub
      const hasUser: CreateAuthTestAppOptions = { routes: () => {}, hasUser: false };

      expect(typeof authStatus.routes).toBe('function');
      expect(typeof localBypass.routes).toBe('function');
      expect(typeof hasUser.routes).toBe('function');
    });

    it('refuses registration-time urlBase, which no stub override can reach', () => {
      // @ts-expect-error — `urlBase` is captured when authPlugin registers; see the JSDoc
      const urlBase: CreateAuthTestAppOptions = { routes: () => {}, urlBase: '/narratorr' };
      expect(typeof urlBase.routes).toBe('function');
    });
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
