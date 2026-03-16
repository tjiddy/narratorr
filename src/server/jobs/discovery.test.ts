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

  it('handles refresh errors without crashing', async () => {
    const settingsService = createMockSettingsService({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } });
    const log = createMockLogger();
    mockDiscoveryService.refreshSuggestions.mockRejectedValueOnce(new Error('Provider down'));

    // Should not throw
    await runDiscoveryJob(inject(mockDiscoveryService), inject(settingsService), inject<FastifyBaseLogger>(log));
    expect(log.error).toHaveBeenCalled();
  });
});
