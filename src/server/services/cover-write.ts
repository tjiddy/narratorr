import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Outcome of a `cover.*` materialization attempt, mirroring {@link import('../utils/opf-writer.js').OpfWriteOutcome}:
 * - `'written'` — the temp→rename of `cover.*` committed (the irreversible media-visible write).
 *   **Returned even if the subsequent DB `coverUrl` update throws** — the file changed on disk
 *   regardless and the stale `coverUrl` self-heals on the next backfill/edit. Callers enqueue a
 *   `'metadata'` refresh on this outcome.
 * - `'skipped'` — no write attempted (caller-gated: null / already-local `coverUrl`).
 * - `'failed'` — failure *before* the rename committed (SSRF block, non-image content-type,
 *   fetch/network error, temp-write / rename error). The on-disk cover is unchanged → no refresh.
 */
export type CoverWriteOutcome = 'written' | 'skipped' | 'failed';

/**
 * Post-rename finalize shared by both cover writers (`downloadRemoteCover` / `uploadBookCover`):
 * clean stale cover siblings with a different extension and update the DB `coverUrl`. The cover
 * file has already committed (the rename succeeded) by the time this runs, so a failure here is
 * LOGGED but does NOT downgrade the writer's `'written'` outcome — the file changed regardless, and
 * the stale `coverUrl` self-heals on the next backfill/edit. This is what lets a post-rename DB-update
 * failure still fire a connector refresh (keyed off the materialized file, not off the DB update).
 */
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
