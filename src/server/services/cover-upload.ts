import { writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { mimeToExt } from '../utils/mime.js';
import { finalizeCoverWrite, type CoverWriteOutcome } from './cover-write.js';

export type CoverUploadErrorCode = 'INVALID_MIME' | 'NOT_FOUND' | 'NO_PATH';

export class CoverUploadError extends Error {
  code: CoverUploadErrorCode;
  constructor(message: string, code: CoverUploadErrorCode) {
    super(message);
    this.code = code;
  }
}

/**
 * Upload a custom cover image for a book.
 * Atomic write (temp file → rename), stale sibling cleanup, immediate DB update.
 * Follows the same pattern as downloadRemoteCover in cover-download.ts.
 *
 * Returns a {@link CoverWriteOutcome}: `'written'` once the `cover.*` rename commits (even if the
 * subsequent DB `coverUrl` update throws — see {@link finalizeCoverWrite}). Pre-rename failures
 * (unsupported MIME, rename error) still THROW so the upload request keeps its existing error
 * response rather than reporting a spurious success — there is no `'failed'`/`'skipped'` path here.
 */
export async function uploadBookCover(
  bookId: number,
  bookPath: string,
  buffer: Buffer,
  mimeType: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<CoverWriteOutcome> {
  const ext = mimeToExt(mimeType);
  if (!ext) {
    throw new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME');
  }

  const keepFilename = `cover.${ext}`;
  const finalPath = join(bookPath, keepFilename);
  const tempPath = join(bookPath, `.cover-upload-${randomUUID()}.tmp`);

  // Atomic write: temp file → rename (rename() overwrites target). A pre-rename failure throws
  // (preserving the upload's existing error response); once the rename commits the cover has
  // materialized and the outcome is 'written' regardless of the DB update below.
  await writeFile(tempPath, buffer);
  try {
    await rename(tempPath, finalPath);
  } catch (error: unknown) {
    // Clean up temp file on rename failure — no partial state
    await unlink(tempPath).catch(() => { /* best-effort */ });
    throw error;
  }

  // Cover committed on disk. Sibling cleanup + DB `coverUrl` update are nonfatal from here.
  await finalizeCoverWrite(bookId, bookPath, keepFilename, db, log);

  log.info({ bookId, path: finalPath }, 'Custom cover uploaded');
  return 'written';
}
