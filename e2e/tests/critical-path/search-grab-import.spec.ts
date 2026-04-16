import { test, expect } from '@playwright/test';
import { qbitControlUrl } from '../../global-setup.js';

/**
 * Phase 2 critical path #1 — exercises the full grab → import → library pipeline:
 *
 *   /library (seeded book, status=wanted)
 *     → open book detail
 *     → Search Releases modal
 *     → Grab fake MAM result
 *     → trigger fake qBit completion
 *     → monitor detects, fires import
 *     → /books/:id shows status=Imported
 *
 * globalSetup boots two Fastify fakes (MAM on :4100, qBit on :4200) and seeds
 * the DB with a book/author/indexer/client. Narratorr's monitor runs at
 * `MONITOR_INTERVAL_CRON='*\/2 * * * * *'` (env override) so this test doesn't
 * wait a full 30 seconds per run.
 */

test.describe('Critical path: search → grab → import → library', () => {
  test('seeded book grabs from fake MAM, completes via fake qBit, imports, and renders as Imported', async ({ page }) => {
    // Playwright's globalSetup `process.env` mutations do NOT propagate to test
    // worker processes — the helper falls back to the default qBit port (4200),
    // which matches playwright.config.ts's fixed E2E_QBIT_PORT.

    // ── Library: seeded book is visible ────────────────────────────────────
    await test.step('library page shows the seeded book', async () => {
      await page.goto('/library');
      await expect(page.getByText('E2E Test Book').first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Book detail ────────────────────────────────────────────────────────
    await test.step('opens the book detail page', async () => {
      await page.getByText('E2E Test Book').first().click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      // BookHero renders the title as its h1/heading equivalent.
      await expect(page.getByRole('heading', { name: 'E2E Test Book' })).toBeVisible();
    });

    // ── Search Releases modal ──────────────────────────────────────────────
    await test.step('opens Search Releases and shows fake MAM results', async () => {
      await page.getByRole('button', { name: /Search Releases/i }).click();
      // Auto-search fires on modal open; allow a couple seconds for the fake MAM
      // round trip + data-URI resolution.
      await expect(page.getByText(/E2E Test Book \[Unabridged\]/).first()).toBeVisible({ timeout: 15_000 });
    });

    // ── Grab ───────────────────────────────────────────────────────────────
    await test.step('clicks Grab on the result', async () => {
      // Result card has a Grab button per row — take the first.
      await page.getByRole('button', { name: /^Grab$/i }).first().click();
      // Grab success toast comes from grabMutation.onSuccess in SearchReleasesModal.
      await expect(page.getByText(/Download started/i)).toBeVisible({ timeout: 10_000 });
    });

    // ── Trigger fake qBit completion ──────────────────────────────────────
    await test.step('fake qBit flips the torrent to complete', async () => {
      const res = await fetch(qbitControlUrl('/__control/complete-latest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    // ── Wait for import to land and navigate to book detail ───────────────
    await test.step('book transitions to Imported on the detail page', async () => {
      // The monitor polls every 2s (E2E override), then fire-and-forget import
      // runs. Budget ~25s to cover: poll (up to 2s) + import (file copy + DB
      // writes, usually sub-second) + SSE/query refetch propagation.
      await page.goto('/library');
      await page.getByText('E2E Test Book').first().click();
      await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 25_000 });
    });
  });
});
