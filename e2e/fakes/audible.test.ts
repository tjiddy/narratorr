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

  it('returns { products: [] } for GET /1.0/catalog/products search requests', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products?title=anything&num_results=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as { products: unknown[] };
    expect(body).toEqual({ products: [] });
  });

  it('returns 404 for GET /1.0/catalog/products/:asin detail requests', async () => {
    const port = allocatePort();
    handle = await createAudibleFake({ port });

    const res = await fetch(`${handle.url}/1.0/catalog/products/B017V4IWVG?response_groups=contributors`);
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
    // After close, the server should no longer accept connections.
    await expect(fetch(`${handle.url}/1.0/catalog/products`)).rejects.toThrow();
    handle = undefined; // prevent double-close in afterEach
  });
});
