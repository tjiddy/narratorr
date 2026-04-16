import { test, expect } from '@playwright/test';

test.describe('Library page (smoke)', () => {
  test('loads successfully and renders empty-library state', async ({ page }) => {
    await page.goto('/library');

    // `LibraryHeader` renders in ALL paths (loading / error / empty / populated),
    // so asserting on the header alone can't distinguish a successful load from
    // a stuck loading spinner or a failed `/api/books` fetch. Instead, assert
    // on `EmptyLibraryState`'s title — it only mounts after `useLibraryPageState`
    // settles with an empty book list, which is the fresh-DB happy path for
    // Phase 1.
    await expect(page.getByText('Your library is empty')).toBeVisible();
  });
});
