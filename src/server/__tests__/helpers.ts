import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi, type Mock } from 'vitest';
import type { Db } from '@db/index.js';
import { config } from '../config.js';
import { registerRoutes } from '../routes/index.js';
import type { AuthService } from '../services/auth.service.js';
import { SERVICE_KEYS, type Services } from '../services/di.js';
import { RetryBudget } from '../services/retry-budget.js';
import { createMockSettings, type DeepPartial } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { AppSettings, SettingsCategory } from '@shared/schemas/settings/registry.js';
import type { SettingsService } from '../services/settings.service.js';

/**
 * Cast a mock object to a production type for dependency injection in tests.
 *
 * Test mocks are partial implementations — they only stub the methods each test
 * exercises. Production types (Db, FastifyBaseLogger, service classes) have
 * complex internal shapes that mocks can't structurally satisfy without
 * reimplementing framework internals. Changing production constructors to accept
 * narrower interfaces would be production code changes motivated solely by tests.
 *
 * This helper centralizes the unavoidable type override so each call site is
 * explicit about the cast (`inject<Db>(db)`) without needing per-line lint
 * suppression. If you're casting data objects (not dependencies), complete the
 * mock data instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inject<T>(mock: unknown): T { return mock as any; }

/**
 * The bare Fastify instance both test-app helpers build on: Zod type provider plus
 * `routerOptions.maxParamLength: 2048`, matching `src/server/fastify-options.ts`.
 * Fastify 5 caps a dynamic path segment at 100 chars by default, and the cap is
 * per-instance — a signed token or content hash in the path silently 404s without it.
 */
function buildBareTestApp() {
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 2048 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

/** The Fastify instance type both `createTestApp` and `createAuthTestApp` hand back. */
export type ZodTestApp = ReturnType<typeof buildBareTestApp>;

/**
 * Creates a Fastify instance with Zod type provider and all routes registered.
 * No CORS, no static files, no jobs — pure route testing via `app.inject()`.
 *
 * Accepts an optional mock DB for routes that need it (e.g., health check probe).
 * Defaults to a mock with a successful `run()` stub.
 *
 * ⚠️ **No auth. Do NOT assert auth or CSRF behaviour against this app.** It registers
 * `errorHandlerPlugin` and the routes, but NOT `authPlugin` — so `request.user` is never
 * set, the `/api/*` `onRequest` hook never runs, and `enforceCsrf`
 * (`src/server/plugins/auth.ts`) never runs. A non-safe method missing
 * `X-Requested-With: XMLHttpRequest` gets its normal 2xx here, so the loose form of a CSRF
 * assertion (`expect(res.statusCode).not.toBe(403)`) passes **vacuously** — the gate it
 * claims to exercise is not installed. Same for "this route is protected": an
 * uncredentialed request reaches the handler.
 *
 * Use {@link createAuthTestApp} for any auth/CSRF case. It installs the real `authPlugin`
 * over the same scaffolding.
 */
export async function createTestApp(services: Services, db?: Db) {
  const app = buildBareTestApp();

  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);

  const mockDb = db ?? inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });
  await registerRoutes(app, services, mockDb);
  await app.ready();

  return app;
}

/** The one basic-auth credential every helper-built basic-mode app accepts. */
export const BASIC_AUTH_HEADER = `Basic ${Buffer.from('admin:password123').toString('base64')}`;

/** The one session-cookie value a helper-built `mode: 'forms'` app accepts. */
export const FORMS_SESSION_COOKIE = 'valid-session-cookie';

/** The auth modes {@link createAuthTestApp} models. `none`/local-bypass/URL_BASE live in `auth.plugin.test.ts`. */
export type AuthTestMode = 'basic' | 'forms';

/**
 * Stub `services.auth` with one internally-consistent profile for `mode`.
 *
 * `getStatus().hasUser` and `hasUser()` are the same production fact read through two
 * methods, so both are hard-wired to `true` and cannot desynchronise. A suite that wants
 * the no-user setup path (or `mode: 'none'`, or local bypass) overrides the relevant stub
 * itself after the app is built — see {@link createAuthTestApp}'s note on post-build overrides.
 *
 * **Exported separately on purpose.** `resetMockServices` re-applies the rejecting canonical
 * default to every stub, so a suite that builds its app in `beforeAll` and resets in
 * `beforeEach` must be able to re-arm the auth stubs in one line:
 * `beforeEach(() => { resetMockServices(services); stubAuthService(services); })`.
 */
