import { readdir, copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { COVER_FILE_REGEX } from '@core/utils/cover-regex.js';
import { removeTree } from '@core/utils/remove-tree.js';
import { MIME_TO_EXT } from '@shared/mime.js';
import { serializeError } from './serialize-error.js';


export { COVER_FILE_REGEX };

// Cache maintenance is best-effort; filesystem failures must not fail callers.
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

    // Remove other extensions so serving cannot depend on directory order.
    const existing = await readdir(cacheDir).catch(() => [] as string[]);
    for (const file of existing) {
      if (COVER_FILE_REGEX.test(file) && file !== coverFile) {
        await unlink(join(cacheDir, file)).catch(() => {/* best-effort */});
      }
    }

    await copyFile(join(bookPath, coverFile), join(cacheDir, coverFile));
    log.debug({ bookId, coverFile }, 'Preserved cover in cache');
  } catch (error: unknown) {
    log.warn({ bookId, error: serializeError(error) }, 'Failed to preserve cover in cache');
  }
}

export async function cleanCoverCache(
  bookId: number,
  configPath: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await removeTree(join(configPath, 'covers', String(bookId)));
  } catch (error: unknown) {
    log.warn({ bookId, error: serializeError(error) }, 'Failed to clean cover cache');
  }
}

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
    const ext = coverFile.split('.').pop();
    const mime = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? 'image/jpeg';

    return { data, mime };
  } catch {
    return null;
  }
}
