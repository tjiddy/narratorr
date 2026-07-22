import { test, expect } from '@playwright/test';

/**
 * Unsaved-changes guard (#1888) — real-browser coverage the JSDOM units can't
 * give: actual cross-document navigation and the native `beforeunload` prompt.
 *
 * Runs under the root `chromium` project against the seeded root server. It is
 * read-mostly: it dirties the Merge & Convert (Audio Tools) card in memory and
 * either stays or discards — it never saves, so it leaves the seeded settings
 * untouched.
 */
test.describe('Unsaved-changes guard (#1888)', () => {
  // Dirty the Output format select on the Audio Tools page; returns the value
  // it was changed to so callers can assert draft retention.
  async function dirtyAudioTools(page: import('@playwright/test').Page): Promise<string> {
    await page.goto('/settings/audio-tools');
    const format = page.getByLabel('Output format');
    await expect(format).toBeVisible();
    const original = await format.inputValue();
    const next = original === 'mp3' ? 'm4b' : 'mp3';
    await format.selectOption(next);
    return next;
  }

  test('dirty card blocks a settings-tab click, names the card, and Stay keeps the draft', async ({ page }) => {
    const dirtied = await dirtyAudioTools(page);

    await page.getByRole('link', { name: 'Indexers' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Unsaved changes');
    await expect(dialog).toContainText('Merge & Convert');

    // Stay closes the modal, keeps the page and the draft value.
    await page.getByRole('button', { name: 'Stay on page' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/audio-tools$/);
    await expect(page.getByLabel('Output format')).toHaveValue(dirtied);
  });

  test('Discard completes the originally clicked navigation', async ({ page }) => {
    await dirtyAudioTools(page);

    await page.getByRole('link', { name: 'Indexers' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();

    await expect(page).toHaveURL(/\/settings\/indexers$/);
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('reload while dirty triggers the native beforeunload prompt', async ({ page }) => {
    await dirtyAudioTools(page);

    const dialogTypes: string[] = [];
    page.on('dialog', (d) => {
      dialogTypes.push(d.type());
      // Dismiss = "stay" — cancels the reload so the test stays deterministic.
      void d.dismiss();
    });

    // The reload is cancelled by dismissing the beforeunload dialog; swallow the
    // resulting navigation rejection.
    await page.reload({ timeout: 3000 }).catch(() => {});

    expect(dialogTypes).toContain('beforeunload');
  });

  test('Discard of a document navigation does not double-prompt (AC5)', async ({ page }) => {
    await dirtyAudioTools(page);

    // Append a same-origin plain anchor OUTSIDE the React root, so activating it
    // is a real document navigation (not an SPA Link). The guard intercepts it,
    // and Discard must replay it without a second `beforeunload` prompt.
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'e2e-doc-nav';
      a.href = '/library';
      a.textContent = 'doc-nav';
      document.body.appendChild(a);
    });

    // Fail the test if ANY beforeunload fires during the discard replay.
    let sawBeforeunload = false;
    const onDialog = (d: import('@playwright/test').Dialog) => {
      if (d.type() === 'beforeunload') sawBeforeunload = true;
      void d.accept();
    };
    page.on('dialog', onDialog);

    await page.locator('#e2e-doc-nav').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();

    // The plain-anchor destination document actually loads.
    await expect(page).toHaveURL(/\/library$/);
    expect(sawBeforeunload).toBe(false);
  });
});
