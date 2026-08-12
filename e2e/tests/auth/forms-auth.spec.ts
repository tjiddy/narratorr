import { test, expect } from '@playwright/test';
import { SEED_BOOK_TITLE } from '../../fixtures/seed.js';

// Real browser/cookie coverage under `chromium-forms`; logout uses `page.request` because no UI control exists.
test.describe('Forms auth', () => {
  test.describe('unauthenticated', () => {
    // Override inherited storage so this actually exercises the unauthenticated guard.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('redirects to /login when not authenticated', async ({ page }) => {
      await page.goto('/library');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('Username')).toBeVisible();
    });
  });

  test('authenticated storageState reaches the library', async ({ page }) => {
    await page.goto('/library');

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(SEED_BOOK_TITLE).first()).toBeVisible();

    const status = await page.request.get('/api/auth/status');
    expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ mode: 'forms', authenticated: true });
  });

  test('logout clears the session and a fresh navigation redirects to /login', async ({ page }) => {
    // `page.request` sends and clears the same session cookie; forms logout needs no CSRF header.
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
