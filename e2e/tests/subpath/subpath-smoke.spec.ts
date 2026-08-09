import { test, expect } from '@playwright/test';
import type { Response } from '@playwright/test';
import { URL_BASE_SUBPATH } from '../../fixtures/subpath.js';
import { SEED_BOOK_TITLE } from '../../fixtures/seed.js';

/**
 * Production-build smoke under `/narratorr`. Relative navigation stays under the
 * trailing-slash baseURL; leading-slash requests intentionally escape for scope checks.
 */
test.describe('Subpath deployment (smoke)', () => {
  test('app loads under the subpath and renders the seeded library', async ({ page }) => {
    await page.goto('library');

    // The seeded card proves both prefixed API resolution and router-basename wiring.
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

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

    // Injected `<base>` plus Vite's relative base must keep every asset under the prefix.
    expect(badAssetResponses).toEqual([]);

    // An empty relative request targets the prefixed entry HTML.
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

    // A successful prefixed request proves client API base and server route mount agree.
    const okPrefixed = apiResponses.filter((r) => r.status === 200);
    expect(okPrefixed.length).toBeGreaterThan(0);

    for (const r of apiResponses) {
      expect(r.path.startsWith(`${URL_BASE_SUBPATH}${URL_BASE_SUBPATH}/`)).toBe(false);
      expect(r.status).toBeLessThan(400);
    }
  });

  test('non-prefixed paths are rejected with 404 (scope guard)', async ({ page }) => {
    // A leading slash escapes the baseURL prefix; the SPA scope guard must reject it.
    const response = await page.request.get('/library');
    expect(response.status()).toBe(404);
  });
});
