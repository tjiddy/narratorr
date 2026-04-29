import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { createMockSettings } from '../../shared/schemas/settings/create-mock-settings.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import type { Services } from './index.js';

const mockSettings = createMockSettings();

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
      (services.healthCheck.probeFfmpeg as Mock).mockResolvedValue('6.1.1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/ffmpeg-probe',
        payload: { path: '/usr/bin/ffmpeg' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).version).toBe('6.1.1');
    });

    it('returns 400 on probe failure', async () => {
      (services.healthCheck.probeFfmpeg as Mock).mockRejectedValue(new Error('spawn ENOENT'));

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
        processing: { ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { ffmpegPath: '/usr/bin/ffmpeg' } },
      });

      expect(res.statusCode).toBe(200);
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

  describe('PUT /api/settings (quality maxDownloadSize)', () => {
    it('round-trips quality.maxDownloadSize through PUT and returns updated value', async () => {
      const updated = {
        ...mockSettings,
        quality: { ...mockSettings.quality, maxDownloadSize: 10 },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { quality: { maxDownloadSize: 10 } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.quality.maxDownloadSize).toBe(10);
    });

    it('returns default maxDownloadSize when not previously set', async () => {
      (services.settings.getAll as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.quality.maxDownloadSize).toBe(5);
    });
  });

  describe('PUT /api/settings (housekeeping)', () => {
    it('round-trips housekeepingRetentionDays through PUT and returns updated value', async () => {
      const updated = {
        ...mockSettings,
        general: { logLevel: 'info', housekeepingRetentionDays: 30 },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { housekeepingRetentionDays: 30 } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).general.housekeepingRetentionDays).toBe(30);
      expect(services.settings.update).toHaveBeenCalledWith(
        expect.objectContaining({ general: expect.objectContaining({ housekeepingRetentionDays: 30 }) }),
      );
    });

    it('rejects housekeepingRetentionDays below minimum (0)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { housekeepingRetentionDays: 0 } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects housekeepingRetentionDays above maximum (366)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { housekeepingRetentionDays: 366 } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects non-integer housekeepingRetentionDays', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { housekeepingRetentionDays: 30.5 } },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/settings (welcomeSeen)', () => {
    it('round-trips welcomeSeen: false through PUT and returns updated value', async () => {
      const updated = {
        ...mockSettings,
        general: { ...mockSettings.general, welcomeSeen: false },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { welcomeSeen: false } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).general.welcomeSeen).toBe(false);
      expect(services.settings.update).toHaveBeenCalledWith(
        expect.objectContaining({ general: expect.objectContaining({ welcomeSeen: false }) }),
      );
    });

    it('round-trips welcomeSeen: true through PUT and returns updated value', async () => {
      const updated = {
        ...mockSettings,
        general: { ...mockSettings.general, welcomeSeen: true },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { welcomeSeen: true } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).general.welcomeSeen).toBe(true);
      expect(services.settings.update).toHaveBeenCalledWith(
        expect.objectContaining({ general: expect.objectContaining({ welcomeSeen: true }) }),
      );
    });

    it('preserves welcomeSeen when PUT only updates logLevel', async () => {
      const updated = {
        ...mockSettings,
        general: { logLevel: 'debug', housekeepingRetentionDays: 90, welcomeSeen: true },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { general: { logLevel: 'debug' } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).general.welcomeSeen).toBe(true);
      expect(JSON.parse(res.payload).general.logLevel).toBe('debug');
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
      (services.healthCheck.probeProxy as Mock).mockResolvedValue('203.0.113.42');

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test-proxy',
        payload: { proxyUrl: 'http://proxy.example.com:8080' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.ip).toBe('203.0.113.42');
      expect((services.healthCheck.probeProxy as Mock)).toHaveBeenCalledWith('http://proxy.example.com:8080');
    });

    it('returns failure with error message for unreachable proxy', async () => {
      (services.healthCheck.probeProxy as Mock).mockRejectedValue(new Error('Proxy connection failed: ECONNREFUSED'));

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

    describe('sentinel passthrough (#827)', () => {
      it('resolves sentinel against saved proxy URL when set', async () => {
        (services.settings.get as Mock).mockResolvedValue({ proxyUrl: 'http://real:cred@host:9191' });
        (services.healthCheck.probeProxy as Mock).mockResolvedValue('1.2.3.4');

        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '********' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.ip).toBe('1.2.3.4');
        expect(services.healthCheck.probeProxy).toHaveBeenCalledWith('http://real:cred@host:9191');
        expect(services.healthCheck.probeProxy).not.toHaveBeenCalledWith('********');
      });

      it('returns 400 when sentinel sent but no saved proxy URL', async () => {
        (services.settings.get as Mock).mockResolvedValue({ proxyUrl: null });

        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '********' },
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBe('No saved proxy URL to test');
        expect(services.healthCheck.probeProxy).not.toHaveBeenCalled();
      });

      it('returns 400 when sentinel sent and network settings missing entirely', async () => {
        (services.settings.get as Mock).mockResolvedValue(undefined);

        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '********' },
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBe('No saved proxy URL to test');
        expect(services.healthCheck.probeProxy).not.toHaveBeenCalled();
      });

      it('passes through real URL untouched (regression)', async () => {
        (services.healthCheck.probeProxy as Mock).mockResolvedValue('1.2.3.4');

        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: 'http://user:pass@host:9191' },
        });

        expect(res.statusCode).toBe(200);
        expect(services.healthCheck.probeProxy).toHaveBeenCalledWith('http://user:pass@host:9191');
      });

      it('still rejects malformed URLs', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: 'not-a-url' },
        });

        expect(res.statusCode).toBe(400);
      });

      it('still rejects empty string', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '' },
        });

        expect(res.statusCode).toBe(400);
      });
    });
  });

  describe('inline schema trim behavior', () => {
    describe('POST /api/settings/ffmpeg-probe — trim', () => {
      it('returns 400 when path is whitespace-only', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/ffmpeg-probe',
          payload: { path: '   ' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('calls handler with trimmed path when surrounding spaces provided', async () => {
        (services.healthCheck.probeFfmpeg as Mock).mockResolvedValue('6.1.1');
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/ffmpeg-probe',
          payload: { path: '  /usr/bin/ffmpeg  ' },
        });
        expect(res.statusCode).toBe(200);
        expect((services.healthCheck.probeFfmpeg as Mock)).toHaveBeenCalledWith('/usr/bin/ffmpeg');
      });
    });

    describe('POST /api/settings/test-proxy — trim', () => {
      it('returns 400 when proxyUrl is whitespace-only', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '   ' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('calls handler with trimmed proxyUrl when surrounding spaces provided', async () => {
        (services.healthCheck.probeProxy as Mock).mockResolvedValue('1.2.3.4');
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '  http://proxy:8080  ' },
        });
        expect(res.statusCode).toBe(200);
        expect((services.healthCheck.probeProxy as Mock)).toHaveBeenCalledWith('http://proxy:8080');
      });
    });
  });

  describe('network settings', () => {
    it('saves network settings with valid proxy URL', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: 'http://proxy.example.com:8080' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);
      (services.settings.get as Mock).mockResolvedValue({ proxyUrl: '' });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: 'http://proxy.example.com:8080' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // proxyUrl is masked in API response (secret field)
      expect(body.network.proxyUrl).toBe('********');
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
      // proxyUrl is masked in API response (secret field)
      expect(body.network.proxyUrl).toBe('********');
    });

    it('clears proxy URL when saving empty string', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: '' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);
      (services.settings.get as Mock).mockResolvedValue({ proxyUrl: 'http://old:8080' });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: '' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // Empty proxyUrl is preserved as-is — not masked to sentinel
      expect(body.network.proxyUrl).toBe('');
    });

    it('GET /api/settings returns proxyUrl as empty string when not configured — no phantom sentinel', async () => {
      const freshSettings = {
        ...mockSettings,
        network: { proxyUrl: '' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(freshSettings);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.network.proxyUrl).toBe('');
    });

    it('clears indexer adapter cache when network settings actually change', async () => {
      const updated = {
        ...mockSettings,
        network: { proxyUrl: 'http://proxy.example.com:8080' },
      };
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.network);
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

    it('does not clear indexer adapter cache when masked sentinel proxy URL is sent back unchanged', async () => {
      const currentNetwork = { proxyUrl: 'http://proxy.example.com:8080' };
      const updated = { ...mockSettings, network: currentNetwork };
      (services.settings.get as Mock).mockResolvedValue(currentNetwork);
      (services.settings.update as Mock).mockResolvedValue(updated);

      // UI sends back '********' for proxyUrl (masked value from GET)
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: '********' } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.clearAdapterCache).not.toHaveBeenCalled();
    });
  });
});

