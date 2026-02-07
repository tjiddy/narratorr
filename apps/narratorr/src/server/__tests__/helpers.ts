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
      ...overrides?.downloadClient,
    } as unknown as Services['downloadClient'],
    book: {
      getAll: vi.fn(),
      getById: vi.fn(),
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
      testProviders: vi.fn(),
      getProviders: vi.fn(),
      ...overrides?.metadata,
    } as unknown as Services['metadata'],
  };
}
