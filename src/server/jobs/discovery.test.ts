import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import { runDiscoveryJob } from './discovery.js';

const mockDiscoveryService = {
  refreshSuggestions: vi.fn().mockResolvedValue({ added: 0, removed: 0, warnings: [] }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDiscoveryService.refreshSuggestions.mockResolvedValue({ added: 0, removed: 0, warnings: [] });
});

describe('Discovery Job', () => {
  it('calls refreshSuggestions when discovery.enabled is true', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();

    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));
    expect(mockDiscoveryService.refreshSuggestions).toHaveBeenCalled();
  });

  it('skips execution when discovery.enabled is false', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();

    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));
    expect(mockDiscoveryService.refreshSuggestions).not.toHaveBeenCalled();
  });

  // --- #408: Warning logging ---

  it('logs warnings from refresh result when non-empty', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();
    mockDiscoveryService.refreshSuggestions.mockResolvedValueOnce({
      added: 1, removed: 0, warnings: ['Expiry step failed — continuing with candidate generation'],
    });

    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ warning: expect.stringContaining('Expiry') }),
      expect.any(String),
    );
  });

  it('does not log warnings when array is empty', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();
    mockDiscoveryService.refreshSuggestions.mockResolvedValueOnce({ added: 0, removed: 0, warnings: [] });

    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('handles refresh errors without crashing', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();
    mockDiscoveryService.refreshSuggestions.mockRejectedValueOnce(new Error('Provider down'));

    // Should not throw
    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'Provider down', type: 'Error' }) }),
      'Discovery refresh failed',
    );
  });
});
