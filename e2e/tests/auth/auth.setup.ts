import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FORMS_USERNAME, FORMS_PASSWORD, AUTH_FILE } from '../../fixtures/auth.js';

/**
 * Order is load-bearing: create a user in `none`, switch to `forms`, then login and save state.
 * Use `page.request`, not standalone `request`, so `Set-Cookie` reaches the captured browser context.
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

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
