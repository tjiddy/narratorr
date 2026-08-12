import Fastify, { type FastifyInstance } from 'fastify';

/** Fake subset of the Audible API consumed by `AudibleProvider`. */
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

  // Match jobs use `title` and must miss; manual searches use `keywords` and need one selectable result.
  server.get('/1.0/catalog/products', async (request) => {
    const params = request.query as Record<string, string>;
    if (params.title) {
      return { products: [], total_results: 0 };
    }
    return { products: [GENERIC_PRODUCT], total_results: 1 };
  });

  server.get('/1.0/catalog/products/:asin', async (request, reply) => {
    const { asin } = request.params as { asin: string };
    if (asin === GENERIC_PRODUCT.asin) {
      return { product: GENERIC_PRODUCT };
    }
    return reply.status(404).send({ message: 'Not found' });
  });

  await server.listen({ port, host: '127.0.0.1' });

  return {
    server,
    url: `http://localhost:${port}`,
    close: async () => {
      await server.close();
    },
  };
}
