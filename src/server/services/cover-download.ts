import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { HTTP_DOWNLOAD_TIMEOUT_MS } from '../../core/utils/constants.js';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import { mimeToExt } from '../../shared/mime.js';
import { serializeError } from '../utils/serialize-error.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import {
  createSsrfSafeDispatcher,
  fetchWithOptionalDispatcher,
  resolveAndValidate,
  type DispatcherFetchInit,
} from '../../core/utils/network-service.js';

const MAX_REDIRECTS = 5;

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
 * Result of a single hop: either a follow (redirect with validated next URL)
 * or a final response whose body is safe to stream.
 */
type HopResult =
  | { type: 'follow'; nextUrl: string }
  | { type: 'final'; response: Response };

/**
 * Single hop with SSRF + dispatcher + per-hop revalidation. Pre-validates the
 * URL's hostname/IP literal against the block policy before connecting; the
 * dispatcher re-validates the resolved IP at socket time (DNS rebinding defense).
 */
async function fetchOneHop(url: string, dispatcher: unknown): Promise<HopResult> {
  const parsed = new URL(url);
  await resolveAndValidate(parsed.hostname);

  const fetchOptions: DispatcherFetchInit = {
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_DOWNLOAD_TIMEOUT_MS),
    dispatcher,
  };

  const response = await fetchWithOptionalDispatcher(url, fetchOptions);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Redirect with no location header');
    }
    const nextUrl = new URL(location, url).href;
    if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) {
      throw new Error(`Redirect to unsupported scheme: ${nextUrl.split(':')[0]}:`);
    }
    // Drain the redirect body so the socket can be released
    await response.body?.cancel().catch(() => { /* best-effort */ });
    return { type: 'follow', nextUrl };
  }

  return { type: 'final', response };
}

/**
 * Walk redirects with per-hop validation, returning the final non-redirect Response.
 * Throws on >MAX_REDIRECTS, redirect loops, or any blocked hop.
 */
async function followWithRevalidation(startUrl: string, dispatcher: unknown): Promise<Response> {
  const visited = new Set<string>();
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (visited.has(currentUrl)) {
      throw new Error('Redirect loop detected');
    }
    visited.add(currentUrl);

    const result = await fetchOneHop(currentUrl, dispatcher);
    if (result.type === 'final') return result.response;
    currentUrl = result.nextUrl;
  }

  throw new Error('Too many redirects');
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

  const dispatcher = createSsrfSafeDispatcher();

  try {
    const response = await followWithRevalidation(remoteUrl, dispatcher);

    if (!response.ok) {
      log.warn({ bookId, status: response.status, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover download returned non-OK status');
      await response.body?.cancel().catch(() => { /* best-effort */ });
      return false;
    }

    const contentType = response.headers.get('content-type');
    if (!isImageContentType(contentType)) {
      log.warn({ bookId, contentType, url: sanitizeLogUrl(remoteUrl) }, 'Remote cover response is not an image');
      await response.body?.cancel().catch(() => { /* best-effort */ });
      return false;
    }

    await inspectContentLength(response, { bookId, remoteUrl, log });
    const buffer = await readBodyWithCap(response);
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
