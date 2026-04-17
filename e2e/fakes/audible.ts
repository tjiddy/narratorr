import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Fake Audible API server for E2E tests. Returns empty product arrays for all
 * catalog search requests, making the match job resolve to `confidence: 'none'`
 * deterministically.
 *
 * Implements the subset of Audible API endpoints that `AudibleProvider` calls:
 *   GET /1.0/catalog/products       — search (returns { products: [] })
 *   GET /1.0/catalog/products/:asin — detail (returns 404)
 */

export interface CreateAudibleFakeOptions {
  /** Port to listen on. Defaults to 4300. */
  port?: number;
}

export interface AudibleFakeHandle {
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}

export async function createAudibleFake(options: CreateAudibleFakeOptions = {}): Promise<AudibleFakeHandle> {
  const port = options.port ?? 4300;

  const server = Fastify({ logger: process.env.E2E_FAKE_LOGS === '1' });

  // ── GET /1.0/catalog/products — search ──────────────────────────────────
  // AudibleProvider.searchBooks sends structured params (title, author, keywords)
  // and expects { products: AudibleProduct[] }. Return empty array so the match
  // job gets zero results → confidence 'none'.
  server.get('/1.0/catalog/products', async () => {
    return { products: [] };
  });

  // ── GET /1.0/catalog/products/:asin — detail ────────────────────────────
  // AudibleProvider.getBook fetches a single product by ASIN. Since the fake
  // has no seeded products, always return 404.
  server.get('/1.0/catalog/products/:asin', async (_request, reply) => {
    return reply.status(404).send({ message: 'Not found' });
  });

  // All other paths → 404 (Fastify's default behavior).

  await server.listen({ port, host: '127.0.0.1' });

  return {
    server,
    url: `http://localhost:${port}`,
    close: async () => {
      await server.close();
    },
  };
}
