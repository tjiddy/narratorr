import type { FastifyBaseLogger } from 'fastify';
import type { BackupService } from '../services/backup.service.js';
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
