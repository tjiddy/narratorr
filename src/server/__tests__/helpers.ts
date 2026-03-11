import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi } from 'vitest';
import type { Db } from '../../db/index.js';
import { registerRoutes, type Services } from '../routes/index.js';
import { RetryBudget } from '../services/retry-budget.js';

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

  const mockDb = db ?? inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });
  await registerRoutes(app, services, mockDb);
  await app.ready();

  return app;
}

/**
 * Creates a thenable chain that simulates Drizzle ORM query builder.
 * Every chaining method (from, where, limit, etc.) returns the same chain.
 * When awaited, resolves to `result`.
 */
export function mockDbChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = [
    'from', 'where', 'limit', 'orderBy', 'leftJoin', 'groupBy',
    'values', 'returning', 'set', 'onConflictDoUpdate',
  ];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return chain;
}

/**
 * Creates a mock Drizzle DB object with chainable select/insert/update/delete.
 * Use `mockReturnValue(mockDbChain(data))` or `mockReturnValueOnce` on the
 * returned stubs to control per-call results.
 */
export function createMockDb() {
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
export function createMockLogger() {
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
    'settings', 'auth', 'indexer', 'downloadClient', 'book',
    'download', 'metadata', 'import', 'libraryScan', 'matchJob', 'notifier', 'blacklist', 'prowlarrSync', 'remotePathMapping', 'rename', 'eventHistory', 'tagging', 'qualityGate', 'eventBroadcaster', 'backup', 'healthCheck', 'taskRegistry', 'recyclingBin',
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
