import { test, expect } from '@playwright/test';

test.describe('Library page (smoke)', () => {
  test('loads successfully and renders the seeded book card', async ({ page }) => {
    await page.goto('/library');

    // Phase 2 seeds one book pre-boot (see e2e/fixtures/seed.ts). The smoke
    // assertion therefore checks for the populated-library path: the book card
    // renders the seeded title. This is stronger than the earlier "empty
    // library" smoke — it proves `/api/books` returned real data end-to-end.
    await expect(page.getByText('E2E Test Book').first()).toBeVisible();
  });
});
