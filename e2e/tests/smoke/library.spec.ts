import { test, expect } from '@playwright/test';

test.describe('Library page (smoke)', () => {
  test('loads successfully and renders the seeded book card', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByText('E2E Test Book').first()).toBeVisible();
  });
});
