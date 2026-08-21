import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import { DEFAULT_SETTINGS } from '@shared/schemas/settings/registry.js';
import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import type * as HardcoverModule from '@core/metadata/hardcover.js';
import type { Services } from './index.js';
import { SECRET_CATEGORIES } from '../utils/secret-category-map.js';
import { getSecretFieldNames, SentinelOnNonSecretFieldError } from '../utils/secret-codec.js';
import { LibraryRootBusyError } from '../services/library-root-gate.js';
import { apiErrorResponseSchema } from '@shared/schemas.js';

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

const { mockResolveFfmpegPath, mockProbeFfmpeg, mockResolveMutagenDetection, mockProbeMutagen } = vi.hoisted(() => ({
  mockResolveFfmpegPath: vi.fn(),
  mockProbeFfmpeg: vi.fn(),
  mockResolveMutagenDetection: vi.fn(),
  mockProbeMutagen: vi.fn(),
}));

vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/audio-processor.js')>();
  return { ...actual, resolveFfmpegPath: mockResolveFfmpegPath, probeFfmpeg: mockProbeFfmpeg };
});

vi.mock('@core/utils/mutagen-resolver.js', () => ({
  resolveMutagenDetection: mockResolveMutagenDetection,
  probeMutagen: mockProbeMutagen,
}));

vi.mock('@core/utils/network-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/network-service.js')>();
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

