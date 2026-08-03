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

/**
 * Collaborators the post-merge tag step needs. Split out of `MergeService` to keep that file
 * under the max-lines cap, mirroring the `ffmpeg-resolver.ts` extraction in `audio-processor.ts`.
 */
export interface MergePostTagDeps {
  db: Db;
  settingsService: SettingsService;
  log: FastifyBaseLogger;
  taggingService?: TaggingService | undefined;
  connectorService?: ConnectorService | undefined;
}

/**
 * Layer 2 of #2078: re-tag a committed merge output when Tag Embedding is enabled, and return
 * the tag-step warnings for the operator-visible completion message.
 *
 * Must run AFTER the merge commit — `retagBook` resolves the directory from `book.path` itself,
 * which holds the un-merged source parts until the commit lands (and the staging dir never
 * receives `cover.jpg`, so it is not a candidate at all).
 *
 * Wholly NONFATAL: the merge already succeeded on disk, so nothing here may turn it into a
 * failure. EVERY await lives under the try — the tagging-settings read included — because a
 * throw escaping this helper reaches `executeMerge`'s outer catch, which emits `merge_failed`
 * for a merge whose originals are already deleted. A rejection (including `RetagError`), a
 * rejecting settings read, a returned `failed > 0`, and an unwired `taggingService` all log a
 * warning and return.
 *
 * `retagBook(bookId)` is called with NO overrides on purpose. It re-resolves the tagging
 * settings, the ffmpeg path, and the canonical hydrated-book → tag projection itself — the same
 * call the bulk re-tag job and the fix-match route make — which is what keeps merge-time tagging
 * from introducing a third author/narrator serialization policy.
 */
export async function retagMergedOutput(
  deps: MergePostTagDeps,
  bookId: number,
  outputPath: string,
): Promise<string[]> {
  try {
    // The settings read lives INSIDE the nonfatal boundary. It runs after `commitMerge`, so a
    // transient rejection here would otherwise reach `executeMerge`'s outer catch and report an
    // already-committed merge — originals deleted, output in place — as `merge_failed`.
    const taggingSettings = await deps.settingsService.get('tagging');
    // `retagBook` is the manual-action entry point and has no `enabled` gate of its own, so the
    // Tag Embedding gate lives here.
    if (!taggingSettings?.enabled) return [];
    if (!deps.taggingService) {
      deps.log.warn({ bookId }, 'Tag embedding is enabled but no tagging service is wired — merged output keeps only its preserved source tags');
      return [];
    }

    const result = await deps.taggingService.retagBook(bookId);
    if (result.failed > 0) {
      deps.log.warn({ bookId, failed: result.failed }, 'Post-merge tag write reported failures — merge still succeeded');
    }
    // The same `tagged > 0` gate the standalone and bulk re-tag callers use.
    enqueueRetagRefresh(deps.connectorService, deps.log, result);
    if (result.tagged > 0) {
      // `tagFile` rewrites the file through a temp + atomic rename, which invalidates the stat
      // `commitMerge` took. Nothing else repairs it — `enrichBookFromAudio` writes
      // `audioTotalSize`, not `size`. Skipped when nothing was rewritten: the file is then
      // byte-identical to the one `commitMerge` already measured.
      const fileStats = await stat(outputPath);
      await deps.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));
    }
    return result.warnings;
  } catch (error: unknown) {
    deps.log.warn({ bookId, error: serializeError(error) }, 'Post-merge tag step failed — merge succeeded on disk, but the output carries only its preserved source tags');
    return [];
  }
}
