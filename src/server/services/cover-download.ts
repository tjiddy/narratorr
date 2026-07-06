import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import { mimeToExt } from '../../shared/mime.js';
import { serializeError } from '../utils/serialize-error.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import {
  createSsrfSafeDispatcher,
  fetchWithSsrfRedirect,
} from '../../core/utils/network-service.js';
import { finalizeCoverWrite, type CoverWriteOutcome } from './cover-write.js';

/** Check whether a coverUrl points to a remote HTTP(S) resource. */
export function isRemoteCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Map Content-Type header to file extension, defaulting to jpg. */
function contentTypeToExt(contentType: string | null): string {
  if (!contentType) return 'jpg';
  const base = contentType.split(';')[0]!.trim();
  return mimeToExt(base) ?? 'jpg';
}

/** Check if content-type indicates an image. */
function isImageContentType(contentType: string | null): boolean {
  return contentType?.startsWith('image/') === true;
}

/**
 * Pre-check Content-Length: warn on malformed values, throw on over-cap.
 * No-op when the header is absent or valid within cap; the streaming cap in
 * `readBodyWithCap` continues to backstop bodies from servers that lie.
 */
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

/**
 * Read response body with a streamed size cap. Aborts and throws if the body
 * exceeds MAX_COVER_SIZE — even when the server lies about Content-Length.
 */
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
 * Download a remote cover image and save it locally using the existing
 * cover contract: `{bookPath}/cover.{ext}` + coverUrl → `/api/books/{id}/cover`.
 *
 * SSRF mitigations: refuses cloud-metadata hostnames, validates every DNS
 * answer against a block policy (RFC 1918, loopback, link-local, ULA, mapped
 * IPv4), and uses an undici Agent whose `connect.lookup` re-validates at
 * socket time to defeat DNS rebinding. Manual redirect handling caps hops at 5
 * and re-runs validation on each hop. Response size is capped at MAX_COVER_SIZE
 * via Content-Length pre-check + streamed running total.
 *
 * Atomic write: writes to a temp file first, then renames over the target.
 *
 * Returns a {@link CoverWriteOutcome}: `'written'` once the `cover.*` rename commits (even if the
 * subsequent DB `coverUrl` update throws — see {@link finalizeCoverWrite}), `'failed'` on any
 * failure *before* the rename, and `'skipped'` when there is no remote URL to materialize. Never
 * throws.
 */
export async function downloadRemoteCover(
  bookId: number,
  bookPath: string,
  remoteUrl: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<CoverWriteOutcome> {
  // Caller-gated no-op: nothing to materialize (null / non-remote URL). Not a failure.
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
        return 'failed';
      }

      const contentType = response.headers.get('content-type');
      if (!isImageContentType(contentType)) {
        log.warn({ bookId, contentType, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover response is not an image');
        await response.body?.cancel().catch(() => { /* best-effort */ });
        return 'failed';
      }

      await inspectContentLength(response, { bookId, remoteUrl, log });
      const buffer = await readBodyWithCap(response);
      const ext = contentTypeToExt(contentType);
      keepFilename = `cover.${ext}`;
      finalPath = join(bookPath, keepFilename);
      const tempPath = join(bookPath, `.cover-download-${randomUUID()}.tmp`);

      // Atomic write: temp file → rename (rename() overwrites target). This is the irreversible
      // media-visible write — once it commits the outcome is 'written' regardless of what follows.
      await writeFile(tempPath, buffer);
      await rename(tempPath, finalPath);
    } catch (error: unknown) {
      log.warn({ error: serializeError(error), bookId, url: sanitizeLogUrl(remoteUrl) }, 'Failed to download remote cover');
      return 'failed';
    }

    // Cover materialized on disk. Sibling cleanup + DB `coverUrl` update are nonfatal from here:
    // a failure is logged but does NOT downgrade the outcome (the file changed regardless).
    await finalizeCoverWrite(bookId, bookPath, keepFilename, db, log);
    log.info({ bookId, path: finalPath }, 'Remote cover downloaded and saved locally');
    return 'written';
  } finally {
    await dispatcher.close().catch(() => { /* best-effort cleanup */ });
  }
}
