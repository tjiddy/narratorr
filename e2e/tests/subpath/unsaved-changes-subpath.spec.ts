import { test, expect } from '@playwright/test';
import { URL_BASE_SUBPATH } from '../../fixtures/subpath.js';

/**
 * Unsaved-changes guard under a subpath deployment (#1888) — the exact case the
 * replay design fixes: discarding must land on the destination under the
 * `/narratorr` prefix, with no basename math in the guard. Runs ONLY under the
 * `chromium-subpath` project (selected by the subpath testMatch), against the
 * server booted at URL_BASE=/narratorr.
 *
 * Read-mostly: dirties the Merge & Convert card in memory, then discards to the
 * logo (home) link — it never saves.
 */
test.describe('Unsaved-changes guard under subpath (#1888)', () => {
  test('Discard to the logo lands on Library under the /narratorr prefix', async ({ page }) => {
    // Relative path resolves under the trailing-slash baseURL (/narratorr/).
    await page.goto('settings/audio-tools');

    const format = page.getByLabel('Output format');
    await expect(format).toBeVisible();
    const original = await format.inputValue();
    await format.selectOption(original === 'mp3' ? 'm4b' : 'mp3');

    // The logo NavLink (to="/") is a guarded internal link.
    await page.getByRole('link', { name: 'narratorr' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Merge & Convert');

    await page.getByRole('button', { name: 'Discard changes' }).click();

    // Home ("/") redirects to /library — replay preserves the router basename, so
    // the browser URL stays under the prefix.
    await expect(page).toHaveURL(new RegExp(`${URL_BASE_SUBPATH}/library/?$`));
  });
});
