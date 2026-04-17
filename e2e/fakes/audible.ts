import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Fake Audible API server for E2E tests.
 *
 * The match job uses structured params (title, author) → returns empty products
 * so confidence resolves to 'none'. The BookEditModal's manual search uses the
 * `keywords` param → returns one generic product so the user can select it and
 * upgrade confidence to 'medium'.
 *
 * Implements the subset of Audible API endpoints that `AudibleProvider` calls:
 *   GET /1.0/catalog/products       — search
 *   GET /1.0/catalog/products/:asin — detail
 */

/** Minimal Audible product shape — only the fields AudibleProvider.mapProduct reads. */
const GENERIC_PRODUCT = {
  asin: 'E2E_FAKE_ASIN',
  title: 'E2E Manual Import Book',
  subtitle: undefined,
  authors: [{ asin: undefined, name: 'E2E Manual Author' }],
  narrators: [{ name: 'E2E Narrator' }],
  publisher_name: 'E2E Publisher',
  release_date: '2024-01-01',
  runtime_length_min: 600,
  language: 'english',
  product_images: {},
  series: [],
  format_type: 'Unabridged',
  content_delivery_type: 'SinglePartBook',
};

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
  // Differentiate by query param shape:
  //   - `title` param (match job structured search) → empty results → confidence 'none'
  //   - `keywords` param (modal manual search) → one generic product → user can select
  server.get('/1.0/catalog/products', async (request) => {
    const params = request.query as Record<string, string>;
    if (params.title) {
      // Match job structured search → empty for deterministic 'none' confidence
      return { products: [], total_results: 0 };
    }
    // Modal keyword search → return one selectable product
    return { products: [GENERIC_PRODUCT], total_results: 1 };
  });

  // ── GET /1.0/catalog/products/:asin — detail ────────────────────────────
  // AudibleProvider.getBook fetches a single product by ASIN. Return the
  // generic product if asked for the fake ASIN, 404 otherwise.
  server.get('/1.0/catalog/products/:asin', async (request, reply) => {
    const { asin } = request.params as { asin: string };
    if (asin === GENERIC_PRODUCT.asin) {
      return { product: GENERIC_PRODUCT };
    }
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