export function stubAuthService(services: Services, mode: AuthTestMode = 'basic'): void {
  const authSvc = services.auth as unknown as Record<string, Mock>;
  authSvc.getStatus = vi.fn().mockResolvedValue({ mode, hasUser: true, localBypass: false });
  authSvc.hasUser = vi.fn().mockResolvedValue(true);
  authSvc.validateApiKey = vi.fn().mockResolvedValue(false);

  if (mode === 'basic') {
    // Accepts any password, matching every hand-rolled copy this helper replaces. A suite
    // wanting a 401-on-bad-password case overrides verifyCredentials itself.
    authSvc.verifyCredentials = vi.fn().mockResolvedValue({ username: 'admin' });
    return;
  }

  authSvc.getSessionSecret = vi.fn().mockResolvedValue('test-secret');
  authSvc.createSessionCookie = vi.fn().mockReturnValue(FORMS_SESSION_COOKIE);
  authSvc.verifySessionCookie = vi.fn().mockImplementation((cookie: string) => {
    if (cookie !== FORMS_SESSION_COOKIE) return null;
    const now = Date.now();
    return {
      payload: { username: 'admin', kind: 'session', issuedAt: now, expiresAt: now + 3_600_000 },
      shouldRenew: false,
    };
  });
}

export interface CreateAuthTestAppOptions {
  /**
   * Auth mode — the single source of truth for the profile. Defaults to `'basic'`.
   * There is deliberately no second override channel.
   */
  mode?: AuthTestMode;
  /**
   * Register the route factory (or factories) under test on the root instance, no prefix.
   * A callback rather than a factory reference because the four adopting factories have
   * four different signatures — the callback adapts.
   */
  routes: (app: ZodTestApp, services: Services, db: Db) => void | Promise<void>;
  /** Extra plugins (e.g. `@fastify/multipart`). Runs BEFORE `routes`, so route registration sees them. */
  register?: (app: ZodTestApp) => void | Promise<void>;
  /** Db handed to `routes`. Defaults to the same `{ run: … }` stub `createTestApp` uses. */
  db?: Db;
}

/**
 * Creates a Fastify instance with the **real** `authPlugin` installed, for auth and CSRF
 * cases that {@link createTestApp} cannot express (it registers no auth plugin at all).
 *
 * Registration order is fixed and load-bearing: Zod compilers → `@fastify/cookie` →
 * `opts.register` → `errorHandlerPlugin` → `authPlugin` → `opts.routes` → `ready()`.
 * `@fastify/cookie` is a declared dependency of `authPlugin`, so getting it out of order
 * fails `app.ready()` outright rather than degrading at request time.
 *
 * The caller owns the returned app — this helper never closes it.
 *
 * **Post-build stub overrides take effect.** `authPlugin`'s `onRequest` hook resolves
 * `authService` methods per REQUEST, not at registration, so overriding any auth stub after
 * this returns changes the next request's outcome. That is the escape hatch for the
 * service-controlled variants this helper deliberately does not model — `mode: 'none'`,
 * `localBypass`, `hasUser: false` — and it is what makes a real-crypto forms harness
 * expressible (re-stub `getSessionSecret`/`createSessionCookie`/`verifySessionCookie`
 * afterwards).
 *
 * It reaches **request-time facts only.** `urlBase` is captured when `authPlugin` is
 * registered and is not an `AuthService` fact, so no stub override can supply it. A
 * URL_BASE-aware harness must keep hand-building its instance with
 * `authPlugin({ authService, urlBase })` and matching prefixed route registration coupled
 * together; do not route such a suite through this helper.
 */
export async function createAuthTestApp(services: Services, opts: CreateAuthTestAppOptions) {
  if (config.authBypass) {
    throw new Error(
      'createAuthTestApp: AUTH_BYPASS is enabled. The auth hook returns before any mode branch, ' +
      'so every auth and CSRF assertion built on this helper would pass vacuously. ' +
      'Unset AUTH_BYPASS (only the literal string "true" enables it) before building an auth test app.',
    );
  }

  stubAuthService(services, opts.mode ?? 'basic');

  const app = buildBareTestApp();

  const { default: cookie } = await import('@fastify/cookie');
  await app.register(cookie);

  await opts.register?.(app);

  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);

  const { default: authPlugin } = await import('../plugins/auth.js');
  await app.register(authPlugin, { authService: inject<AuthService>(services.auth) });

  const db = opts.db ?? inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });
  await opts.routes(app, services, db);
  await app.ready();

  return { app, services, authHeader: BASIC_AUTH_HEADER };
}

