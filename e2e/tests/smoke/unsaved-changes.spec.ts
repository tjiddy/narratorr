import { test, expect } from '@playwright/test';

// Real-browser coverage for SPA navigation and native `beforeunload`; these tests never save settings.
test.describe('Unsaved-changes guard (#1888)', () => {
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
      // Dismiss means stay, keeping this native-navigation test deterministic.
      void d.dismiss();
    });

    // Cancelling `beforeunload` rejects the reload promise.
    await page.reload({ timeout: 3000 }).catch(() => {});

    expect(dialogTypes).toContain('beforeunload');
  });

  test('Discard of a document navigation does not double-prompt (AC5)', async ({ page }) => {
    await dirtyAudioTools(page);

    // An anchor outside React forces document navigation; discard must replay it without a second prompt.
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'e2e-doc-nav';
      a.href = '/library';
      a.textContent = 'doc-nav';
      document.body.appendChild(a);
    });

    let sawBeforeunload = false;
    const onDialog = (d: import('@playwright/test').Dialog) => {
      if (d.type() === 'beforeunload') sawBeforeunload = true;
      void d.accept();
    };
    page.on('dialog', onDialog);

    await page.locator('#e2e-doc-nav').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();

    await expect(page).toHaveURL(/\/library$/);
    expect(sawBeforeunload).toBe(false);
  });
});
