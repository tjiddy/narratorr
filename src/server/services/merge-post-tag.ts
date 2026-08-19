import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { SettingsService } from './settings.service.js';
import type { ConnectorService } from './connector.service.js';
import type { TaggingService } from './tagging.service.js';
import { enqueueRetagRefresh } from '../utils/enqueue-book-refresh.js';
import { serializeError } from '../utils/serialize-error.js';

export interface MergePostTagDeps {
  db: Db;
  settingsService: SettingsService;
  log: FastifyBaseLogger;
  taggingService?: TaggingService | undefined;
  connectorService?: ConnectorService | undefined;
}

/**
 * Retag only after merge commit because retagBook resolves book.path. The entire step is nonfatal:
 * a committed merge must never become merge_failed. No overrides preserves canonical projection.
 */
export async function retagMergedOutput(
  deps: MergePostTagDeps,
  bookId: number,
  outputPath: string,
): Promise<string[]> {
  try {
    const taggingSettings = await deps.settingsService.get('tagging');
    // retagBook is also a manual action, so the automatic enabled gate belongs here.
    if (!taggingSettings?.enabled) return [];
    if (!deps.taggingService) {
      deps.log.warn({ bookId }, 'Tag embedding is enabled but no tagging service is wired — merged output keeps only its preserved source tags');
      return [];
    }

    // Merge holds the admission lock across this step, so the inner form is required.
    const result = await deps.taggingService.retagBookWithinAdmissionLock(bookId);
    if (result.failed > 0) {
      deps.log.warn({ bookId, failed: result.failed }, 'Post-merge tag write reported failures — merge still succeeded');
    }
    enqueueRetagRefresh(deps.connectorService, deps.log, result);
    if (result.tagged > 0) {
      // Atomic retagging invalidates commitMerge's size measurement; refresh only when rewritten.
      const fileStats = await stat(outputPath);
      await deps.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));
    }
    return result.warnings;
  } catch (error: unknown) {
    deps.log.warn({ bookId, error: serializeError(error) }, 'Post-merge tag step failed — merge succeeded on disk, but the output carries only its preserved source tags');
    return [];
  }
}
