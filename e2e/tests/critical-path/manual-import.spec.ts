import { test, expect } from '@playwright/test';

import { getE2ESourcePath, SEED_MANUAL_IMPORT_TITLE, SEED_MANUAL_IMPORT_AUTHOR } from '../../global-setup.js';

test.describe('Critical path: manual import', () => {
  test('scans a source folder, edits metadata, imports, and renders as Imported on /library', async ({ page }) => {
    const sourcePath = getE2ESourcePath();

    await test.step('navigate to /library and click Import Files via the Library Actions menu', async () => {
      await page.goto('/library');
      await expect(page.getByRole('button', { name: 'Library Actions' })).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Library Actions' }).click();
      await expect(page.getByRole('menuitem', { name: /Import Files/i })).toBeVisible();
      await page.getByRole('menuitem', { name: /Import Files/i }).click();
      await expect(page).toHaveURL(/\/import$/);
    });

    await test.step('enter sourcePath and scan', async () => {
      const pathInput = page.getByPlaceholder('/path/to/audiobooks');
      await expect(pathInput).toBeVisible();
      await pathInput.fill(sourcePath);
      await page.getByRole('button', { name: /^Scan$/i }).click();

      // Title and author also appear in the folder path, so `.first()` avoids strict-mode ambiguity.
      await expect(page.getByText(SEED_MANUAL_IMPORT_TITLE).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(SEED_MANUAL_IMPORT_AUTHOR).first()).toBeVisible();
    });

    await test.step('match completes with no-match (Audible fake returns empty for structured search)', async () => {
      await expect(page.getByText('No Match').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /^Import/i })).toBeDisabled();
    });

    await test.step('open Edit Metadata, search, select result, save', async () => {
      await page.getByLabel('Edit metadata').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: /Search/i }).click();

      const resultButton = dialog.getByRole('button', { name: /E2E Manual Import Book/i }).first();
      await expect(resultButton).toBeVisible({ timeout: 10_000 });
      await resultButton.click();

      await dialog.getByRole('button', { name: /Save/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    });

    await test.step('Import button is enabled after metadata edit', async () => {
      const importBtn = page.getByRole('button', { name: /^Import 1/i });
      await expect(importBtn).toBeEnabled({ timeout: 5_000 });
    });

    await test.step('lose the first chunk PUT response AFTER the server persists it, then recover via retry → finalize → complete', async () => {
      // Persist the first PUT, then hide its response with a 503 so retry tests replay idempotency.
      let putLostOnce = false;
      let serverAcceptedFirstPut = false;
      await page.route('**/api/import/submissions/*/items', async (route) => {
        if (route.request().method() === 'PUT' && !putLostOnce) {
          putLostOnce = true;
          const serverResponse = await route.fetch();
          serverAcceptedFirstPut = serverResponse.ok();
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'e2e-lost-put-response' }) });
          return;
        }
        await route.continue();
      });

      await page.getByRole('button', { name: /^Import 1/i }).click();

      await expect(page.getByText(/queued for import/i)).toBeVisible({ timeout: 20_000 });
      await page.waitForURL(/\/library/, { timeout: 10_000 });
      expect(putLostOnce).toBe(true);
      expect(serverAcceptedFirstPut).toBe(true);
      await page.unroute('**/api/import/submissions/*/items');
    });

    await test.step('exactly one imported card for the seed title (bg-emerald-500)', async () => {
      const bookCards = page.getByRole('link', { name: new RegExp(SEED_MANUAL_IMPORT_TITLE) });
      await expect(bookCards.first().getByTestId('status-bar')).toHaveClass(/bg-emerald-500/, { timeout: 15_000 });
      // Replaying an ordinal must not create a duplicate registration.
      await expect(bookCards).toHaveCount(1);
    });

    await test.step('book detail page shows Imported status', async () => {
      await page.getByRole('link', { name: new RegExp(SEED_MANUAL_IMPORT_TITLE) }).click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 10_000 });
    });
  });
});