/**
 * Replace the Fastify app's logger methods with vi.fn() stubs so route tests
 * can assert on `request.log.*` calls. With `logger: false`, app.log is a
 * shared abstract-logger singleton whose `.child()` returns `this` — so the
 * same spies intercept both app.log and request.log.
 *
 * Returns a cleanup function that restores the original methods.
 */
export function installMockAppLog(app: { log: unknown }) {
  const methods = ['error', 'warn', 'info', 'debug', 'fatal', 'trace'] as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logRecord = app.log as Record<string, any>;
  const originals: Record<string, unknown> = {};
  for (const m of methods) {
    originals[m] = logRecord[m];
    logRecord[m] = vi.fn();
  }
  const spies = {
    error: logRecord.error as Mock,
    warn: logRecord.warn as Mock,
    info: logRecord.info as Mock,
    debug: logRecord.debug as Mock,
    fatal: logRecord.fatal as Mock,
    trace: logRecord.trace as Mock,
  };
  const restore = () => {
    for (const m of methods) logRecord[m] = originals[m];
  };
  return { spies, restore };
}

/**
 * Creates a thenable chain that simulates Drizzle ORM query builder.
 * Uses a Proxy to auto-generate `vi.fn()` stubs for any chained method.
 * When awaited, resolves to `result` (or rejects with `opts.error`).
 *
 * Promise protocol (`then`, `catch`, `finally`) and Symbol properties are
 * excluded from stub generation. Terminal methods (`get`, `all`, `run`,
 * `execute`) return `Promise.resolve(result)` instead of the chain.
 */
export function mockDbChain(result: unknown = [], opts?: { error: Error }) {
  const stubs = new Map<string, Mock>();
  const terminals = new Set(['get', 'all', 'run', 'execute']);

  const promise = opts?.error
    ? Promise.reject(opts.error)
    : Promise.resolve(result);
  // Prevent unhandled rejection warnings for error chains that aren't immediately awaited
  promise.catch(() => {});

  const overrides = new Map<string, unknown>();

  const chain: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;

      // Explicit overrides take priority (tests may replace stubs)
      if (overrides.has(prop)) return overrides.get(prop);

      // Promise protocol — delegate to the underlying promise
      if (prop === 'then') return (onFulfilled?: unknown, onRejected?: unknown) =>
        promise.then(onFulfilled as never, onRejected as never);
      if (prop === 'catch') return (onRejected?: unknown) =>
        promise.catch(onRejected as never);
      if (prop === 'finally') return (onFinally?: unknown) =>
        promise.finally(onFinally as never);

      // Terminal methods — return promise, not chain
      if (terminals.has(prop)) {
        if (!stubs.has(prop)) stubs.set(prop, vi.fn().mockReturnValue(promise));
        return stubs.get(prop)!;
      }

      // Chainable methods — lazily create cached vi.fn() stubs
      if (!stubs.has(prop)) stubs.set(prop, vi.fn().mockReturnValue(chain));
      return stubs.get(prop)!;
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') overrides.set(prop, value);
      return true;
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return chain as any;
}

/**
 * Creates a mock Drizzle DB object with chainable select/insert/update/delete.
 * Use `mockReturnValue(mockDbChain(data))` or `mockReturnValueOnce` on the
 * returned stubs to control per-call results.
 */
export function createMockDb(): Record<'select' | 'insert' | 'update' | 'delete' | 'transaction', Mock> {
  const db: Record<'select' | 'insert' | 'update' | 'delete' | 'transaction', Mock> = {
    select: vi.fn().mockReturnValue(mockDbChain()),
    insert: vi.fn().mockReturnValue(mockDbChain()),
    update: vi.fn().mockReturnValue(mockDbChain()),
    delete: vi.fn().mockReturnValue(mockDbChain()),
    transaction: vi.fn(),
  };
  // transaction() executes the callback with the same mock db, simulating Drizzle's tx handle
  db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));
  return db;
}

/**
 * Creates a mock Pino BaseLogger with all methods as vi.fn() stubs.
 * Use `inject<FastifyBaseLogger>(log)` when passing to service constructors.
 */
export function createMockLogger(): Record<string, Mock | string> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  };
}

