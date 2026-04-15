import { createHash } from 'node:crypto';
import { parseInfoHash } from './magnet.js';
import { normalizeInfoHash } from './normalize-info-hash.js';

// ── Types ─────────────────────────────────────────────────────────────
export type DownloadArtifact =
  | { type: 'torrent-bytes'; data: Buffer; infoHash: string }
  | { type: 'magnet-uri'; uri: string; infoHash: string }
  | { type: 'nzb-url'; url: string }
  | { type: 'nzb-bytes'; data: Buffer };

export type DownloadProtocol = 'torrent' | 'usenet';

// ── Constants ─────────────────────────────────────────────────────────
const DATA_TORRENT_URI_PREFIX = 'data:application/x-bittorrent;base64,';
const DATA_NZB_URI_PREFIX = 'data:application/x-nzb;base64,';
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ── DownloadUrl value object ──────────────────────────────────────────
export class DownloadUrl {
  constructor(
    readonly raw: string,
    readonly protocol: DownloadProtocol,
  ) {}

  get isMagnet(): boolean {
    return this.raw.startsWith('magnet:');
  }

  get isHttp(): boolean {
    return this.raw.startsWith('http://') || this.raw.startsWith('https://');
  }

  get isDataUri(): boolean {
    return this.raw.startsWith(DATA_TORRENT_URI_PREFIX) || this.raw.startsWith(DATA_NZB_URI_PREFIX);
  }

  async resolve(): Promise<DownloadArtifact> {
    if (this.isMagnet) {
      return this.resolveMagnet();
    }

    if (this.isDataUri) {
      return this.resolveDataUri();
    }

    // Usenet HTTP URLs — passthrough as nzb-url (adapters handle URL submission)
    if (this.protocol === 'usenet' && this.isHttp) {
      return { type: 'nzb-url', url: this.raw };
    }

    if (this.isHttp) {
      return this.resolveHttp(this.raw);
    }

    throw new Error('Unsupported URL scheme — only magnet:, http:, https:, and data: URIs are supported');
  }

  private resolveMagnet(): DownloadArtifact {
    const infoHash = parseInfoHash(this.raw);
    if (!infoHash) {
      throw new Error('Could not extract info hash from magnet URI — missing or malformed xt parameter');
    }

    return { type: 'magnet-uri', uri: this.raw, infoHash: normalizeInfoHash(infoHash) };
  }

  private resolveDataUri(): DownloadArtifact {
    if (this.raw.startsWith(DATA_NZB_URI_PREFIX)) {
      const base64Content = this.raw.slice(DATA_NZB_URI_PREFIX.length);
      return { type: 'nzb-bytes', data: Buffer.from(base64Content, 'base64') };
    }

    const base64Content = this.raw.slice(DATA_TORRENT_URI_PREFIX.length);
    const buffer = Buffer.from(base64Content, 'base64');

    const infoHash = extractInfoHashFromTorrent(buffer);
    if (!infoHash) {
      throw new Error('Could not extract info hash from torrent data — malformed or missing info dictionary');
    }

    return { type: 'torrent-bytes', data: buffer, infoHash };
  }

  private async resolveHttp(url: string): Promise<DownloadArtifact> {
    const visited = new Set<string>();
    let currentUrl = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (visited.has(currentUrl)) {
        throw new Error('Download failed: redirect loop detected');
      }
      visited.add(currentUrl);

      const response = await fetchDownload(currentUrl);

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const result = handleRedirect(response, currentUrl);
        if (result.type === 'follow') {
          currentUrl = result.url;
          continue;
        }
        return result.artifact;
      }

      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      return processResponseBody(response);
    }

    throw new Error('Download failed: too many redirects');
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────

async function fetchDownload(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw sanitizeNetworkError(error);
  }
}

type RedirectResult =
  | { type: 'follow'; url: string }
  | { type: 'resolved'; artifact: DownloadArtifact };

function handleRedirect(response: Response, currentUrl: string): RedirectResult {
  const location = response.headers.get('Location');
  if (!location) {
    throw new Error('Download failed: server returned redirect with no location header');
  }

  if (location.startsWith('magnet:')) {
    const infoHash = parseInfoHash(location);
    if (!infoHash) {
      throw new Error('Download failed: redirect to magnet URI with no info hash');
    }
    return { type: 'resolved', artifact: { type: 'magnet-uri', uri: location, infoHash: normalizeInfoHash(infoHash) } };
  }

  // Resolve relative Location headers against the current URL
  try {
    const resolved = new URL(location, currentUrl).href;
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      return { type: 'follow', url: resolved };
    }
  } catch {
    // Invalid URL — fall through to unsupported scheme error
  }

  throw new Error(`Download failed: redirect to unsupported scheme (${location.split(':')[0]}:)`);
}

