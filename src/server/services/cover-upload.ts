import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';

export type CoverUploadErrorCode = 'INVALID_MIME' | 'NOT_FOUND' | 'NO_PATH';

export class CoverUploadError extends Error {
  code: CoverUploadErrorCode;
  constructor(message: string, code: CoverUploadErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Map MIME type to file extension for cover images. */
function mimeToExt(mime: string): string | null {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return null;
}

/**
 * Upload a custom cover image for a book.
 * Atomic write (temp file → rename), stale sibling cleanup, immediate DB update.
 * Follows the same pattern as downloadRemoteCover in cover-download.ts.
 */
export async function uploadBookCover(
  bookId: number,
  bookPath: string,
  buffer: Buffer,
  mimeType: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<void> {
  const ext = mimeToExt(mimeType);
  if (!ext) {
    throw new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME');
  }

  const finalPath = join(bookPath, `cover.${ext}`);
  const tempPath = join(bookPath, `.cover-upload-${randomUUID()}.tmp`);

  // Atomic write: temp file → rename (rename() overwrites target)
  await writeFile(tempPath, buffer);
  await rename(tempPath, finalPath);

  // Clean up stale cover siblings with different extensions
  const targetFilename = `cover.${ext}`;
  const entries = await readdir(bookPath).catch(() => [] as string[]);
  for (const entry of entries) {
    if (COVER_FILE_REGEX.test(entry) && entry.toLowerCase() !== targetFilename.toLowerCase()) {
      await unlink(join(bookPath, entry)).catch(() => { /* best-effort cleanup */ });
    }
  }

  // Update DB immediately after irreversible filesystem step
  await db.update(books).set({
    coverUrl: `/api/books/${bookId}/cover`,
    updatedAt: new Date(),
  }).where(eq(books.id, bookId));

  log.info({ bookId, path: finalPath }, 'Custom cover uploaded');
}
