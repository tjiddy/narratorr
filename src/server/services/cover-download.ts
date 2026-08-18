import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_COVER_SIZE } from '@shared/constants.js';
import { mimeToExt } from '@shared/mime.js';
import { serializeError } from '../utils/serialize-error.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import {
  createSsrfSafeDispatcher,
  fetchWithSsrfRedirect,
} from '@core/utils/network-service.js';
import { finalizeCoverWrite, type CoverWriteOutcome } from './cover-write.js';
import { withBookAdmissionLock } from './book-admission.js';

export function isRemoteCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function contentTypeToExt(contentType: string | null): string {
  if (!contentType) return 'jpg';
  const base = contentType.split(';')[0]!.trim();
  return mimeToExt(base) ?? 'jpg';
}

function isImageContentType(contentType: string | null): boolean {
  return contentType?.startsWith('image/') === true;
}

/** Reject oversized declarations; malformed or absent lengths fall through to the streaming cap. */
async function inspectContentLength(
  response: Response,
  context: { bookId: number; remoteUrl: string; log: FastifyBaseLogger },
): Promise<void> {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return;

  const declared = Number.parseInt(contentLength, 10);
  const malformed = !Number.isFinite(declared) || declared <= 0 || contentLength.includes(',');

  if (malformed) {
    context.log.warn(
      { bookId: context.bookId, url: sanitizeLogUrl(context.remoteUrl), contentLength },
      'Cover download upstream sent malformed Content-Length; relying on streaming cap',
    );
    return;
  }

  if (declared > MAX_COVER_SIZE) {
    await response.body?.cancel().catch(() => { /* best-effort */ });
    throw new Error(`Content-Length ${declared} exceeds MAX_COVER_SIZE ${MAX_COVER_SIZE}`);
  }
}

/** Read with a hard streaming cap independent of Content-Length. */
async function readBodyWithCap(response: Response): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_COVER_SIZE) {
        await reader.cancel().catch(() => { /* best-effort */ });
        throw new Error(`Streamed body exceeded MAX_COVER_SIZE ${MAX_COVER_SIZE}`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks);
}

/**
 * Serialized entry point for callers that hold no lock. The write and its `finalizeCoverWrite`
 * localization share one admission section, so a rename or delete can neither move the folder
 * between them nor leave a `cover.<ext>` in a folder the book no longer owns.
 */
export async function downloadRemoteCover(
  bookId: number,
  bookPath: string,
  remoteUrl: string,
  db: Db,
  log: FastifyBaseLogger,
  onFailure?: ((cause: unknown) => void) | undefined,
): Promise<CoverWriteOutcome> {
  return withBookAdmissionLock(bookId, () =>
    downloadRemoteCoverWithinAdmissionLock(bookId, bookPath, remoteUrl, db, log, onFailure));
}

/**
 * Caller must hold the admission lock for `bookId`.
 *
 * Fetch through SSRF-safe redirect validation with a hard size cap, then atomically rename into
 * `cover.{ext}`. Rename commits `written`; later cleanup/DB failures cannot downgrade it. Returns
 * `failed` before that point and `skipped` for nonremote input; never throws.
 */
export async function downloadRemoteCoverWithinAdmissionLock(
  bookId: number,
  bookPath: string,
  remoteUrl: string,
  db: Db,
  log: FastifyBaseLogger,
  /** Receives the underlying pre-rename failure once, preserving nested cause data. */
  onFailure?: ((cause: unknown) => void) | undefined,
): Promise<CoverWriteOutcome> {
  if (!remoteUrl || !bookPath || !isRemoteCoverUrl(remoteUrl)) {
    return 'skipped';
  }

  const dispatcher = createSsrfSafeDispatcher();

  try {
    let finalPath: string;
    let keepFilename: string;
    try {
      const response = await fetchWithSsrfRedirect(remoteUrl, { dispatcher });

      if (!response.ok) {
        log.warn({ bookId, status: response.status, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover download returned non-OK status');
        await response.body?.cancel().catch(() => { /* best-effort */ });
        onFailure?.(`Cover download returned HTTP ${response.status}`);
        return 'failed';
      }

      const contentType = response.headers.get('content-type');
      if (!isImageContentType(contentType)) {
        log.warn({ bookId, contentType, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover response is not an image');
        await response.body?.cancel().catch(() => { /* best-effort */ });
        onFailure?.(`Cover response is not an image (content-type: ${contentType ?? 'none'})`);
        return 'failed';
      }

      await inspectContentLength(response, { bookId, remoteUrl, log });
      const buffer = await readBodyWithCap(response);
      const ext = contentTypeToExt(contentType);
      keepFilename = `cover.${ext}`;
      finalPath = join(bookPath, keepFilename);
      const tempPath = join(bookPath, `.cover-download-${randomUUID()}.tmp`);

      // Rename is the commit point: later failures cannot downgrade written.
      await writeFile(tempPath, buffer);
      await rename(tempPath, finalPath);
    } catch (error: unknown) {
      log.warn({ error: serializeError(error), bookId, url: sanitizeLogUrl(remoteUrl) }, 'Failed to download remote cover');
      onFailure?.(error);
      return 'failed';
    }

    // Cleanup and DB localization are nonfatal after the commit point.
    await finalizeCoverWrite(bookId, bookPath, keepFilename, db, log);
    log.info({ bookId, path: finalPath }, 'Remote cover downloaded and saved locally');
    return 'written';
  } finally {
    await dispatcher.close().catch(() => { /* best-effort cleanup */ });
  }
}
