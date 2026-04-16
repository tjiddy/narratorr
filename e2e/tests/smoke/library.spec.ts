import { test, expect } from '@playwright/test';

test.describe('Library page (smoke)', () => {
  test('renders header and subtitle', async ({ page }) => {
    await page.goto('/library');

    await expect(
      page.getByRole('heading', { level: 1, name: 'Library' }),
    ).toBeVisible();

    await expect(
      page.getByText('Your audiobook collection', { exact: true }),
    ).toBeVisible();
  });
});
