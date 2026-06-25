import { test, expect } from '@playwright/test';
import { SEED_BOOK_TITLE } from '../../fixtures/seed.js';

/**
 * Forms-auth browser coverage — runs ONLY under the `chromium-forms` project
 * (selected by `testMatch: AUTH_SPECS` in playwright.config.ts), against the
 * forms server booted at port 3102 WITHOUT `AUTH_BYPASS`. The project depends on
 * `auth-setup`, which bootstraps the user, flips the server to `forms` mode, logs
 * in, and saves the authenticated `storageState` this project inherits.
 *
 * This is the assembled coverage the units can't give: the real browser → cookie
 * → server loop for login, the client-side redirect of unauthenticated users, and
 * session clearing on logout. The server auth chain and the client redirect each
 * have unit/component coverage; nothing else exercises them end-to-end.
 *
 * No logout UI control is rendered (the client exposes `logout()` but no
 * component calls it), and this issue is scoped to no production code changes, so
 * logout is exercised through the `POST /api/auth/logout` API via `page.request`.
 */
test.describe('Forms auth', () => {
  test.describe('unauthenticated', () => {
    // Override the project's authenticated storageState with a clean context so
    // this browser has no session cookie. This is the live guard against the
    // bypass footgun: if AUTH_BYPASS or localBypass were accidentally active,
    // this navigation would NOT redirect and the test would fail.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('redirects to /login when not authenticated', async ({ page }) => {
      await page.goto('/library');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('Username')).toBeVisible();
    });
  });

  test('authenticated storageState reaches the library', async ({ page }) => {
    await page.goto('/library');

    // Not bounced to /login, and the seeded book proves /api/books returned real
    // data with the session cookie attached end-to-end.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

    // The page-context request carries the saved session cookie, so status
    // reports an authenticated forms session.
    const status = await page.request.get('/api/auth/status');
    expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ mode: 'forms', authenticated: true });
  });

  test('logout clears the session and a fresh navigation redirects to /login', async ({ page }) => {
    // Logout via the API from the page's browser context — the request sends the
    // session cookie and receives the clearing Set-Cookie into the same jar.
    // Logout is a public POST and needs no CSRF header in forms mode.
    const loggedOut = await page.request.post('/api/auth/logout');
    expect(loggedOut.status()).toBe(200);

    await page.goto('/library');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('rejects bad credentials with 401', async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: 'e2e-forms-user', password: 'wrong-password' },
    });
    expect(res.status()).toBe(401);
  });
});
