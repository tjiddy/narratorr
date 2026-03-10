import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

vi.mock('../../core/utils/audio-processor.js', () => ({
  probeFfmpeg: vi.fn(),
}));

vi.mock('../../core/indexers/proxy.js', () => ({
  resolveProxyIp: vi.fn(),
}));

import { probeFfmpeg } from '../../core/utils/audio-processor.js';
import { resolveProxyIp } from '../../core/indexers/proxy.js';

const mockProbeFfmpeg = vi.mocked(probeFfmpeg);
const mockResolveProxyIp = vi.mocked(resolveProxyIp);

const mockSettings = {
  library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
  search: { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 },
  import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 },
  general: { logLevel: 'info' },
  processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2 },
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

  describe('PUT /api/settings (quality word lists)', () => {
    it('persists and returns quality.rejectWords and quality.requiredWords', async () => {
      const updated = {
        ...mockSettings,
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: 'German, Abridged', requiredWords: 'M4B' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { quality: { rejectWords: 'German, Abridged', requiredWords: 'M4B' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.quality.rejectWords).toBe('German, Abridged');
      expect(body.quality.requiredWords).toBe('M4B');
    });

    it('returns default empty strings for new quality fields', async () => {
      const settingsWithDefaults = {
        ...mockSettings,
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsWithDefaults);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.quality.rejectWords).toBe('');
      expect(body.quality.requiredWords).toBe('');
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

  describe('POST /api/settings/test-proxy', () => {
    it('returns success with exit IP for reachable proxy', async () => {
      mockResolveProxyIp.mockResolvedValue('203.0.113.42');

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test-proxy',
        payload: { proxyUrl: 'http://proxy.example.com:8080' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.ip).toBe('203.0.113.42');
      expect(mockResolveProxyIp).toHaveBeenCalledWith('http://proxy.example.com:8080');
    });

    it('returns failure with error message for unreachable proxy', async () => {
      mockResolveProxyIp.mockRejectedValue(new Error('Proxy connection failed: ECONNREFUSED'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test-proxy',
        payload: { proxyUrl: 'http://dead-proxy.example.com:8080' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.message).toContain('ECONNREFUSED');
    });

    it('returns validation error when no proxy URL in body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test-proxy',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns validation error for invalid proxy URL scheme', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test-proxy',
        payload: { proxyUrl: 'ftp://proxy.example.com:21' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('network settings', () => {
    it('saves network settings with valid proxy URL', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: 'http://proxy.example.com:8080' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: 'http://proxy.example.com:8080' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.network.proxyUrl).toBe('http://proxy.example.com:8080');
    });

    it('loads saved network settings', async () => {
      const settingsWithNetwork = {
        ...mockSettings,
        network: { proxyUrl: 'socks5://proxy.example.com:1080' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsWithNetwork);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.network.proxyUrl).toBe('socks5://proxy.example.com:1080');
    });

    it('clears proxy URL when saving empty string', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: '' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: '' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.network.proxyUrl).toBe('');
    });

    it('clears indexer adapter cache when network settings actually change', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: 'http://proxy.example.com:8080' },
      };
      (services.settings.get as Mock).mockResolvedValue({ proxyUrl: '' });
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: 'http://proxy.example.com:8080' } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('network');
      expect(services.indexer.clearAdapterCache).toHaveBeenCalled();
    });

    it('does not clear indexer adapter cache when non-network settings are saved', async () => {
      const updated = { ...mockSettings, library: { path: '/new-path', folderFormat: '{author}/{title}' } };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { library: { path: '/new-path', folderFormat: '{author}/{title}' } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.clearAdapterCache).not.toHaveBeenCalled();
    });

    it('does not clear indexer adapter cache when network settings are unchanged in full-form save', async () => {
      const currentNetwork = { proxyUrl: 'http://proxy.example.com:8080' };
      const updated = { ...mockSettings, network: currentNetwork };
      (services.settings.get as Mock).mockResolvedValue(currentNetwork);
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { ...mockSettings, network: currentNetwork },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('network');
      expect(services.indexer.clearAdapterCache).not.toHaveBeenCalled();
    });
  });
});
