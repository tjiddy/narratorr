import { test, expect } from '@playwright/test';

/**
 * Phase 2 critical path #2 — exercises the full manual-import flow:
 *
 *   /library → "Import Files"
 *     → /import (path step)
 *     → enter sourcePath, click Scan
 *     → Review step: match completes with confidence 'none'
 *     → Edit Metadata: search, select result, save → confidence 'medium'
 *     → Import → success toast → /library
 *     → imported card visible (bg-emerald-500)
 *     → book detail shows "Imported"
 *
 * globalSetup boots the Audible fake on :4300 (empty for structured search,
 * one generic product for keyword search) and pre-populates sourcePath with
 * `E2E Manual Author - E2E Manual Import Book/silent.m4b`.
 *
 * The sourcePath is injected into the webServer via E2E_SOURCE_PATH env var.
 * Since Playwright env mutations don't reach test workers, we read it from
 * playwright.config.ts's static webServer.env (which is deterministic).
 */

// Worker-safe helper — reads from the state file written by globalSetup.
// Unlike fixed-port fakes (qbitControlUrl), sourcePath is a dynamic temp dir
// that changes every run, so we use a file-based handoff mechanism.
import { getE2ESourcePath, SEED_MANUAL_IMPORT_TITLE, SEED_MANUAL_IMPORT_AUTHOR } from '../../global-setup.js';

test.describe('Critical path: manual import', () => {
  test('scans a source folder, edits metadata, imports, and renders as Imported on /library', async ({ page }) => {
    const sourcePath = getE2ESourcePath();

    // ── Library: navigate to import page ─────────────────────────────────
    await test.step('navigate to /library and click Import Files', async () => {
      await page.goto('/library');
      await expect(page.getByRole('link', { name: /Import Files/i })).toBeVisible({ timeout: 10_000 });
      await page.getByRole('link', { name: /Import Files/i }).click();
      await expect(page).toHaveURL(/\/import$/);
    });

    // ── Path step: scan the pre-populated source folder ──────────────────
    await test.step('enter sourcePath and scan', async () => {
      const pathInput = page.getByPlaceholder('/path/to/audiobooks');
      await expect(pathInput).toBeVisible();
      await pathInput.fill(sourcePath);
      await page.getByRole('button', { name: /^Scan$/i }).click();

      // Wait for the Review step to appear with the discovered book.
      // Use .first() — the title/author text appears in both the parsed card
      // fields and the folder path display, triggering strict-mode violations.
      await expect(page.getByText(SEED_MANUAL_IMPORT_TITLE).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(SEED_MANUAL_IMPORT_AUTHOR).first()).toBeVisible();
    });

    // ── Match completes with confidence 'none' ───────────────────────────
    await test.step('match completes with no-match (Audible fake returns empty for structured search)', async () => {
      // Wait for the match job to complete — "No Match" badge appears.
      await expect(page.getByText('No Match').first()).toBeVisible({ timeout: 15_000 });
      // Import button should be disabled because selected rows have unmatched confidence.
      await expect(page.getByRole('button', { name: /^Import/i })).toBeDisabled();
    });

    // ── Edit Metadata: search, select result, save ───────────────────────
    await test.step('open Edit Metadata, search, select result, save', async () => {
      // Open the BookEditModal via the edit button on the import card.
      await page.getByLabel('Edit metadata').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // Click Search within the modal — uses the keyword search path which
      // returns one generic product from the Audible fake.
      await dialog.getByRole('button', { name: /Search/i }).click();

      // Wait for a search result button to appear and click it to select metadata.
      const resultButton = dialog.getByRole('button', { name: /E2E Manual Import Book/i }).first();
      await expect(resultButton).toBeVisible({ timeout: 10_000 });
      await resultButton.click();

      // Save — this triggers handleEdit with metadata set, upgrading
      // confidence from 'none' to 'medium' and auto-checking the row.
      await dialog.getByRole('button', { name: /Save/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    });

    // ── Import button should now be enabled ──────────────────────────────
    await test.step('Import button is enabled after metadata edit', async () => {
      const importBtn = page.getByRole('button', { name: /^Import 1/i });
      await expect(importBtn).toBeEnabled({ timeout: 5_000 });
    });

    // ── Confirm import ───────────────────────────────────────────────────
    await test.step('click Import and verify success toast + navigation', async () => {
      await page.getByRole('button', { name: /^Import 1/i }).click();
      // Success toast from importMutation.onSuccess.
      await expect(page.getByText(/queued for import/i)).toBeVisible({ timeout: 10_000 });
      // Should navigate to /library.
      await page.waitForURL(/\/library/, { timeout: 10_000 });
    });

    // ── Library card shows imported status ────────────────────────────────
    await test.step('library card shows imported status (bg-emerald-500)', async () => {
      // Wait for the background import to complete and the library to refresh.
      // Budget 25s for: background import (file copy + enrichment + DB update)
      // + SSE/query refetch propagation.
      const bookCard = page.getByRole('link', { name: new RegExp(SEED_MANUAL_IMPORT_TITLE) }).first();
      const statusBar = bookCard.getByTestId('status-bar');
      await expect(statusBar).toHaveClass(/bg-emerald-500/, { timeout: 25_000 });
    });

    // ── Book detail page shows "Imported" ────────────────────────────────
    await test.step('book detail page shows Imported status', async () => {
      await page.getByRole('link', { name: new RegExp(SEED_MANUAL_IMPORT_TITLE) }).first().click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 10_000 });
    });
  });
});
