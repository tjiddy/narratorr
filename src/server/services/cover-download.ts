import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Check whether a coverUrl points to a remote HTTP(S) resource. */
export function isRemoteCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Map Content-Type header to file extension. */
function contentTypeToExt(contentType: string | null): string {
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  return 'jpg';
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
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn({ bookId, status: response.status, url: remoteUrl }, 'Remote cover download returned non-OK status');
      return false;
    }

    const contentType = response.headers.get('content-type');
    if (!isImageContentType(contentType)) {
      log.warn({ bookId, contentType, url: remoteUrl }, 'Remote cover response is not an image');
      return false;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = contentTypeToExt(contentType);
    const finalPath = join(bookPath, `cover.${ext}`);
    const tempPath = join(bookPath, `.cover-download-${bookId}.tmp`);

    // Atomic write: temp file → rename (rename() overwrites target)
    await writeFile(tempPath, buffer);
    await rename(tempPath, finalPath);

    // Update DB immediately after irreversible filesystem step
    await db.update(books).set({
      coverUrl: `/api/books/${bookId}/cover`,
      updatedAt: new Date(),
    }).where(eq(books.id, bookId));

    log.info({ bookId, path: finalPath }, 'Remote cover downloaded and saved locally');
    return true;
  } catch (error: unknown) {
    log.warn({ error, bookId, url: remoteUrl }, 'Failed to download remote cover');
    return false;
  }
}
