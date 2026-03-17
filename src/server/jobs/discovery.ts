import type { FastifyBaseLogger } from 'fastify';
import type { DiscoveryService, SettingsService } from '../services/index.js';

export async function runDiscoveryJob(
  discoveryService: DiscoveryService,
  settingsService: SettingsService,
  log: FastifyBaseLogger,
): Promise<void> {
  const settings = await settingsService.get('discovery');
  if (!settings.enabled) {
    log.debug('Discovery job skipped — disabled in settings');
    return;
  }

  log.info('Discovery refresh starting');
  try {
    const result = await discoveryService.refreshSuggestions();
    log.info(
      { added: result.added, removed: result.removed },
      'Discovery refresh complete',
    );
    for (const warning of result.warnings) {
      log.warn({ warning }, 'Discovery refresh warning');
    }
  } catch (error) {
    log.error(error, 'Discovery refresh failed');
  }
}
