import { readdir, copyFile, mkdir, rm, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';

export { COVER_FILE_REGEX };

/**
 * Copy a cover image from the book directory to a persistent cache.
 * Best-effort — failures are logged but never thrown.
 */
export async function preserveBookCover(
  bookPath: string,
  bookId: number,
  configPath: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const entries = await readdir(bookPath);
    const coverFile = entries.find(f => COVER_FILE_REGEX.test(f));
    if (!coverFile) return;

    const cacheDir = join(configPath, 'covers', String(bookId));
    await mkdir(cacheDir, { recursive: true });

    // Remove stale siblings with different extensions to prevent nondeterministic serving
    const existing = await readdir(cacheDir).catch(() => [] as string[]);
    for (const file of existing) {
      if (COVER_FILE_REGEX.test(file) && file !== coverFile) {
        await unlink(join(cacheDir, file)).catch(() => {/* best-effort */});
      }
    }

    await copyFile(join(bookPath, coverFile), join(cacheDir, coverFile));
    log.debug({ bookId, coverFile }, 'Preserved cover in cache');
  } catch (error: unknown) {
    log.warn({ bookId, error }, 'Failed to preserve cover in cache');
  }
}

/**
 * Remove cached cover for a book. Best-effort — failures are logged but never thrown.
 */
export async function cleanCoverCache(
  bookId: number,
  configPath: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await rm(join(configPath, 'covers', String(bookId)), { recursive: true, force: true });
  } catch (error: unknown) {
    log.warn({ bookId, error }, 'Failed to clean cover cache');
  }
}

/**
 * Serve a cached cover image. Returns data + MIME type, or null if not cached.
 */
export async function serveCoverFromCache(
  bookId: number,
  configPath: string,
): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const cacheDir = join(configPath, 'covers', String(bookId));
    const entries = await readdir(cacheDir);
    const coverFile = entries.find(f => COVER_FILE_REGEX.test(f));
    if (!coverFile) return null;

    const data = await readFile(join(cacheDir, coverFile));
    const mime = coverFile.endsWith('.png') ? 'image/png'
      : coverFile.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg';

    return { data, mime };
  } catch {
    return null;
  }
}
