import { test, expect } from '@playwright/test';
import type { Response } from '@playwright/test';
import { URL_BASE_SUBPATH } from '../../fixtures/subpath.js';
import { SEED_BOOK_TITLE } from '../../fixtures/seed.js';

/**
 * Subpath (reverse-proxy) smoke — runs ONLY under the `chromium-subpath` project
 * (selected by the project's `testMatch` in playwright.config.ts), against the
 * second webServer booted at URL_BASE=/narratorr on port 3101.
 *
 * This is the assembled coverage the units can't give: production build served
 * under a non-root base, driven through a real browser. It is read-mostly — it
 * never grabs/imports — so it stays deterministic against the isolated subpath
 * server's seeded DB.
 *
 * Navigation semantics: the project's baseURL is `http://localhost:3101/narratorr/`
 * (trailing slash). In-scope app routes navigate as RELATIVE paths so Playwright's
 * `new URL(path, baseURL)` resolves them under the prefix. A leading-slash path is
 * origin-rooted and strips the prefix — reserved for the deliberate 404 check.
 */
test.describe('Subpath deployment (smoke)', () => {
  test('app loads under the subpath and renders the seeded library', async ({ page }) => {
    // Relative path → resolves to /narratorr/library against the trailing-slash
    // baseURL. A leading-slash '/library' would hit the non-prefixed path.
    await page.goto('library');

    // Mirrors the root library smoke: the seeded book card proves /api/books
    // returned real data end-to-end — i.e. the client built the API URL under
    // the prefix (window.__NARRATORR_URL_BASE__) and React Router's basename is
    // wired so the route resolved.
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

    // The router basename keeps the browser URL under the prefix.
    expect(page.url()).toMatch(new RegExp(`${URL_BASE_SUBPATH}/library/?$`));
  });

  test('assets resolve under the subpath with no 4xx/5xx', async ({ page }) => {
    const assetPrefix = `${URL_BASE_SUBPATH}/assets/`;
    const badAssetResponses: string[] = [];

    page.on('response', (response: Response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith(assetPrefix) && response.status() >= 400) {
        badAssetResponses.push(`${response.status()} ${path}`);
      }
    });

    await page.goto('library');
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

    // The injected <base href="/narratorr/"> + Vite's relative `base: './'`
    // must make every asset request resolve under the prefix.
    expect(badAssetResponses).toEqual([]);

    // The injected entry HTML carries the prefix in both the <base href> and the
    // runtime URL-base global the client reads. Empty relative path resolves to
    // the prefixed entry (`http://localhost:3101/narratorr/`).
    const html = await (await page.request.get('')).text();
    expect(html).toContain(`<base href="${URL_BASE_SUBPATH}/">`);
    expect(html).toContain(`window.__NARRATORR_URL_BASE__=${JSON.stringify(URL_BASE_SUBPATH)}`);
  });

  test('API-backed page fetches under the prefix and returns data', async ({ page }) => {
    const apiPrefix = `${URL_BASE_SUBPATH}/api/`;
    const apiResponses: Array<{ path: string; status: number }> = [];

    page.on('response', (response: Response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith(apiPrefix)) {
        apiResponses.push({ path, status: response.status() });
      }
    });

    await page.goto('library');
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

    // At least one prefixed API request must have succeeded — proving
    // API_BASE = `${URL_BASE}/api` and the routes registered under the prefix.
    const okPrefixed = apiResponses.filter((r) => r.status === 200);
    expect(okPrefixed.length).toBeGreaterThan(0);

    // None double-prefixed (e.g. /narratorr/narratorr/api) and none failed.
    for (const r of apiResponses) {
      expect(r.path.startsWith(`${URL_BASE_SUBPATH}${URL_BASE_SUBPATH}/`)).toBe(false);
      expect(r.status).toBeLessThan(400);
    }
  });

  test('non-prefixed paths are rejected with 404 (scope guard)', async ({ page }) => {
    // LEADING slash — intentionally origin-rooted, resolving to
    // http://localhost:3101/library (the NON-prefixed path). The SPA-fallback
    // scope guard must return 404 here, not serve the SPA shell.
    const response = await page.request.get('/library');
    expect(response.status()).toBe(404);
  });
});
