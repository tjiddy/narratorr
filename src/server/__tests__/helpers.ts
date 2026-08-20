import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi, type Mock } from 'vitest';
import type { Db } from '@db/index.js';
import { config } from '../config.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import type { AggregateSearchStatus } from '../services/indexer-search.service.js';
import { registerRoutes } from '../routes/index.js';
import type { AuthService } from '../services/auth.service.js';
import { SERVICE_KEYS, type Services } from '../services/di.js';
import { RetryBudget } from '../services/retry-budget.js';
import { SearchLadderCooldown } from '../services/search-ladder-cooldown.js';
import { createMockSettings, type DeepPartial } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { AppSettings, SettingsCategory } from '@shared/schemas/settings/registry.js';
import type { SettingsService } from '../services/settings.service.js';

/** Cast partial dependency mocks without weakening production constructors. Complete ordinary data mocks instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inject<T>(mock: unknown): T { return mock as any; }

// Match production's 2048 dynamic-segment cap; Fastify 5 otherwise silently 404s tokens over 100 chars.
function buildBareTestApp() {
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 2048 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type ZodTestApp = ReturnType<typeof buildBareTestApp>;

/**
 * Route-only app: no auth/CSRF plugin, CORS, static files, or jobs.
 * Never assert auth or CSRF here; uncredentialed and headerless writes reach handlers.
 * Use {@link createAuthTestApp} for those cases.
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

export const BASIC_AUTH_HEADER = `Basic ${Buffer.from('admin:password123').toString('base64')}`;

export const FORMS_SESSION_COOKIE = 'valid-session-cookie';

/** Models only basic/forms; bypass and URL_BASE scenarios require a custom auth harness. */
export type AuthTestMode = 'basic' | 'forms';

/**
 * Apply one internally consistent authenticated profile. `resetMockServices` restores
 * rejecting defaults, so suites that reset must reapply this helper.
 */
export function stubAuthService(services: Services, mode: AuthTestMode = 'basic'): void {
  const authSvc = services.auth as unknown as Record<string, Mock>;
  authSvc.getStatus = vi.fn().mockResolvedValue({ mode, hasUser: true, localBypass: false });
  authSvc.hasUser = vi.fn().mockResolvedValue(true);
  authSvc.validateApiKey = vi.fn().mockResolvedValue(false);

  if (mode === 'basic') {
    // Accept any password; bad-password suites must override verifyCredentials.
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
  /** Sole auth-profile selector; defaults to basic. */
  mode?: AuthTestMode;
  /** Adapt route factories to the root instance; their signatures differ. */
  routes: (app: ZodTestApp, services: Services, db: Db) => void | Promise<void>;
  /** Extra plugins run before routes. */
  register?: (app: ZodTestApp) => void | Promise<void>;
  /** Defaults to createTestApp's successful run stub. */
  db?: Db;
}

/**
 * Install the real auth plugin. Cookie and optional plugins must precede auth and routes.
 * Auth methods resolve per request, so post-build stub overrides work; URL_BASE is captured
 * at registration and still requires a custom harness. The caller owns the returned app.
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

// The abstract logger's child returns itself, so these restorable spies cover app and request logs.
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

/** Thenable Drizzle proxy: chained methods reuse stubs; terminals return the result promise. */
export function mockDbChain(result: unknown = [], opts?: { error: Error }) {
  const stubs = new Map<string, Mock>();
  const terminals = new Set(['get', 'all', 'run', 'execute']);

  const promise = opts?.error
    ? Promise.reject(opts.error)
    : Promise.resolve(result);
  // Prevent warnings when an error chain is not immediately awaited.
  promise.catch(() => {});

  const overrides = new Map<string, unknown>();

  const chain: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;

      if (overrides.has(prop)) return overrides.get(prop);

      if (prop === 'then') return (onFulfilled?: unknown, onRejected?: unknown) =>
        promise.then(onFulfilled as never, onRejected as never);
      if (prop === 'catch') return (onRejected?: unknown) =>
        promise.catch(onRejected as never);
      if (prop === 'finally') return (onFinally?: unknown) =>
        promise.finally(onFinally as never);

      if (terminals.has(prop)) {
        if (!stubs.has(prop)) stubs.set(prop, vi.fn().mockReturnValue(promise));
        return stubs.get(prop)!;
      }

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

/** Mock Drizzle entry points; configure each call with mockDbChain. */
export function createMockDb(): Record<'select' | 'insert' | 'update' | 'delete' | 'transaction', Mock> {
  const db: Record<'select' | 'insert' | 'update' | 'delete' | 'transaction', Mock> = {
    select: vi.fn().mockReturnValue(mockDbChain()),
    insert: vi.fn().mockReturnValue(mockDbChain()),
    update: vi.fn().mockReturnValue(mockDbChain()),
    delete: vi.fn().mockReturnValue(mockDbChain()),
    transaction: vi.fn(),
  };
  // Reuse the same object as Drizzle's transaction handle.
  db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));
  return db;
}

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
 * Proxy service methods to rejecting stubs unless overridden. Rejection preserves
 * fire-and-forget `.catch` chains while failing awaited missing setup loudly.
 * `resetMockServices` must preserve the same defaults.
 */
