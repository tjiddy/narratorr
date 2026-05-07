import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi, type Mock } from 'vitest';
import type { Db } from '../../db/index.js';
import { registerRoutes, SERVICE_KEYS, type Services } from '../routes/index.js';
import { RetryBudget } from '../services/retry-budget.js';
import { createMockSettings, type DeepPartial } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
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
    routerOptions: { maxParamLength: 2048 },
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
    services[name] = new Proxy({ ...overrides?.[name] } as Record<string | symbol, unknown>, {
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
        const mock = fn as unknown as { mockReset: () => void; mockRejectedValue: (v: unknown) => void };
        mock.mockReset();
        mock.mockRejectedValue(new Error(`mock not configured: ${serviceName}.${methodName}`));
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
