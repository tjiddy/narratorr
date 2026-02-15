import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { vi } from 'vitest';
import { registerRoutes, type Services } from '../routes/index.js';

/**
 * Creates a Fastify instance with Zod type provider and all routes registered.
 * No CORS, no static files, no DB, no jobs — pure route testing via `app.inject()`.
 */
export async function createTestApp(services: Services) {
  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await registerRoutes(app, services);
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
 */
export function createMockServices(overrides?: Partial<Record<keyof Services, Record<string, unknown>>>): Services {
  const serviceNames: (keyof Services)[] = [
    'settings', 'indexer', 'downloadClient', 'book',
    'download', 'metadata', 'import', 'libraryScan', 'notifier', 'blacklist',
  ];
  const services: Record<string, unknown> = {};
  for (const name of serviceNames) {
    services[name] = new Proxy({ ...overrides?.[name] } as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        const fn = vi.fn();
        target[prop] = fn;
        return fn;
      },
    });
  }
  return services as unknown as Services;
}
