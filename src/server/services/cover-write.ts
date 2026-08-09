import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@db/schema.js';
import { COVER_FILE_REGEX } from '@core/utils/cover-regex.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * `written` means the media-visible rename committed, even if later DB finalization fails.
 * `failed` is reserved for pre-commit failures; `skipped` means no write was attempted.
 */
export type CoverWriteOutcome = 'written' | 'skipped' | 'failed';

/** Post-commit cleanup and DB update; failures log but cannot undo the written outcome. */
export async function finalizeCoverWrite(
  bookId: number,
  bookPath: string,
  keepFilename: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const entries = await readdir(bookPath).catch(() => [] as string[]);
    for (const entry of entries) {
      if (COVER_FILE_REGEX.test(entry) && entry.toLowerCase() !== keepFilename.toLowerCase()) {
        await unlink(join(bookPath, entry)).catch(() => { /* best-effort cleanup */ });
      }
    }

    await db.update(books).set({
      coverUrl: `/api/books/${bookId}/cover`,
      updatedAt: new Date(),
    }).where(eq(books.id, bookId));
  } catch (error: unknown) {
    log.warn(
      { error: serializeError(error), bookId },
      'Cover written to disk but post-write cleanup/DB update failed — coverUrl may be stale until next reconcile',
    );
  }
}
