import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listenWithRetry, registerStaticAndSpa } from './server-utils.js';

function createMockApp() {
  return {
    listen: vi.fn(),
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as Parameters<typeof listenWithRetry>[0];
}

describe('listenWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls app.listen once when port is available', async () => {
    const app = createMockApp();
    (app.listen as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await listenWithRetry(app, 3000);

    expect(app.listen).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' });
  });

  it('retries on EADDRINUSE and succeeds', async () => {
    const app = createMockApp();
    const addrInUse = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });

    (app.listen as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(addrInUse)
      .mockResolvedValueOnce(undefined);

    await listenWithRetry(app, 3000, 3);

    expect(app.listen).toHaveBeenCalledTimes(2);
    expect(app.log.warn).toHaveBeenCalled();
  });

  it('throws after exhausting retries on EADDRINUSE', async () => {
    const app = createMockApp();
    const addrInUse = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });

    (app.listen as ReturnType<typeof vi.fn>).mockRejectedValue(addrInUse);

    await expect(listenWithRetry(app, 3000, 2)).rejects.toThrow('EADDRINUSE');
    expect(app.listen).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-EADDRINUSE error', async () => {
    const app = createMockApp();
    (app.listen as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'));

    await expect(listenWithRetry(app, 3000)).rejects.toThrow('EACCES');
    expect(app.listen).toHaveBeenCalledTimes(1);
  });
});

describe('registerStaticAndSpa', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Create a temp directory with a minimal index.html
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<html><head></head><body><div id="root"></div></body></html>',
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('root URL_BASE (empty prefix)', () => {
    it('injects __NARRATORR_URL_BASE__ into index.html', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/some-page' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      await app.close();
    });

    it('returns 404 JSON for /api/* routes', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/nonexistent' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
      await app.close();
    });

    it('serves SPA fallback for any non-API route', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/books/123' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });
  });

  describe('non-root URL_BASE (/narratorr prefix)', () => {
    const prefix = '/narratorr';

    it('injects __NARRATORR_URL_BASE__ with prefix value', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/dashboard' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      await app.close();
    });

    it('returns 404 for requests outside URL_BASE scope', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/books/123' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
      await app.close();
    });

    it('returns 404 for /api/* outside URL_BASE scope', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('returns 404 for {prefix}/api/* routes', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/api/nonexistent' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
      await app.close();
    });

    it('serves SPA fallback for in-scope non-API routes', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/library' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });
  });
});
