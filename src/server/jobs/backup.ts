import type { FastifyBaseLogger } from 'fastify';
import type { BackupService } from '../services/backup.service.js';
import type { SettingsService } from '../services/index.js';
import { serializeError } from '../utils/serialize-error.js';


export async function runBackupJob(
  backupService: BackupService,
  log: FastifyBaseLogger,
): Promise<{ created: boolean; pruned: number }> {
  try {
    await backupService.create();
    const pruned = await backupService.prune();
    return { created: true, pruned };
  } catch (error: unknown) {
    log.error({ error: serializeError(error) }, 'Backup job failed');
    return { created: false, pruned: 0 };
  }
}

export function startBackupJob(
  settingsService: SettingsService,
  backupService: BackupService,
  log: FastifyBaseLogger,
): void {
  async function scheduleNext() {
    try {
      const systemSettings = await settingsService.get('system');
      const intervalMs = systemSettings.backupIntervalMinutes * 60 * 1000;

      setTimeout(async () => {
        try {
          await runBackupJob(backupService, log);
        } catch (error: unknown) {
          log.error({ error: serializeError(error) }, 'Backup job error');
        }
        scheduleNext();
      }, intervalMs);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, 'Failed to read backup interval, retrying in 5 minutes');
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
  log.info('Backup job scheduler started');
}
