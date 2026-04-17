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
      // Capture the specific button locator so we can assert pending state
      // before the mutation resolves (clicking a fresh locator would re-resolve
      // after the modal closes and miss the pending window).
      const grabButton = page.getByRole('button', { name: /^Grab$/i }).first();
      await grabButton.click();
      // ReleaseCard.tsx:133 disables the button while `isGrabbing` is true —
      // the React state flip happens synchronously with the click before the
      // mutation settles, so the assertion below should catch the pending
      // state without racing the success path.
      await expect(grabButton).toBeDisabled();
      // Grab success toast comes from grabMutation.onSuccess in SearchReleasesModal.
      await expect(page.getByText(/Download started/i)).toBeVisible({ timeout: 10_000 });
      // SearchReleasesModal.tsx:158 calls `onClose()` on mutation success —
      // dialog must go away rather than stay stuck open.
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
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

    // ── Wait for import to land and assert state on BOTH /library and detail ─
    // Issue #614 explicitly names "same book card now renders with imported
    // status" on /library as the user-visible outcome. Without asserting that,
    // a regression in the library-page books query or card rendering could
    // slip through if only the detail page still reflected the import.
    await test.step('library card shows Imported status', async () => {
      // The monitor polls every 2s (E2E override), then fire-and-forget import
      // runs. Budget ~25s to cover: poll (up to 2s) + import (file copy + DB
      // writes, usually sub-second) + SSE/query refetch propagation.
      await page.goto('/library');
      // LibraryBookCard.tsx:113 — status-bar class comes from
      // `bookStatusConfig[book.status].barClass`. `imported` maps to
      // `bg-emerald-500` (src/client/lib/status.ts:37), so the emerald class
      // appearing on the card proves the library-page query picked up the
      // import and mapped it to the imported bucket.
      const statusBar = page.locator('[data-testid="status-bar"]').first();
      await expect(statusBar).toHaveClass(/bg-emerald-500/, { timeout: 25_000 });
    });

    await test.step('book detail confirms Imported status', async () => {
      // Target the library card's role=link specifically — the success toast
      // ("E2E Test Book imported successfully") also contains the title, so
      // `getByText(...).first()` can match the toast and click nowhere useful.
      await page.getByRole('link', { name: /E2E Test Book/ }).first().click();
      await expect(page).toHaveURL(/\/books\/\d+$/);
      await expect(page.getByText('Imported', { exact: true })).toBeVisible({ timeout: 10_000 });
    });
  });
});
