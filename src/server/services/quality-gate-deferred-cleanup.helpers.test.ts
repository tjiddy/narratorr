import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { cleanupDeferredRejections, type DeferredCleanupDeps } from './quality-gate-deferred-cleanup.helpers.js';
import type { QualityGateService } from './quality-gate.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { Db } from '../../db/index.js';
import { inject, createMockDb, createMockLogger, createMockSettingsService } from '../__tests__/helpers.js';

function createDeps(overrides?: {
  settingsService?: SettingsService | undefined;
  qualityGateService?: Partial<QualityGateService>;
  downloadClientService?: Partial<DownloadClientService>;
}): DeferredCleanupDeps & { log: FastifyBaseLogger } {
  const log = createMockLogger();
  const db = createMockDb();
  const qualityGateService = inject<QualityGateService>({
    getDeferredCleanupCandidates: vi.fn().mockResolvedValue([]),
    ...overrides?.qualityGateService,
  });
  const downloadClientService = inject<DownloadClientService>({
    getAdapter: vi.fn().mockResolvedValue(null),
    ...overrides?.downloadClientService,
  });
  const settingsService = overrides?.settingsService === undefined
    ? createMockSettingsService()
    : overrides.settingsService;
  return {
    qualityGateService,
    downloadClientService,
    settingsService,
    db: inject<Db>(db),
    log: inject<FastifyBaseLogger>(log),
  };
}

describe('cleanupDeferredRejections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns and returns early without fetching candidates when settings.get rejects', async () => {
    const settingsError = new Error('settings db unavailable');
    const settingsService = inject<SettingsService>({
      get: vi.fn().mockRejectedValue(settingsError),
      getAll: vi.fn(),
      set: vi.fn(),
      patch: vi.fn(),
      update: vi.fn(),
    });
    const getDeferredCleanupCandidates = vi.fn();

    const deps = createDeps({
      settingsService,
      qualityGateService: { getDeferredCleanupCandidates },
    });

    await expect(cleanupDeferredRejections(deps)).resolves.toBeUndefined();

    expect(getDeferredCleanupCandidates).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.any(String),
          type: 'Error',
        }),
      }),
      expect.stringMatching(/failed to read import settings/),
    );
  });

  it('proceeds to fetch candidates when settings.get resolves', async () => {
    const getDeferredCleanupCandidates = vi.fn().mockResolvedValue([]);

    const deps = createDeps({
      qualityGateService: { getDeferredCleanupCandidates },
    });

    await expect(cleanupDeferredRejections(deps)).resolves.toBeUndefined();

    expect(getDeferredCleanupCandidates).toHaveBeenCalledTimes(1);
    // No settings-failure warning was logged on the success path
    const warnCalls = vi.mocked(deps.log.warn).mock.calls;
    const settingsFailureLog = warnCalls.find(c => {
      const msg = c[1];
      return typeof msg === 'string' && /failed to read import settings/.test(msg);
    });
    expect(settingsFailureLog).toBeUndefined();
  });
});