async function processResponseBody(response: Response): Promise<DownloadArtifact> {
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error('Download failed: server returned empty response');
  }

  if (isHtmlResponse(response, buffer)) {
    throw new Error(
      'Download failed: server returned HTML instead of a torrent file — ' +
      'an auth proxy may be intercepting requests. ' +
      'Use the service\'s internal address or whitelist this endpoint in your proxy config.',
    );
  }

  const infoHash = extractInfoHashFromTorrent(buffer);
  if (!infoHash) {
    throw new Error('Download failed: could not extract info hash from downloaded torrent file');
  }

  return { type: 'torrent-bytes', data: buffer, infoHash };
}

// ── Helpers (exported for use by resolver and tests) ──────────────────

/** Extract info_hash by finding '4:info' marker and hashing the bencode dict that follows.
 *  Searches all occurrences of '4:info' in case earlier string payloads contain the same bytes. */
export function extractInfoHashFromTorrent(torrent: Buffer): string | null {
  const marker = Buffer.from('4:info');
  let searchFrom = 0;

  while (searchFrom < torrent.length) {
    const idx = torrent.indexOf(marker, searchFrom);
    if (idx === -1) return null;

    const infoStart = idx + marker.length;
    // The info value must be a bencoded dictionary starting with 'd'
    if (infoStart < torrent.length && torrent[infoStart] === 0x64) {
      const result = hashBencodeDict(torrent, infoStart);
      if (result !== null) return result;
    }

    // This occurrence wasn't a valid info dict — try the next one
    searchFrom = idx + 1;
  }

  return null;
}

/** Hash a bencoded dictionary starting at `start` in the buffer. Returns null on parse failure. */
function hashBencodeDict(torrent: Buffer, start: number): string | null {
  let depth = 0;
  let pos = start;
  do {
    const byte = torrent[pos];
    if (byte === 0x64 || byte === 0x6C) depth++; // 'd' or 'l'
    else if (byte === 0x65) depth--; // 'e'
    else if (byte === 0x69) { // 'i' — integer, skip to closing 'e' (not a container end)
      pos = torrent.indexOf(0x65, pos + 1);
      if (pos === -1) return null;
    } else if (byte >= 0x30 && byte <= 0x39) { // digit — string length prefix
      const colonIdx = torrent.indexOf(0x3A, pos); // ':'
      if (colonIdx === -1) return null;
      const len = parseInt(torrent.subarray(pos, colonIdx).toString(), 10);
      pos = colonIdx + len; // skip past the string content
    }
    pos++;
  } while (depth > 0 && pos < torrent.length);

  if (depth !== 0) return null;

  const infoDict = torrent.subarray(start, pos);
  return createHash('sha1').update(infoDict).digest('hex');
}

/** Convert base32-encoded string to hex. */
export function base32ToHex(base32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  let hex = '';

  for (const char of base32.toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
  }

  return hex;
}

/** Check if a response appears to be HTML (login page / auth proxy intercept). */
function isHtmlResponse(response: Response, buffer: Buffer): boolean {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/html')) return true;

  // Check for HTML markers in first 100 bytes
  const head = buffer.subarray(0, Math.min(100, buffer.length)).toString('utf-8').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

/** Sanitize network errors to never include the raw URL (passkey/token safety). */
function sanitizeNetworkError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new Error('Download failed: request timed out');
  }

  if (error instanceof Error) {
    // Undici wraps DNS/connection failures as TypeError('fetch failed') with the real error on .cause
    const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
    const code = cause?.code ?? (error as NodeJS.ErrnoException).code;

    if (code === 'ENOTFOUND') {
      return new Error('Download failed: could not resolve hostname');
    }
    if (code === 'ECONNREFUSED') {
      return new Error('Download failed: connection refused');
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error('Download failed: connection timed out');
    }
    if (code === 'ECONNRESET') {
      return new Error('Download failed: connection reset');
    }
    const sanitized = error.message.replace(/https?:\/\/\S+/gi, '[redacted-url]');
    return new Error(`Download failed: ${sanitized}`);
  }

  return new Error('Download failed: unknown network error');
}
