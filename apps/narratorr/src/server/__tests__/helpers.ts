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
    'from', 'where', 'limit', 'orderBy', 'leftJoin',
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
 * Accepts partial overrides to customize specific services.
 */
export function createMockServices(overrides?: Partial<Services>): Services {
  return {
    settings: {
      get: vi.fn(),
      getAll: vi.fn(),
      set: vi.fn(),
      update: vi.fn(),
      ...overrides?.settings,
    } as unknown as Services['settings'],
    indexer: {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAdapter: vi.fn(),
      test: vi.fn(),
      testConfig: vi.fn(),
      searchAll: vi.fn(),
      ...overrides?.indexer,
    } as unknown as Services['indexer'],
    downloadClient: {
      getAll: vi.fn(),
      getById: vi.fn(),
      getFirstEnabled: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAdapter: vi.fn(),
      getFirstEnabledAdapter: vi.fn(),
      test: vi.fn(),
      testConfig: vi.fn(),
      ...overrides?.downloadClient,
    } as unknown as Services['downloadClient'],
    book: {
      getAll: vi.fn(),
      getById: vi.fn(),
      findDuplicate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateStatus: vi.fn(),
      delete: vi.fn(),
      search: vi.fn(),
      ...overrides?.book,
    } as unknown as Services['book'],
    download: {
      getAll: vi.fn(),
      getById: vi.fn(),
      getActive: vi.fn(),
      getActiveByBookId: vi.fn(),
      grab: vi.fn(),
      updateProgress: vi.fn(),
      updateStatus: vi.fn(),
      setError: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn(),
      ...overrides?.download,
    } as unknown as Services['download'],
    metadata: {
      search: vi.fn(),
      searchAuthors: vi.fn(),
      searchBooks: vi.fn(),
      getAuthor: vi.fn(),
      getAuthorBooks: vi.fn(),
      getBook: vi.fn(),
      getSeries: vi.fn(),
      enrichBook: vi.fn(),
      testProviders: vi.fn(),
      getProviders: vi.fn(),
      ...overrides?.metadata,
    } as unknown as Services['metadata'],
    import: {
      importDownload: vi.fn(),
      processCompletedDownloads: vi.fn(),
      ...overrides?.import,
    } as unknown as Services['import'],
    libraryScan: {
      scanDirectory: vi.fn(),
      confirmImport: vi.fn(),
      ...overrides?.libraryScan,
    } as unknown as Services['libraryScan'],
  };
}
