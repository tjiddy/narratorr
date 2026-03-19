import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listenWithRetry, registerStaticAndSpa } from './server-utils.js';
import { buildHelmetOptions } from './plugins/helmet-options.js';

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

/** Create a Fastify app with helmet (prod mode) + registerStaticAndSpa */
async function createAppWithHelmet(urlBasePrefix: string, clientPath: string) {
  const app = Fastify({ logger: false });
  await app.register(helmet, buildHelmetOptions(false));
  await registerStaticAndSpa(app, urlBasePrefix, clientPath);
  await app.ready();
  return app;
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
    // Create a temp directory with a realistic index.html matching the built output
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      [
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <link rel="preconnect" href="https://fonts.googleapis.com">',
        '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans&display=swap">',
        '    <title>Narratorr</title>',
        '    <script>',
        '      (function() {',
        '        var t = localStorage.getItem("theme");',
        '        if (t === "dark") document.documentElement.classList.add("dark");',
        '      })();',
        '    </script>',
        '    <script type="module" crossorigin src="./assets/index-abc123.js"></script>',
        '    <link rel="stylesheet" crossorigin href="./assets/index-abc123.css">',
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '  </body>',
        '</html>',
      ].join('\n'),
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

  describe('direct static entry routes (root URL_BASE)', () => {
    it('serves injected HTML with config script at / (root)', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });

    it('serves injected HTML with config script at /index.html (root)', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });

    it('includes nonce attribute in injected script tag at / (root)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">/);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      await app.close();
    });

    it('includes nonce attribute in injected script tag at /index.html (root)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">/);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      await app.close();
    });
  });

  describe('direct static entry routes (prefixed URL_BASE)', () => {
    const prefix = '/narratorr';

    it('serves injected HTML with config script at /<urlBase>/', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });

    it('serves injected HTML with config script at /<urlBase>/index.html', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, prefix, tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      expect(res.body).toContain('<div id="root">');
      await app.close();
    });

    it('includes nonce attribute in injected script tag at /<urlBase>/', async () => {
      const app = await createAppWithHelmet(prefix, tmpDir);

      const res = await app.inject({ method: 'GET', url: '/narratorr/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">/);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      await app.close();
    });

    it('includes nonce attribute in injected script tag at /<urlBase>/index.html', async () => {
      const app = await createAppWithHelmet(prefix, tmpDir);

      const res = await app.inject({ method: 'GET', url: '/narratorr/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">/);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      await app.close();
    });
  });

  describe('nonce injection', () => {
    it('nonce appears in injected <script nonce="..."> tag in SPA fallback HTML', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">/);
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__=""');
      await app.close();
    });

    it('successive requests produce different nonces', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res1 = await app.inject({ method: 'GET', url: '/' });
      const res2 = await app.inject({ method: 'GET', url: '/' });

      const nonce1 = res1.body.match(/nonce="([a-f0-9]+)"/)?.[1];
      const nonce2 = res2.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(nonce1).toBeDefined();
      expect(nonce2).toBeDefined();
      expect(nonce1).not.toBe(nonce2);
      await app.close();
    });

    it('nonce is valid hex and at least 16 bytes (32 hex chars)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      const nonce = res.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(nonce).toBeDefined();
      expect(nonce!.length).toBeGreaterThanOrEqual(32);
      expect(nonce).toMatch(/^[a-f0-9]+$/);
      await app.close();
    });

    it('HTML script nonce matches CSP header nonce on direct-entry route', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      const csp = res.headers['content-security-policy'] as string;
      const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
      const htmlNonce = res.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(headerNonce).toBeDefined();
      expect(htmlNonce).toBeDefined();
      expect(htmlNonce).toBe(headerNonce);
      await app.close();
    });

    it('HTML script nonce matches CSP header nonce on SPA fallback route', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      const csp = res.headers['content-security-policy'] as string;
      const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
      const htmlNonce = res.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(headerNonce).toBeDefined();
      expect(htmlNonce).toBeDefined();
      expect(htmlNonce).toBe(headerNonce);
      await app.close();
    });

    it('HTML script nonce matches CSP header nonce on prefixed direct-entry route', async () => {
      const app = await createAppWithHelmet('/narratorr', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/narratorr/' });
      const csp = res.headers['content-security-policy'] as string;
      const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
      const htmlNonce = res.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(headerNonce).toBeDefined();
      expect(htmlNonce).toBeDefined();
      expect(htmlNonce).toBe(headerNonce);
      await app.close();
    });

    it('HTML script nonce matches CSP header nonce on prefixed SPA fallback route', async () => {
      const app = await createAppWithHelmet('/narratorr', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/narratorr/dashboard' });
      const csp = res.headers['content-security-policy'] as string;
      const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
      const htmlNonce = res.body.match(/nonce="([a-f0-9]+)"/)?.[1];

      expect(headerNonce).toBeDefined();
      expect(htmlNonce).toBeDefined();
      expect(htmlNonce).toBe(headerNonce);
      await app.close();
    });
  });

  describe('static asset pass-through', () => {
    it('serves a JS asset file at root prefix instead of HTML fallback', async () => {
      // Create a temp asset file alongside index.html
      const assetContent = 'console.log("app");';
      fs.writeFileSync(path.join(tmpDir, 'app.js'), assetContent);

      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.body).toBe(assetContent);
      await app.close();

      fs.unlinkSync(path.join(tmpDir, 'app.js'));
    });

    it('serves a JS asset file at prefixed URL instead of HTML fallback', async () => {
      const assetContent = 'console.log("prefixed-app");';
      fs.writeFileSync(path.join(tmpDir, 'app.js'), assetContent);

      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '/narratorr', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.body).toBe(assetContent);
      await app.close();

      fs.unlinkSync(path.join(tmpDir, 'app.js'));
    });

    it('serves a CSS asset file instead of HTML fallback', async () => {
      const assetContent = 'body { margin: 0; }';
      fs.writeFileSync(path.join(tmpDir, 'style.css'), assetContent);

      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/style.css' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.body).toBe(assetContent);
      await app.close();

      fs.unlinkSync(path.join(tmpDir, 'style.css'));
    });
  });

  describe('edge cases', () => {
    it('returns no routes when clientPath does not exist', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', '/nonexistent/path');
      await app.ready();

      // Without static routes, Fastify returns its default 404
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('serves HTML without config script when index.html has no </head> tag', async () => {
      const noHeadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-nohead-'));
      fs.writeFileSync(
        path.join(noHeadDir, 'index.html'),
        '<html><body><div id="root"></div></body></html>',
      );

      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', noHeadDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('window.__NARRATORR_URL_BASE__');
      expect(res.body).toContain('<div id="root">');

      await app.close();
      fs.rmSync(noHeadDir, { recursive: true, force: true });
    });

    it('strips query string before SPA path matching', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '/narratorr', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr/library?page=2' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      await app.close();
    });

    it('serves SPA fallback for exact prefix match without trailing slash (/narratorr)', async () => {
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '/narratorr', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/narratorr' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.__NARRATORR_URL_BASE__="/narratorr"');
      await app.close();
    });
  });

  describe('inline script nonce injection', () => {
    it('injects nonce into existing inline theme bootstrap <script> tag', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      // The inline theme script should have a nonce attribute
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">[\s\S]*?localStorage/);
      await app.close();
    });

    it('injected config script still receives nonce (no regression)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">window\.__NARRATORR_URL_BASE__/);
      await app.close();
    });

    it('nonce on inline theme script matches nonce on injected config script (same per-request value)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      const nonceMatches = [...res.body.matchAll(/nonce="([a-f0-9]+)"/g)].map((m) => m[1]);
      // Should have at least 2 nonces (theme script + config script)
      expect(nonceMatches.length).toBeGreaterThanOrEqual(2);
      // All nonces should be the same per-request value
      expect(new Set(nonceMatches).size).toBe(1);
      await app.close();
    });

    it('all inline <script> blocks receive nonces (not just the first match)', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      // Count inline scripts: theme bootstrap + injected config = 2
      const inlineScripts = [...res.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
      expect(inlineScripts.length).toBeGreaterThanOrEqual(2);
      // Every inline script should have a nonce
      for (const match of inlineScripts) {
        expect(match[0]).toMatch(/nonce="[a-f0-9]+"/);
      }
      await app.close();
    });

    it('external <script type="module" ...> tags are NOT modified', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      // The external module script should NOT have a nonce
      expect(res.body).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-abc123\.js"><\/script>/);
      await app.close();
    });

    it('script nonce in HTML tags matches the script nonce in CSP header', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      const csp = res.headers['content-security-policy'] as string;
      const headerNonce = csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
      // Get nonce from the inline theme script
      const themeNonce = res.body.match(/<script nonce="([a-f0-9]+)">[\s\S]*?localStorage/)?.[1];

      expect(headerNonce).toBeDefined();
      expect(themeNonce).toBeDefined();
      expect(themeNonce).toBe(headerNonce);
      await app.close();
    });

    it('HTML is returned without nonce attributes when reply.cspNonce is unavailable', async () => {
      // Without helmet, reply.cspNonce is undefined
      const app = Fastify({ logger: false });
      await registerStaticAndSpa(app, '', tmpDir);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      // Theme script should be present but without nonce
      expect(res.body).toMatch(/<script>[\s\S]*?localStorage/);
      expect(res.body).not.toMatch(/<script nonce="[^"]*">[\s\S]*?localStorage/);
      await app.close();
    });

    it('URL_BASE prefix does not interfere with nonce injection on inline scripts', async () => {
      const app = await createAppWithHelmet('/narratorr', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/narratorr/' });
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">[\s\S]*?localStorage/);
      expect(res.body).toMatch(/<script nonce="[a-f0-9]+">window\.__NARRATORR_URL_BASE__="/);
      await app.close();
    });

    it('nonce injection handles multiline inline script content without corruption', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res = await app.inject({ method: 'GET', url: '/' });
      // The full theme script body should be intact
      expect(res.body).toContain('localStorage.getItem("theme")');
      expect(res.body).toContain('document.documentElement.classList.add("dark")');
      await app.close();
    });

    it('HTML with no inline scripts passes through without errors', async () => {
      const noScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-noscript-'));
      fs.writeFileSync(
        path.join(noScriptDir, 'index.html'),
        '<html><head></head><body><div id="root"></div></body></html>',
      );

      const app = await createAppWithHelmet('', noScriptDir);
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="root">');
      await app.close();
      fs.rmSync(noScriptDir, { recursive: true, force: true });
    });

    it('nonce values are unique across sequential requests', async () => {
      const app = await createAppWithHelmet('', tmpDir);

      const res1 = await app.inject({ method: 'GET', url: '/' });
      const res2 = await app.inject({ method: 'GET', url: '/' });
      const themeNonce1 = res1.body.match(/<script nonce="([a-f0-9]+)">[\s\S]*?localStorage/)?.[1];
      const themeNonce2 = res2.body.match(/<script nonce="([a-f0-9]+)">[\s\S]*?localStorage/)?.[1];

      expect(themeNonce1).toBeDefined();
      expect(themeNonce2).toBeDefined();
      expect(themeNonce1).not.toBe(themeNonce2);
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