vi.mock('@core/metadata/hardcover.js', async (importOriginal) => {
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
    // PUT snapshots library and companionEpub before writing, so the default mock must satisfy that read.
    (services.settings.get as Mock).mockImplementation((cat: string) =>
      Promise.resolve(mockSettings[cat as keyof typeof mockSettings]));
    for (const s of Object.values(logSpies)) s.mockClear();
    mockHardcoverSearchSeries.mockReset();
    mockHardcoverClientCtor.mockReset();
    mockFetchWithTimeout.mockReset();
    mockResolveFfmpegPath.mockReset();
    mockProbeFfmpeg.mockReset();
    mockResolveMutagenDetection.mockReset();
    mockProbeMutagen.mockReset();
  });

  describe('GET /api/settings/ffmpeg-status', () => {
    it('returns {detected:false} when ffmpeg cannot be resolved', async () => {
      mockResolveFfmpegPath.mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/settings/ffmpeg-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: false });
      expect(mockProbeFfmpeg).not.toHaveBeenCalled();
    });

    it('returns {detected, version, path} when ffmpeg resolves and probes', async () => {
      mockResolveFfmpegPath.mockResolvedValue('/usr/bin/ffmpeg');
      mockProbeFfmpeg.mockResolvedValue('8.0.1');
      const res = await app.inject({ method: 'GET', url: '/api/settings/ffmpeg-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
      expect(mockProbeFfmpeg).toHaveBeenCalledWith('/usr/bin/ffmpeg');
    });

    it('returns {detected:false} (not a 500) when ffmpeg resolves but the probe throws', async () => {
      mockResolveFfmpegPath.mockResolvedValue('/usr/bin/ffmpeg');
      mockProbeFfmpeg.mockRejectedValue(new Error('broken binary'));
      const res = await app.inject({ method: 'GET', url: '/api/settings/ffmpeg-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: false });
    });
  });

  // Mirrors the ffmpeg-status contract; this is what D8's client gate reads (#2210 D5).
  describe('GET /api/settings/mutagen-status', () => {
    it('returns {detected:false} when no mutagen-capable interpreter resolves', async () => {
      mockResolveMutagenDetection.mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/settings/mutagen-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: false });
      expect(mockProbeMutagen).not.toHaveBeenCalled();
    });

    it('returns {detected, version, path} with the resolved interpreter as path', async () => {
      mockResolveMutagenDetection.mockResolvedValue({
        python: '/usr/bin/python3', version: '1.47.0', override: undefined, overrideSuperseded: false,
      });
      mockProbeMutagen.mockResolvedValue('1.47.0');
      const res = await app.inject({ method: 'GET', url: '/api/settings/mutagen-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });
      expect(mockProbeMutagen).toHaveBeenCalledWith('/usr/bin/python3');
    });

    it('returns {detected:false} (not a 500) when detection succeeded but the probe throws', async () => {
      mockResolveMutagenDetection.mockResolvedValue({
        python: '/usr/bin/python3', version: '1.47.0', override: undefined, overrideSuperseded: false,
      });
      mockProbeMutagen.mockRejectedValue(new Error('interpreter vanished'));
      const res = await app.inject({ method: 'GET', url: '/api/settings/mutagen-status' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ detected: false });
    });
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

    // Derive cases from the canonical map so new encrypt-on-write fields cannot escape this test.
    it('masks every encrypt-on-write secret field, never echoing plaintext', async () => {
      const plaintext = (cat: string, field: string) => `PLAIN-${cat}-${field}`;
      const withSecrets = structuredClone(mockSettings) as Record<string, Record<string, unknown>>;
      for (const [category, entity] of Object.entries(SECRET_CATEGORIES)) {
        if (!entity) continue;
        for (const field of getSecretFieldNames(entity)) {
          withSecrets[category] = { ...withSecrets[category], [field]: plaintext(category, field) };
        }
      }
      (services.settings.getAll as Mock).mockResolvedValue(withSecrets);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as Record<string, Record<string, unknown>>;
      expect(res.payload).not.toContain('PLAIN-');
      for (const [category, entity] of Object.entries(SECRET_CATEGORIES)) {
        if (!entity) continue;
        for (const field of getSecretFieldNames(entity)) {
          expect(body[category]![field]).toBe('********');
        }
      }
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

    /**
     * #2369 AC15 case 24. `LibraryRootBusyError` reaches the client only if it is in
     * `ERROR_REGISTRY`; an unregistered error falls through to the generic 500 arm with its message
     * stripped, so the operator would be told "Internal server error" for a retryable conflict.
     */
    describe('root-scope refusal (#2369 AC15)', () => {
      it('maps LibraryRootBusyError to 409 with the error message intact', async () => {
        (services.settings.update as Mock).mockRejectedValue(new LibraryRootBusyError(2));

        const res = await app.inject({
          method: 'PUT',
          url: '/api/settings',
          payload: { library: { path: '/new', folderFormat: '{title}' } },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.payload);
        // Round-trips the registered `{ error }` response schema, not a generic 500 body.
        expect(apiErrorResponseSchema.safeParse(body).success).toBe(true);
        expect(body.error).toContain('2 import, merge or rename');
        expect(body.error).not.toBe('Internal server error');
      });

      it('leaves a non-library category update unaffected by the root gate', async () => {
        (services.settings.update as Mock).mockResolvedValue(mockSettings);

        const res = await app.inject({
          method: 'PUT',
          url: '/api/settings',
          payload: { search: { enabled: false } },
        });

        expect(res.statusCode).toBe(200);
      });
    });
  });

  describe('PUT /api/settings — companion-ebook sweep (#1960 AC25–AC25d)', () => {
    const ROOT_BEFORE = '/audiobooks';
    const ROOT_AFTER = '/media/audiobooks';

    function primePersisted(opts: { root?: string; enabled?: boolean } = {}) {
      const before = {
        ...mockSettings,
        library: { ...mockSettings.library, path: opts.root ?? ROOT_BEFORE },
        companionEpub: { enabled: opts.enabled ?? false },
      };
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(before[cat as keyof typeof before]));
      return before;
    }

    function primeUpdated(opts: { root?: string; enabled?: boolean } = {}) {
      (services.settings.update as Mock).mockResolvedValue({
        ...mockSettings,
        library: { ...mockSettings.library, path: opts.root ?? ROOT_BEFORE },
        companionEpub: { enabled: opts.enabled ?? false },
      });
    }

    beforeEach(() => {
      (services.companionEbook.reconcileAll as Mock).mockResolvedValue(undefined);
    });

    it('enable arm alone (false → true) fires exactly one sweep', async () => {
      primePersisted({ enabled: false });
      primeUpdated({ enabled: true });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { companionEpub: { enabled: true } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(services.companionEbook.reconcileBook).not.toHaveBeenCalled();
    });

    it('root arm alone (changed library.path) fires exactly one sweep', async () => {
      primePersisted({ root: ROOT_BEFORE });
      primeUpdated({ root: ROOT_AFTER });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { library: { path: ROOT_AFTER } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('BOTH arms in one request fire exactly ONE sweep, not two', async () => {
      primePersisted({ root: ROOT_BEFORE, enabled: false });
      primeUpdated({ root: ROOT_AFTER, enabled: true });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, companionEpub: { enabled: true } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('DISABLE plus a changed root still fires exactly one sweep', async () => {
      primePersisted({ root: ROOT_BEFORE, enabled: true });
      primeUpdated({ root: ROOT_AFTER, enabled: false });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, companionEpub: { enabled: false } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['true → true', true, true],
      ['true → false', true, false],
      ['false → false', false, false],
    ] as const)('the enable arm does NOT fire on %s with an unchanged root', async (_label, before, after) => {
      primePersisted({ enabled: before });
      primeUpdated({ enabled: after });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { companionEpub: { enabled: after } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('a root resubmitted UNCHANGED fires no sweep', async () => {
      primePersisted({ root: ROOT_BEFORE });
      primeUpdated({ root: ROOT_BEFORE });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { library: { path: ROOT_BEFORE } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('neither category in the payload fires no sweep — and reads neither back', async () => {
      primePersisted();
      primeUpdated();

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { search: { enabled: false } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
      expect(services.settings.get).not.toHaveBeenCalledWith('library');
      expect(services.settings.get).not.toHaveBeenCalledWith('companionEpub');
    });

    // Partial category patches merge, so omitting enabled preserves the stored value.
    it('a companionEpub payload with no `enabled` key does not fire', async () => {
      primePersisted({ enabled: false });
      primeUpdated({ enabled: false });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { companionEpub: {} },
      });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('a persisted root change followed by a LATER category failure still sweeps, and the original error propagates', async () => {
      // A distinct 400 failure keeps a leaked recovery-read 500 observable.
      const failure = new SentinelOnNonSecretFieldError('processing.bitrate');
      let phase: 'before' | 'after' = 'before';
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(cat === 'library'
          ? { ...mockSettings.library, path: phase === 'after' ? ROOT_AFTER : ROOT_BEFORE }
          : mockSettings[cat as keyof typeof mockSettings]));
      (services.settings.update as Mock).mockImplementation(() => { phase = 'after'; return Promise.reject(failure); });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, processing: { bitrate: 64 } },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe(failure.message);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('a persisted companionEpub enable followed by a LATER category failure still sweeps, and the original error propagates', async () => {
      const failure = new SentinelOnNonSecretFieldError('processing.bitrate');
      let updateCalled = false;
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'companionEpub') return Promise.resolve({ enabled: updateCalled });
        return Promise.resolve(mockSettings[cat as keyof typeof mockSettings]);
      });
      (services.settings.update as Mock).mockImplementation(() => {
        updateCalled = true;
        return Promise.reject(failure);
      });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { companionEpub: { enabled: true }, processing: { bitrate: 64 } },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe(failure.message);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('library re-read SUCCEEDS (changed) while companionEpub re-read THROWS → exactly one call, original error propagates', async () => {
      primePersisted({ root: ROOT_BEFORE, enabled: false });
      const failure = new SentinelOnNonSecretFieldError('processing.bitrate');
      let phase: 'before' | 'after' = 'before';
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (phase === 'after' && cat === 'companionEpub') return Promise.reject(new Error('companionEpub re-read failed'));
        if (phase === 'after' && cat === 'library') return Promise.resolve({ ...mockSettings.library, path: ROOT_AFTER });
        if (cat === 'companionEpub') return Promise.resolve({ enabled: false });
        return Promise.resolve({ ...mockSettings.library, path: ROOT_BEFORE });
      });
      (services.settings.update as Mock).mockImplementation(() => { phase = 'after'; return Promise.reject(failure); });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, companionEpub: { enabled: true } },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe(failure.message);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('the mirror — companionEpub re-read SUCCEEDS (false→true) while library re-read THROWS → exactly one call, original error propagates', async () => {
      const failure = new SentinelOnNonSecretFieldError('processing.bitrate');
      let phase: 'before' | 'after' = 'before';
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (phase === 'after' && cat === 'library') return Promise.reject(new Error('library re-read failed'));
        if (phase === 'after' && cat === 'companionEpub') return Promise.resolve({ enabled: true });
        if (cat === 'companionEpub') return Promise.resolve({ enabled: false });
        return Promise.resolve({ ...mockSettings.library, path: ROOT_BEFORE });
      });
      (services.settings.update as Mock).mockImplementation(() => { phase = 'after'; return Promise.reject(failure); });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, companionEpub: { enabled: true } },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe(failure.message);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('masking guard: BOTH re-reads throw → the ORIGINAL settings error still propagates, both are warned, and exactly one sweep fires', async () => {
      const failure = new SentinelOnNonSecretFieldError('processing.bitrate');
      let phase: 'before' | 'after' = 'before';
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (phase === 'after') return Promise.reject(new Error(`${cat} re-read failed`));
        if (cat === 'companionEpub') return Promise.resolve({ enabled: false });
        return Promise.resolve({ ...mockSettings.library, path: ROOT_BEFORE });
      });
      (services.settings.update as Mock).mockImplementation(() => { phase = 'after'; return Promise.reject(failure); });

      const res = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { library: { path: ROOT_AFTER }, companionEpub: { enabled: true } },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe(failure.message);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        expect.stringContaining('Could not re-read library settings'),
      );
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        expect.stringContaining('Could not re-read companion-ebook settings'),
      );
    });

    it('a PRE-update snapshot read failure fails the request before anything is persisted', async () => {
      (services.settings.get as Mock).mockRejectedValue(new Error('snapshot read failed'));

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { library: { path: ROOT_AFTER } },
      });

      expect(res.statusCode).toBe(500);
      expect(services.settings.update).not.toHaveBeenCalled();
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('a rejecting sweep does not change the 200 the route already returned', async () => {
      primePersisted({ root: ROOT_BEFORE });
      primeUpdated({ root: ROOT_AFTER });
      (services.companionEbook.reconcileAll as Mock).mockRejectedValue(new Error('sweep rejected'));

      const res = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { library: { path: ROOT_AFTER } },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('PUT /api/settings (processing)', () => {
    it('saves the processing engine subset and forwards the exact payload to the service', async () => {
      const updated = {
        ...mockSettings,
        processing: { ...mockSettings.processing, outputFormat: 'mp3', bitrate: 256, maxConcurrentProcessing: 4 },
      };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { outputFormat: 'mp3', bitrate: 256, maxConcurrentProcessing: 4 } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.update).toHaveBeenCalledWith({
        processing: { outputFormat: 'mp3', bitrate: 256, maxConcurrentProcessing: 4 },
      });
      expect(JSON.parse(res.payload).processing.bitrate).toBe(256);
    });

    it('strips the removed ffmpegPath field before it reaches the service', async () => {
      (services.settings.update as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { bitrate: 192, ffmpegPath: '/usr/bin/ffmpeg' } },
      });

      expect(res.statusCode).toBe(200);
      const payload = (services.settings.update as Mock).mock.calls[0]![0];
      expect(payload.processing).not.toHaveProperty('ffmpegPath');
      expect(payload.processing.bitrate).toBe(192);
    });

    // Default-strip accepts stale clients without persisting the removed mergeBehavior knob.
    it('strips the removed mergeBehavior field before it reaches the service', async () => {
      (services.settings.update as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { processing: { outputFormat: 'mp3', mergeBehavior: 'always' } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.settings.update).toHaveBeenCalledWith({ processing: { outputFormat: 'mp3' } });
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

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { network: { proxyUrl: '********' } },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.clearAdapterCache).not.toHaveBeenCalled();
    });
  });

  // Route tests own masking and passthrough; service tests own encryption and sentinel preservation.
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
      const updateArg = (services.settings.update as Mock).mock.calls[0]![0] as { metadata?: { hardcoverApiKey?: string } };
      expect(updateArg.metadata?.hardcoverApiKey).toBe('sk-new-9999');
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
      // Network sentinel normalization is only for cache comparison, not this update payload.
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

    // The literal cheap query guards against replacing searchSeries with a heavier probe.
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

    // HTTP and HTTP-200 GraphQL auth failures share the same Bearer-prefix hint.
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

    // An under-scoped token is correctly typed, so re-pasting the key would not fix it (#2537 AC5).
    it('MetadataError with an insufficient_scope 403 maps to scope guidance, not the Bearer hint', async () => {
      mockHardcoverSearchSeries.mockRejectedValue(new MetadataError(
        'hardcover',
        'Hardcover API returned 403: Forbidden (error: insufficient_scope; scope: read:series)',
      ));

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/metadata/hardcover/test',
        payload: { apiKey: 'plain-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { success: boolean; message: string };
      expect(body.success).toBe(false);
      expect(body.message).toContain('read:series');
      expect(body.message).not.toBe(INVALID_KEY_HINT);
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

    // The route passes raw keys; HardcoverClient owns trimming and Bearer-prefix removal.
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
});

