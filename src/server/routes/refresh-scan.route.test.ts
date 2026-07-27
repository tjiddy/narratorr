import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { RefreshScanError } from '../services/refresh-scan.service.js';

vi.mock('../utils/cover-cache.js', () => ({
  serveCoverFromCache: vi.fn().mockResolvedValue(null),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
  COVER_FILE_REGEX: /^cover\.(jpg|jpeg|png|webp)$/i,
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

vi.mock('../services/refresh-scan.service.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    refreshScanBook: vi.fn(),
  };
});

import { refreshScanBook } from '../services/refresh-scan.service.js';

describe('POST /api/books/:id/refresh-scan', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    vi.mocked(refreshScanBook).mockReset();
  });

  it('returns 200 with RefreshScanResult shape on success', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });
  });

  it('durationMinutes is in minutes, not raw seconds', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1,
      codec: 'aac',
      bitrate: 256000,
      fileCount: 1,
      durationMinutes: 2,
      narratorsUpdated: false,
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    const body = JSON.parse(res.payload);
    expect(body.durationMinutes).toBe(2);
  });

  it('narratorsUpdated is true when tagNarrator was present', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: true,
    });
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(JSON.parse(res.payload).narratorsUpdated).toBe(true);
  });

  it('narratorsUpdated is false when tagNarrator was absent', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
    });
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(JSON.parse(res.payload).narratorsUpdated).toBe(false);
  });

  it('returns 404 with error body when book ID does not exist', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NOT_FOUND', 'Book 999 not found'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/999/refresh-scan' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book 999 not found' });
  });

  it('returns 400 with error body when book has no path', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_PATH', 'Book 1 has no library path — import it first'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book 1 has no library path — import it first' });
  });

  it('returns 400 with error body when book path does not exist on disk', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('PATH_MISSING', 'Book path does not exist on disk: /lib/book'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book path does not exist on disk: /lib/book' });
  });

  it('returns 400 with error body when no audio files found', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_AUDIO_FILES', 'No audio files found in book directory'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'No audio files found in book directory' });
  });

  it('returns 500 with generic error body on unexpected error', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(new Error('Unexpected'));
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
  });

  it('passes bookService, settingsService, and request.log to refreshScanBook', async () => {
    vi.mocked(refreshScanBook).mockResolvedValue({
      bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
    });
    await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(refreshScanBook).toHaveBeenCalledWith(
      1,
      expect.anything(), // bookService
      expect.anything(), // settingsService
      expect.anything(), // request.log
    );
  });

  // ==========================================================================
  // #1960 AC15–AC17 — the companion reconcile is `finally`-shaped at THIS route
  // ==========================================================================

  describe('#1960 companion-ebook reconcile', () => {
    const reconcileMock = () => services.companionEbook.reconcileBook as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      reconcileMock().mockResolvedValue(undefined);
    });

    it('AC17: a successful scan fires exactly one reconcileBook for that book', async () => {
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 7, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(7);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    // AC16 — every coded error is thrown BEFORE the audio probe, so a failing probe (or a
    // missing directory) must still refresh the companion observation. The HTTP mapping for
    // each code is asserted unchanged alongside the trigger.
    it.each([
      ['NOT_FOUND', 'Book 5 not found', 404],
      ['NO_PATH', 'Book 5 has no library path — import it first', 400],
      ['PATH_MISSING', 'Book path does not exist on disk: /lib/book', 400],
      ['NO_AUDIO_FILES', 'No audio files found in book directory', 400],
    ] as const)('AC16: %s still fires one reconcileBook and keeps its %i mapping', async (code, message, status) => {
      vi.mocked(refreshScanBook).mockRejectedValue(new RefreshScanError(code, message));

      const res = await app.inject({ method: 'POST', url: '/api/books/5/refresh-scan' });

      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.payload)).toEqual({ error: message });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
      expect(reconcileMock()).toHaveBeenCalledWith(5);
    });

    it('AC16: an unexpected throw still fires one reconcileBook and keeps its 500', async () => {
      vi.mocked(refreshScanBook).mockRejectedValue(new Error('Unexpected'));

      const res = await app.inject({ method: 'POST', url: '/api/books/5/refresh-scan' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
      expect(reconcileMock()).toHaveBeenCalledTimes(1);
    });

    it('AC15: a rejecting reconciler changes neither the status code nor the body', async () => {
      reconcileMock().mockRejectedValue(new Error('reconcile rejected'));
      vi.mocked(refreshScanBook).mockResolvedValue({
        bookId: 3, codec: 'mp3', bitrate: 128000, fileCount: 2, durationMinutes: 30, narratorsUpdated: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/3/refresh-scan' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).bookId).toBe(3);
    });
  });
});
