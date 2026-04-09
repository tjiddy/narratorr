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

  it('returns 404 when book ID does not exist', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NOT_FOUND', 'Book 999 not found'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/999/refresh-scan' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 NO_PATH when book exists but has no path', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_PATH', 'Book 1 has no library path'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 PATH_MISSING when book path does not exist on disk', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('PATH_MISSING', 'Book path does not exist on disk: /lib/book'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 NO_AUDIO_FILES when scanAudioDirectory returns null', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(
      new RefreshScanError('NO_AUDIO_FILES', 'No audio files found in book directory'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(refreshScanBook).mockRejectedValue(new Error('Unexpected'));
    const res = await app.inject({ method: 'POST', url: '/api/books/1/refresh-scan' });
    expect(res.statusCode).toBe(500);
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
});
