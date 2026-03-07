import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

vi.mock('../../core/utils/audio-processor.js', () => ({
  probeFfmpeg: vi.fn(),
}));

import { probeFfmpeg } from '../../core/utils/audio-processor.js';

const mockProbeFfmpeg = vi.mocked(probeFfmpeg);

const mockSettings = {
  library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
  search: { intervalMinutes: 360, enabled: true },
  import: { deleteAfterImport: false, minSeedTime: 60 },
  general: { logLevel: 'info' },
  processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
};

describe('settings routes', () => {
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
  });

  describe('GET /api/settings', () => {
    it('returns all settings', async () => {
      (services.settings.getAll as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.library.path).toBe('/audiobooks');
      expect(body.search.enabled).toBe(true);
    });
  });

  describe('PUT /api/settings', () => {
    it('updates settings', async () => {
      const updated = { ...mockSettings, library: { path: '/new', folderFormat: '{title}' } };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { library: { path: '/new', folderFormat: '{title}' } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).library.path).toBe('/new');
    });

    it('accepts partial updates', async () => {
      (services.settings.update as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { search: { enabled: false } },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/settings/ffmpeg-probe', () => {
    it('returns version string on success', async () => {
      mockProbeFfmpeg.mockResolvedValue('6.1.1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/ffmpeg-probe',
        payload: { path: '/usr/bin/ffmpeg' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).version).toBe('6.1.1');
    });

    it('returns 400 on probe failure', async () => {
      mockProbeFfmpeg.mockRejectedValue(new Error('spawn ENOENT'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/ffmpeg-probe',
        payload: { path: '/bad/path' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('spawn ENOENT');
    });

    it('validates path is required', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/ffmpeg-probe',
        payload: { path: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/settings (processing)', () => {
    it('saves processing settings with valid ffmpeg path', async () => {
      const updated = {
        ...mockSettings,
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg' } },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects save when processing enabled with empty ffmpeg path', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { enabled: true, ffmpegPath: '' } },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('error paths', () => {
    it('GET /api/settings returns 500 when service throws', async () => {
      (services.settings.getAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('PUT /api/settings returns 500 when service throws', async () => {
      (services.settings.update as Mock).mockRejectedValue(new Error('Upsert failed'));

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { library: { path: '/new' } },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });
  });
});
