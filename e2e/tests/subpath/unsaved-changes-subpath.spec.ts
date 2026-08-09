import { test, expect } from '@playwright/test';
import { URL_BASE_SUBPATH } from '../../fixtures/subpath.js';

// Discard replay must preserve the router basename without doing subpath math in the guard.
test.describe('Unsaved-changes guard under subpath (#1888)', () => {
  test('Discard to the logo lands on Library under the /narratorr prefix', async ({ page }) => {
    // Relative navigation stays under the trailing-slash subpath baseURL.
    await page.goto('settings/audio-tools');

    const format = page.getByLabel('Output format');
    await expect(format).toBeVisible();
    const original = await format.inputValue();
    await format.selectOption(original === 'mp3' ? 'm4b' : 'mp3');

    await page.getByRole('link', { name: 'narratorr' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Merge & Convert');

    await page.getByRole('button', { name: 'Discard changes' }).click();

    // Replay must preserve the basename through the home-to-library redirect.
    await expect(page).toHaveURL(new RegExp(`${URL_BASE_SUBPATH}/library/?$`));
  });
});