export function createMockServices(overrides?: Partial<Record<keyof Services, Record<string, unknown>>>): Services {
  const services: Record<string, unknown> = {};
  for (const name of SERVICE_KEYS) {
    // Production-graph calls need presets even in unrelated route tests; caller overrides win.
    const presets: Record<string, unknown> = {};
    if (name === 'indexer') {
      // Wiring always requests the LAN allowlist; default it empty for unrelated route tests.
      presets.getLanAllowlist = vi.fn().mockResolvedValue({
        hostPort: new Set<string>(),
        hostname: new Set<string>(),
      });
    }
    if (name === 'bookDeletion') {
      // An empty sweep, so a test that reaches DELETE /api/books/missing without configuring it
      // sees the no-op rather than a 500 from the rejecting default.
      presets.deleteMissingBooks = vi.fn().mockResolvedValue({ deleted: 0, failed: 0 });
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
  // RetryBudget is a real instance because it holds transient state.
  services.retryBudget = new RetryBudget();
  // SearchLadderCooldown is also transient in-memory state, so use the real class.
  services.searchLadderCooldown = new SearchLadderCooldown();
  return inject<Services>(services);
}

/** Reset every stub to createMockServices defaults; tests must reconfigure successful calls. */
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
        // Reapply the production-graph allowlist preset.
        if (serviceName === 'indexer' && methodName === 'getLanAllowlist') {
          mock.mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() });
        } else if (serviceName === 'bookDeletion' && methodName === 'deleteMissingBooks') {
          mock.mockResolvedValue({ deleted: 0, failed: 0 });
        } else {
          mock.mockRejectedValue(new Error(`mock not configured: ${serviceName}.${methodName}`));
        }
      }
    }
  }
}

/** Complete category-aware settings mock with deep-partial overrides. */
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

/** Counts only — `results` is generic so partial fixtures flow through (see {@link searchStatus}). */
export type SearchStatusOverrides = Partial<Omit<AggregateSearchStatus, 'results'>>;

/**
 * The `AggregateSearchStatus` envelope `IndexerSearchService.searchAllWithStatus` resolves,
 * spelled once for the whole server test tree.
 *
 * `succeeded: 1` makes an empty `results` an *answered zero*, so the query-relaxation ladder
 * advances to the next rung; `succeeded: 0` means a total indexer outage and stops it after one
 * rung. Pre-ladder fixtures answer identically on every rung (#2104 D16).
 *
 * The counts are typed from the production interface, so a field added there fails to compile here
 * rather than going silently `undefined` at every mock site.
 */
export function searchStatus<T>(
  results: T[],
  overrides: SearchStatusOverrides = {},
): Omit<AggregateSearchStatus, 'results'> & { results: T[] } {
  return {
    succeeded: 1,
    failed: 0,
    ...overrides,
    results,
    // Copied, never aliased: production pushes onto `skipped`, so sharing one array — the caller's
    // or a previous return's — lets one mock's breaker skips surface through another.
    skipped: [...(overrides.skipped ?? [])],
  };
}

/** `searchAllWithStatus` double resolving one fixed envelope. */
export function mockSearchAllWithStatus<T>(results: T[], overrides?: SearchStatusOverrides): Mock {
  return vi.fn().mockResolvedValue(searchStatus(results, overrides));
}

/** `searchAllWithStatus` double mapping each transport query to its results; unlisted queries answer zero. */
export function answeringSearchStatus<T>(byQuery: Record<string, T[]>, overrides?: SearchStatusOverrides): Mock {
  return vi.fn().mockImplementation(async (query: string) => searchStatus(byQuery[query] ?? [], overrides));
}

/**
 * Park the search deadline's own timer and hand back its callbacks, so an expiry case fires the
 * real production deadline on demand instead of waiting 25 minutes or doubling `withSearchDeadline`.
 * Every other timer in the process stays real — the delay is the discriminator.
 *
 * This only works because the deadline is a hand-rolled `AbortController` + `setTimeout`;
 * `AbortSignal.timeout` schedules on a native timer the spy never sees. Restore with
 * `vi.restoreAllMocks()`.
 */
export function captureDeadlineTimers(): Array<() => void> {
  const captured: Array<() => void> = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay !== SEARCH_DEADLINE_MS) return original(fn as never, delay as never, ...rest as never[]);
    captured.push(fn);
    const parked = original(() => { /* never fires within a test */ }, 2 ** 30);
    parked.unref();
    return parked;
  }) as never);
  return captured;
}
