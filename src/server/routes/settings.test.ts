import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import { createMockSettings } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import { RateLimitError, TransientError, MetadataError } from '../../core/metadata/errors.js';
import type * as HardcoverModule from '../../core/metadata/hardcover.js';
import type { Services } from './index.js';

const { mockHardcoverSearchSeries, mockHardcoverClientCtor, mockFetchWithTimeout } = vi.hoisted(() => {
  const searchSeriesFn = vi.fn();
  const ctorFn = vi.fn();
  const fetchFn = vi.fn();
  return {
    mockHardcoverSearchSeries: searchSeriesFn,
    mockHardcoverClientCtor: ctorFn,
    mockFetchWithTimeout: fetchFn,
  };
});

vi.mock('../../core/utils/network-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/utils/network-service.js')>();
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

vi.mock('../../core/metadata/hardcover.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HardcoverModule>();
  class MockHardcoverClient {
    constructor(apiKey: string) {
      mockHardcoverClientCtor(apiKey);
    }
    searchSeries(query: string) {
      return mockHardcoverSearchSeries(query);
    }
  }
  return {
    ...actual,
    HardcoverClient: MockHardcoverClient,
  };
});

const mockSettings = createMockSettings();

describe('settings routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let logSpies: ReturnType<typeof installMockAppLog>['spies'];
  let restoreLog: () => void;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
    const installed = installMockAppLog(app);
    logSpies = installed.spies;
    restoreLog = installed.restore;
  });

  afterAll(async () => {
    restoreLog();
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    for (const s of Object.values(logSpies)) s.mockClear();
    mockHardcoverSearchSeries.mockReset();
    mockHardcoverClientCtor.mockReset();
    mockFetchWithTimeout.mockReset();
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
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: 'German, Abridged', requiredWords: 'M4B' },
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
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: '', requiredWords: '' },
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

      // F1 — success log emits the resolved + redacted URL, not the sentinel
      it('success log emits the resolved redacted URL, not the sentinel', async () => {
        (services.settings.get as Mock).mockResolvedValue({ proxyUrl: 'http://real:cred@host:9191' });
        (services.healthCheck.probeProxy as Mock).mockResolvedValue('1.2.3.4');

        await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '********' },
        });

        expect(logSpies.info).toHaveBeenCalledWith(
          expect.objectContaining({ ip: '1.2.3.4', proxyUrl: 'http://***:***@host:9191/' }),
          'Proxy test successful',
        );
        const infoCalls = logSpies.info.mock.calls as unknown[][];
        const sentinelLog = infoCalls.find((call) => {
          const meta = call[0] as { proxyUrl?: string };
          return meta?.proxyUrl === '********';
        });
        expect(sentinelLog).toBeUndefined();
      });

      // F1 — failure log emits the resolved + redacted URL, not the sentinel
      it('failure log emits the resolved redacted URL, not the sentinel', async () => {
        (services.settings.get as Mock).mockResolvedValue({ proxyUrl: 'http://real:cred@host:9191' });
        (services.healthCheck.probeProxy as Mock).mockRejectedValue(new Error('ECONNREFUSED'));

        await app.inject({
          method: 'POST',
          url: '/api/settings/test-proxy',
          payload: { proxyUrl: '********' },
        });

        expect(logSpies.warn).toHaveBeenCalledWith(
          expect.objectContaining({ proxyUrl: 'http://***:***@host:9191/' }),
          'Proxy test failed',
        );
        const warnCalls = logSpies.warn.mock.calls as unknown[][];
        const sentinelLog = warnCalls.find((call) => {
          const meta = call[0] as { proxyUrl?: string };
          return meta?.proxyUrl === '********';
        });
        expect(sentinelLog).toBeUndefined();
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

  // F2 (PR #1135 review): live route coverage for the metadata.hardcoverApiKey
  // secret-handling surface. The route layer's job is to mask non-empty values
  // and pass sentinels through to SettingsService unchanged. Encryption and
  // sentinel-preservation are exercised at the service level in
  // settings.service.test.ts and end-to-end by the secret-migration test below.
  describe('metadata.hardcoverApiKey secret surface', () => {
    it('GET /api/settings masks a configured hardcoverApiKey as the sentinel', async () => {
      const settingsWithKey = {
        ...mockSettings,
        metadata: { ...mockSettings.metadata, hardcoverApiKey: 'sk-live-1234' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsWithKey);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.metadata.hardcoverApiKey).toBe('********');
      // Adjacent non-secret metadata fields are NOT masked
      expect(body.metadata.audibleRegion).toBe(mockSettings.metadata.audibleRegion);
      expect(body.metadata.languages).toEqual(mockSettings.metadata.languages);
    });

    it('GET /api/settings preserves an empty hardcoverApiKey verbatim (no phantom sentinel)', async () => {
      const settingsEmptyKey = {
        ...mockSettings,
        metadata: { ...mockSettings.metadata, hardcoverApiKey: '' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsEmptyKey);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.metadata.hardcoverApiKey).toBe('');
    });

    it('PUT /api/settings forwards a fresh plaintext key to SettingsService.update and masks it back in the response', async () => {
      const updated = {
        ...mockSettings,
        metadata: { ...mockSettings.metadata, hardcoverApiKey: 'sk-new-9999' },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { metadata: { hardcoverApiKey: 'sk-new-9999' } },
      });

      expect(res.statusCode).toBe(200);
      // SettingsService receives the PLAINTEXT so it can encrypt downstream
      const updateArg = (services.settings.update as Mock).mock.calls[0]![0] as { metadata?: { hardcoverApiKey?: string } };
      expect(updateArg.metadata?.hardcoverApiKey).toBe('sk-new-9999');
      // Response is masked, never echoes plaintext
      const body = JSON.parse(res.payload);
      expect(body.metadata.hardcoverApiKey).toBe('********');
    });

    it('PUT /api/settings forwards the sentinel through unchanged so SettingsService can preserve the stored ciphertext', async () => {
      const stored = {
        ...mockSettings,
        metadata: { ...mockSettings.metadata, hardcoverApiKey: 'sk-existing-2222' },
      };
      (services.settings.update as Mock).mockResolvedValue(stored);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { metadata: { hardcoverApiKey: '********' } },
      });

      expect(res.statusCode).toBe(200);
      // The route does NOT replace the sentinel — it lets SettingsService.set
      // resolve it against the existing stored value. (The route's network
      // sentinel-normalize block is scoped to the cache-clear comparison, not
      // to the update payload.)
      const updateArg = (services.settings.update as Mock).mock.calls[0]![0] as { metadata?: { hardcoverApiKey?: string } };
      expect(updateArg.metadata?.hardcoverApiKey).toBe('********');
      const body = JSON.parse(res.payload);
      expect(body.metadata.hardcoverApiKey).toBe('********');
    });

    it('PUT /api/settings does NOT change Hardcover Import List apiKey when saving metadata.hardcoverApiKey, and vice versa', async () => {
      const stored = {
        ...mockSettings,
        metadata: { ...mockSettings.metadata, hardcoverApiKey: 'metadata-key' },
      };
      (services.settings.update as Mock).mockResolvedValue(stored);

      await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { metadata: { hardcoverApiKey: 'metadata-key' } },
      });

      // SettingsService.update was called with ONLY metadata, never with an
      // import-list payload — proving the two key fields don't cross-write.
      const updateArg = (services.settings.update as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(updateArg).toHaveProperty('metadata');
      expect(updateArg).not.toHaveProperty('importList');
      expect(updateArg).not.toHaveProperty('importLists');
    });
  });

  describe('POST /api/settings/metadata/hardcover/test', () => {
    it('uses plaintext apiKey from body and does NOT touch settingsService.get', async () => {
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key-1' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: true, message: 'Connected.' });
      expect(services.settings.get).not.toHaveBeenCalled();
    });

    // AC9 — the cheap-query contract: must call searchSeries('test'), not a heavier
    // query (e.g. getSeriesMembers) and not an arbitrary string. A regression to
    // any other query would skip the AC9 contract silently if we only asserted
    // "searchSeries was called".
    it("invokes HardcoverClient.searchSeries with the literal 'test' query", async () => {
      mockHardcoverSearchSeries.mockResolvedValue([]);

      await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key-ac9' },
      });

      expect(mockHardcoverSearchSeries).toHaveBeenCalledTimes(1);
      expect(mockHardcoverSearchSeries).toHaveBeenCalledWith('test');
    });

    it('resolves sentinel against stored key', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: 'stored-key' });
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: '********' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('metadata');
      expect(mockHardcoverClientCtor).toHaveBeenCalledWith('stored-key');
    });

    it('empty-string apiKey falls back to stored key', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: 'stored-key' });
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: '' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('metadata');
    });

    it('whitespace-only apiKey falls back to stored key', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: 'stored-key' });
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: '   ' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('metadata');
    });

    it('omitted apiKey with no stored key returns 400', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: '' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: 'No Hardcover API key configured.' });
      expect(mockHardcoverSearchSeries).not.toHaveBeenCalled();
    });

    it('omitted apiKey with whitespace-only stored key returns 400', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: '   ' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: 'No Hardcover API key configured.' });
    });

    it('sentinel apiKey with no stored key returns 400', async () => {
      (services.settings.get as Mock).mockResolvedValue({ hardcoverApiKey: '' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: '********' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: 'No Hardcover API key configured.' });
    });

    it('RateLimitError maps to rate-limit message', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(new RateLimitError(5000, 'hardcover'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        success: false,
        message: 'Hardcover is rate-limiting requests. Try again in 5s.',
      });
    });

    // #1138 Bug 2: HTTP 401/403 from `mapHttpError` and GraphQL-envelope auth
    // failures (Hardcover often returns HTTP 200 with the error in the body)
    // both map to a single friendly Bearer-prefix hint.
    const INVALID_KEY_HINT =
      'Invalid Hardcover API key. (If you copied from the Hardcover docs, drop the "Bearer " prefix.)';

    it('MetadataError with 401 message maps to the Bearer-hint text', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover API returned 401: Unauthorized'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: INVALID_KEY_HINT });
    });

    it('MetadataError with 403 message maps to the Bearer-hint text', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover API returned 403: Forbidden'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: INVALID_KEY_HINT });
    });

    it('MetadataError with "Malformed Authorization header" maps to the Bearer-hint text', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover search error: Malformed Authorization header'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: INVALID_KEY_HINT });
    });

    it('MetadataError with "Could not verify JWT" maps to the Bearer-hint text', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover search error: Could not verify JWT: signature mismatch'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: INVALID_KEY_HINT });
    });

    it('MetadataError with an unrecognized message falls through to error.message', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover search error: some unrecognized failure'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        success: false,
        message: 'Hardcover search error: some unrecognized failure',
      });
    });

    // #1138 Bug 3: the route hands the raw body value to HardcoverClient — the
    // constructor (verified in hardcover.test.ts) does the trim/Bearer strip.
    // We assert the route's responsibility here: do not pre-process the key.
    it('whitespace-wrapped apiKey reaches HardcoverClient untouched and succeeds', async () => {
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: '  eyJValidKey  \n' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true, message: 'Connected.' });
      expect(mockHardcoverClientCtor).toHaveBeenCalledWith('  eyJValidKey  \n');
    });

    it('Bearer-prefixed apiKey reaches HardcoverClient untouched and succeeds', async () => {
      mockHardcoverSearchSeries.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'Bearer eyJValidKey' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true, message: 'Connected.' });
      expect(mockHardcoverClientCtor).toHaveBeenCalledWith('Bearer eyJValidKey');
    });

    it('TransientError maps to network message', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(new TransientError('hardcover', 'network'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        success: false,
        message: "Couldn't reach Hardcover. Check your network and try again.",
      });
    });

    it('other MetadataError surfaces error.message verbatim', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(new MetadataError('hardcover', 'Schema mismatch'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ success: false, message: 'Schema mismatch' });
    });

    it('route success log does not contain the plaintext apiKey', async () => {
      mockHardcoverSearchSeries.mockResolvedValue([]);

      await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'super-secret-plaintext-1234' },
      });

      const routeLogCalls = logSpies.info.mock.calls.filter(
        (call) => call[call.length - 1] === 'Hardcover API key test successful',
      );
      expect(routeLogCalls.length).toBeGreaterThan(0);
      for (const call of routeLogCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain('super-secret-plaintext-1234');
      }
    });

    it('route failure log does not contain the plaintext apiKey', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(
        new MetadataError('hardcover', 'Hardcover API returned 401: Unauthorized'),
      );

      await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'super-secret-plaintext-9999' },
      });

      const routeLogCalls = logSpies.warn.mock.calls.filter(
        (call) => call[call.length - 1] === 'Hardcover API key test failed',
      );
      expect(routeLogCalls.length).toBeGreaterThan(0);
      for (const call of routeLogCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain('super-secret-plaintext-9999');
      }
    });
  });

  // #1526 — earwitness settings secret surface + Test-Connection probe.
  describe('earwitness.apiKey secret surface', () => {
    it('GET /api/settings masks a configured earwitness.apiKey but returns baseUrl in plaintext', async () => {
      const settingsWithKey = {
        ...mockSettings,
        earwitness: { enabled: true, baseUrl: 'https://earwitness.example.com', apiKey: 'sk-live-1234' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsWithKey);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.earwitness.apiKey).toBe('********');
      // baseUrl is NOT a secret — returned in plaintext
      expect(body.earwitness.baseUrl).toBe('https://earwitness.example.com');
      expect(body.earwitness.enabled).toBe(true);
    });

    it('GET /api/settings preserves an empty earwitness.apiKey verbatim (no phantom sentinel)', async () => {
      const settingsEmptyKey = {
        ...mockSettings,
        earwitness: { enabled: false, baseUrl: '', apiKey: '' },
      };
      (services.settings.getAll as Mock).mockResolvedValue(settingsEmptyKey);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).earwitness.apiKey).toBe('');
    });

    it('PUT /api/settings forwards the sentinel through unchanged so SettingsService preserves the stored ciphertext', async () => {
      const stored = {
        ...mockSettings,
        earwitness: { enabled: true, baseUrl: 'https://host', apiKey: 'sk-existing' },
      };
      (services.settings.update as Mock).mockResolvedValue(stored);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } },
      });

      expect(res.statusCode).toBe(200);
      const updateArg = (services.settings.update as Mock).mock.calls[0]![0] as { earwitness?: { apiKey?: string } };
      expect(updateArg.earwitness?.apiKey).toBe('********');
      expect(JSON.parse(res.payload).earwitness.apiKey).toBe('********');
    });
  });

  describe('POST /api/settings/earwitness/test', () => {
    const REACHABLE = 'https://earwitness.example.com';

    it('returns { success: true } on a 2xx probe and sends the X-Api-Key header to <baseUrl>/api/v1/health', async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 200 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${REACHABLE}/api/v1/health`,
        { headers: { 'X-Api-Key': 'plain-key' } },
        5000,
      );
    });

    it('joins the health path onto a pathful baseUrl, preserving the prefix', async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 204 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: 'https://host/earwitness/', apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        'https://host/earwitness/api/v1/health',
        { headers: { 'X-Api-Key': 'plain-key' } },
        5000,
      );
    });

    it('maps 401 to { success: false, message: "Invalid API key" } in a 200 envelope', async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 401 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'bad-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'Invalid API key' });
    });

    it('maps 403 to { success: false, message: "Invalid API key" }', async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 403 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'bad-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'Invalid API key' });
    });

    it('maps another HTTP status (500) to { success: false, message: "Unable to reach server" }', async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 500 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'Unable to reach server' });
    });

    it('maps a rejected probe (network/DNS/timeout/abort) to { success: false, message: "Unable to reach server" }', async () => {
      mockFetchWithTimeout.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'Unable to reach server' });
    });

    it('resolves a sentinel apiKey against the stored decrypted value before probing', async () => {
      (services.settings.get as Mock).mockResolvedValue({ enabled: true, baseUrl: REACHABLE, apiKey: 'stored-key' });
      mockFetchWithTimeout.mockResolvedValue({ status: 200 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: '********' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('earwitness');
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${REACHABLE}/api/v1/health`,
        { headers: { 'X-Api-Key': 'stored-key' } },
        5000,
      );
    });

    it('falls back to the stored key when apiKey is omitted', async () => {
      (services.settings.get as Mock).mockResolvedValue({ enabled: true, baseUrl: REACHABLE, apiKey: 'stored-key' });
      mockFetchWithTimeout.mockResolvedValue({ status: 200 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('earwitness');
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${REACHABLE}/api/v1/health`,
        { headers: { 'X-Api-Key': 'stored-key' } },
        5000,
      );
    });

    it('returns 400 when a sentinel apiKey is sent but no key is stored', async () => {
      (services.settings.get as Mock).mockResolvedValue({ enabled: false, baseUrl: '', apiKey: '' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: '********' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'No earwitness API key configured.' });
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('rejects a request with a missing baseUrl (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(400);
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    // baseUrl is not a secret, so the masked sentinel is not a valid URL — the
    // route rejects it at schema validation rather than resolving it.
    it('rejects a sentinel baseUrl as an invalid URL (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: '********', apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(400);
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('rejects a non-http(s) baseUrl scheme (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: 'ftp://host', apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(400);
      expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it("does not leak the resolved apiKey into the route's success log", async () => {
      mockFetchWithTimeout.mockResolvedValue({ status: 200 });

      await app.inject({
        method: 'POST',
        url: '/api/settings/earwitness/test',
        payload: { baseUrl: REACHABLE, apiKey: 'super-secret-ew-1234' },
      });

      // Scope to the route's own log line — Fastify's framework-level "incoming
      // request" log serializes the raw body (shared behavior with the Hardcover
      // test handler) and is out of scope for this route's secret-handling.
      const routeLogCalls = logSpies.info.mock.calls.filter(
        (call) => call[call.length - 1] === 'earwitness connection test successful',
      );
      expect(routeLogCalls.length).toBeGreaterThan(0);
      for (const call of routeLogCalls) {
        expect(JSON.stringify(call)).not.toContain('super-secret-ew-1234');
      }
    });
  });
});