/**
 * Returns a Services object where every method on every service is a `vi.fn()`.
 * Uses Proxy to auto-create stubs on access — adding new service methods requires no changes here.
 * Accepts partial overrides to customize specific services.
 *
 * **Canonical default for unconfigured methods:** every auto-created stub is
 * `vi.fn().mockRejectedValue(new Error('mock not configured: <service>.<method>'))`.
 * Rejected promises remain thenable, so fire-and-forget chains like
 * `notifier.notify(...).catch(noop)` keep working — the .catch handler swallows
 * the rejection. But any test that `await`s an unconfigured method surfaces the
 * descriptive error loudly, instead of getting a silent `undefined` that masks
 * a missing setup.
 *
 * Tests that need a successful return continue to set up `mockResolvedValue(...)`
 * (or any other override) explicitly. `resetMockServices` re-applies the same
 * canonical default — both helpers must stay in lockstep on this contract.
 */
export function createMockServices(overrides?: Partial<Record<keyof Services, Record<string, unknown>>>): Services {
  const services: Record<string, unknown> = {};
  for (const name of SERVICE_KEYS) {
    // Pre-configured defaults for methods that are called from the production
    // service-graph wiring layer (not the route under test). Tests can override
    // by passing `overrides[name][method]` — the spread below puts caller
    // overrides last so they win.
    const presets: Record<string, unknown> = {};
    if (name === 'indexer') {
      // #1149 — searchAndGrabForBook / postProcessSearchResults / retrySearch /
      // runRssJob all call IndexerService.getLanAllowlist() to thread the LAN
      // allowlist to the NZB enrichment leaf. An unconfigured Proxy stub would
      // reject the promise and bubble up as a 500 in route tests that don't
      // care about the allowlist shape. Default to an empty allowlist.
      presets.getLanAllowlist = vi.fn().mockResolvedValue({
        hostPort: new Set<string>(),
        hostname: new Set<string>(),
      });
    }
    services[name] = new Proxy({ ...presets, ...overrides?.[name] } as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        const fn = vi.fn().mockRejectedValue(
          new Error(`mock not configured: ${name}.${prop}`),
        );
        target[prop] = fn;
        return fn;
      },
    });
  }
  // RetryBudget is a real instance (not a proxy-based mock) since it's transient state
  services.retryBudget = new RetryBudget();
  // Proxy-based mock can't be statically verified against Services interface.
  // Every property access returns a vi.fn() stub at runtime.
  return inject<Services>(services);
}

/**
 * Resets all vi.fn() stubs on every service in a Services object.
 * Replaces the identical `beforeEach` loop duplicated across route tests.
 *
 * **Canonical default after reset:** matches `createMockServices` —
 * `mockRejectedValue(new Error('mock not configured: <service>.<method>'))`.
 * Rejected promises remain thenable so fire-and-forget chains keep working;
 * tests that await an un-reconfigured method see a loud descriptive error
 * instead of a silent `undefined`.
 */
export function resetMockServices(services: Services) {
  for (const [serviceName, svc] of Object.entries(services)) {
    for (const [methodName, fn] of Object.entries(svc as Record<string, unknown>)) {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        const mock = fn as unknown as {
          mockReset: () => void;
          mockRejectedValue: (v: unknown) => void;
          mockResolvedValue: (v: unknown) => void;
        };
        mock.mockReset();
        // Preserve the production-graph defaults set in `createMockServices`
        // so route tests don't have to re-configure them after every reset
        // (#1149 — IndexerService.getLanAllowlist).
        if (serviceName === 'indexer' && methodName === 'getLanAllowlist') {
          mock.mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() });
        } else {
          mock.mockRejectedValue(new Error(`mock not configured: ${serviceName}.${methodName}`));
        }
      }
    }
  }
}

/**
 * Creates a mock SettingsService backed by the shared createMockSettings factory.
 * The `get(category)` method resolves to the correct category from a complete
 * AppSettings object, so tests never hardcode category-level literal defaults.
 *
 * Accepts deep-partial overrides — only specify the fields you care about.
 */
export function createMockSettingsService(overrides?: DeepPartial<AppSettings>): SettingsService {
  const settings = createMockSettings(overrides);
  return inject<SettingsService>({
    get: vi.fn().mockImplementation((cat: SettingsCategory) => Promise.resolve(settings[cat])),
    getAll: vi.fn().mockResolvedValue(settings),
    set: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  });
}
