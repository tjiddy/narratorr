import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { HTTP_DOWNLOAD_TIMEOUT_MS } from '../../core/utils/constants.js';
import { mimeToExt } from '../../shared/mime.js';
import { serializeError } from '../utils/serialize-error.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';

/** Check whether a coverUrl points to a remote HTTP(S) resource. */
export function isRemoteCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Map Content-Type header to file extension, defaulting to jpg. */
function contentTypeToExt(contentType: string | null): string {
  if (!contentType) return 'jpg';
  const base = contentType.split(';')[0].trim();
  return mimeToExt(base) ?? 'jpg';
}

/** Check if content-type indicates an image. */
function isImageContentType(contentType: string | null): boolean {
  return contentType?.startsWith('image/') === true;
}

/**
 * Download a remote cover image and save it locally using the existing
 * cover contract: `{bookPath}/cover.{ext}` + coverUrl → `/api/books/{id}/cover`.
 *
 * Atomic write: writes to a temp file first, then renames over the target.
 * Returns true on success, false on failure (never throws).
 */
export async function downloadRemoteCover(
  bookId: number,
  bookPath: string,
  remoteUrl: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<boolean> {
  if (!remoteUrl || !bookPath || !isRemoteCoverUrl(remoteUrl)) {
    return false;
  }

  try {
    const response = await fetch(remoteUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn({ bookId, status: response.status, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover download returned non-OK status');
      return false;
    }

    const contentType = response.headers.get('content-type');
    if (!isImageContentType(contentType)) {
      log.warn({ bookId, contentType, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover response is not an image');
      return false;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = contentTypeToExt(contentType);
    const finalPath = join(bookPath, `cover.${ext}`);
    const tempPath = join(bookPath, `.cover-download-${randomUUID()}.tmp`);

    // Atomic write: temp file → rename (rename() overwrites target)
    await writeFile(tempPath, buffer);
    await rename(tempPath, finalPath);

    // Clean up stale cover siblings with different extensions (e.g., old cover.png when new is cover.jpg)
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

    log.info({ bookId, path: finalPath }, 'Remote cover downloaded and saved locally');
    return true;
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId, url: sanitizeLogUrl(remoteUrl) }, 'Failed to download remote cover');
    return false;
  }
}
