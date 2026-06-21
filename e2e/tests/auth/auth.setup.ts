import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FORMS_USERNAME, FORMS_PASSWORD, AUTH_FILE } from '../../fixtures/auth.js';

/**
 * Forms-auth bootstrap — runs as the `auth-setup` project (the `chromium-forms`
 * project depends on it) against the forms server booted WITHOUT `AUTH_BYPASS`.
 *
 * The order is load-bearing (`AuthService.updateMode` throws 400 if you flip to
 * a non-`none` mode while zero users exist):
 *   1. create the user (public while mode is `none` and no user exists),
 *   2. flip mode to `forms` (allowed while still effectively in `none`),
 *   3. login (establishes the `narratorr_session` cookie),
 *   4. persist that context's storageState for the forms project to reuse.
 *
 * All three HTTP calls MUST go through `page.request` (the page's browser-context
 * request) — NOT the standalone `{ request }` fixture. Only the browser-context
 * request shares its cookie jar with the page, so the login `Set-Cookie` lands in
 * the same jar that `page.context().storageState()` then captures. The isolated
 * `{ request }` fixture would receive the cookie into a separate jar and the
 * saved state would be unauthenticated (login still reports 200, but the forms
 * project would start logged out).
 */
setup('bootstrap forms auth and persist storageState', async ({ page }) => {
  const created = await page.request.post('/api/auth/setup', {
    data: { username: FORMS_USERNAME, password: FORMS_PASSWORD },
  });
  expect(created.status()).toBe(200);

  const configured = await page.request.put('/api/auth/config', {
    data: { mode: 'forms' },
  });
  expect(configured.status()).toBe(200);

  const loggedIn = await page.request.post('/api/auth/login', {
    data: { username: FORMS_USERNAME, password: FORMS_PASSWORD },
  });
  expect(loggedIn.status()).toBe(200);

  // Ensure the gitignored auth directory exists before Playwright writes to it.
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
