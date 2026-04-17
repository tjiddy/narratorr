import { describe, it, expect, afterEach } from 'vitest';
import { createAudibleFake, type AudibleFakeHandle } from './audible.js';

let nextPort = 14300;
function allocatePort(): number {
  return nextPort++;
}

describe('createAudibleFake', () => {
  let handle: AudibleFakeHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('returns empty products for structured title-param searches (match job)', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products?title=anything&num_results=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as { products: unknown[] };
    expect(body.products).toEqual([]);
  });

  it('returns one generic product for keyword searches (modal search)', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products?keywords=test+book&num_results=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as { products: unknown[]; total_results: number };
    expect(body.products).toHaveLength(1);
    expect(body.total_results).toBe(1);
    expect((body.products[0] as { asin: string }).asin).toBe('E2E_FAKE_ASIN');
  });

  it('returns the generic product for GET /1.0/catalog/products/:asin with known ASIN', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products/E2E_FAKE_ASIN?response_groups=contributors`);
    expect(res.status).toBe(200);
    const body = await res.json() as { product: { asin: string } };
    expect(body.product.asin).toBe('E2E_FAKE_ASIN');
  });

  it('returns 404 for GET /1.0/catalog/products/:asin with unknown ASIN', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products/UNKNOWN_ASIN`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unrecognized paths', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/unknown/path`);
    expect(res.status).toBe(404);
  });

  it('exposes url and close handle', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    expect(handle.url).toBe(`http://localhost:${port}`);
    expect(typeof handle.close).toBe('function');

    await handle.close();
    await expect(fetch(`${handle.url}/1.0/catalog/products`)).rejects.toThrow();
    handle = undefined;
  });
});
