import { test, expect } from '@playwright/test';
import { qbitControlUrl } from '../../global-setup.js';

// Full fake MAM → qBit → monitor → import pipeline against the production bundle.

test.describe('Critical path: search → grab → import → library', () => {
  test('seeded book grabs from fake MAM, completes via fake qBit, imports, and renders as Imported', async ({ page }) => {
    await test.step('library page shows the seeded book', async () => {
      await page.goto('/library');
      await expect(page.getByText('E2E Test Book').first()).toBeVisible({ timeout: 10_000 });
    });

    await test.step('opens the book detail page', async () => {
      await page.getByText('E2E Test Book').first().click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      await expect(page.getByRole('heading', { name: 'E2E Test Book' })).toBeVisible();
    });

    await test.step('opens Search Releases and shows fake MAM results', async () => {
      await page.getByRole('button', { name: /Search Releases/i }).click();
      // Auto-search fires on open; allow the fake MAM and data-URI round trip.
      await expect(page.getByText(/E2E Test Book \[Unabridged\]/).first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step('clicks Grab on the result', async () => {
      // Hold the original locator; re-resolving after modal close would miss the pending state.
      const grabButton = page.getByRole('button', { name: /^Grab$/i }).first();
      await grabButton.click();
      // Fake qBit latency keeps the transient disabled state observable before success closes the modal.
      await expect(grabButton).toBeDisabled();
      await expect(page.getByText(/Download started/i)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
    });

    await test.step('fake qBit flips the torrent to complete', async () => {
      const res = await fetch(qbitControlUrl('/__control/complete-latest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    // Assert both views; detail state alone would miss a stale library query or card.
    await test.step('library card shows Imported status', async () => {
      // Budget for monitor polling, import work, and SSE/query refresh.
      await page.goto('/library');
      // Emerald is the library card's imported-state signal.
      const statusBar = page.locator('[data-testid="status-bar"]').first();
      await expect(statusBar).toHaveClass(/bg-emerald-500/, { timeout: 25_000 });
    });

    await test.step('book detail confirms Imported status', async () => {
      // Role=link avoids matching the success toast, which repeats the book title.
      await page.getByRole('link', { name: /E2E Test Book/ }).first().click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 10_000 });
    });
  });
});
