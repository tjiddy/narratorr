import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi, type Mock } from 'vitest';
import type { Db } from '../../db/index.js';
import { registerRoutes, type Services } from '../routes/index.js';
import { RetryBudget } from '../services/retry-budget.js';
import { createMockSettings, type DeepPartial } from '../../shared/schemas/settings/create-mock-settings.js';
import type { AppSettings, SettingsCategory } from '../../shared/schemas/settings/registry.js';
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
 * Creates a Fastify instance with Zod type provider and all routes registered.
 * No CORS, no static files, no jobs — pure route testing via `app.inject()`.
 *
 * Accepts an optional mock DB for routes that need it (e.g., health check probe).
 * Defaults to a mock with a successful `run()` stub.
 */
export async function createTestApp(services: Services, db?: Db) {
  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);

  const mockDb = db ?? inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });
  await registerRoutes(app, services, mockDb);
  await app.ready();

  return app;
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
export function createMockDb(): Record<'select' | 'insert' | 'update' | 'delete', Mock> {
  return {
    select: vi.fn().mockReturnValue(mockDbChain()),
    insert: vi.fn().mockReturnValue(mockDbChain()),
    update: vi.fn().mockReturnValue(mockDbChain()),
    delete: vi.fn().mockReturnValue(mockDbChain()),
  };
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
 * All auto-created stubs default to `mockResolvedValue(undefined)` since service
 * methods are async. This prevents `undefined.catch is not a function` on
 * fire-and-forget calls like `notifier.notify(...).catch(...)`.
 */
export function createMockServices(overrides?: Partial<Record<keyof Services, Record<string, unknown>>>): Services {
  const serviceNames: (keyof Services)[] = [
    'settings', 'auth', 'indexer', 'downloadClient', 'book', 'bookList',
    'download', 'metadata', 'import', 'libraryScan', 'matchJob', 'notifier', 'blacklist', 'prowlarrSync', 'remotePathMapping', 'rename', 'eventHistory', 'tagging', 'qualityGate', 'eventBroadcaster', 'backup', 'healthCheck', 'taskRegistry', 'recyclingBin', 'importList', 'discovery',
  ];
  const services: Record<string, unknown> = {};
  for (const name of serviceNames) {
    services[name] = new Proxy({ ...overrides?.[name] } as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        const fn = vi.fn().mockResolvedValue(undefined);
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
 * After resetting, re-applies `mockResolvedValue(undefined)` so stubs always
 * return promises (matching `createMockServices` behavior).
 */
export function resetMockServices(services: Services) {
  for (const svc of Object.values(services)) {
    for (const fn of Object.values(svc as Record<string, unknown>)) {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        const mock = fn as unknown as { mockReset: () => void; mockResolvedValue: (v: unknown) => void };
        mock.mockReset();
        mock.mockResolvedValue(undefined);
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
    update: vi.fn().mockResolvedValue(undefined),
  });
}
