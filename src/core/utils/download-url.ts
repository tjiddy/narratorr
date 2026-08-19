import { createHash } from 'node:crypto';
import type { DownloadProtocol } from '../indexers/types.js';
import { ABB_DETAILS_SENTINEL_PREFIX } from '../indexers/abb-sentinel.js';
import { MAM_TORRENT_SENTINEL_PREFIX } from '../indexers/mam-wedge.js';
import { parseInfoHash } from './magnet.js';
import { normalizeInfoHash } from './normalize-info-hash.js';
import { getUserAgent } from '@shared/user-agent.js';
import {
  createSsrfSafeDispatcher,
  fetchWithSsrfRedirect,
  mapNetworkError,
  redactUrlsFromMessage,
  UnsupportedRedirectSchemeError,
} from './network-service.js';

export type DownloadArtifact =
  | { type: 'torrent-bytes'; data: Buffer; infoHash: string }
  | { type: 'magnet-uri'; uri: string; infoHash: string }
  | { type: 'nzb-url'; url: string; lanAllowlist?: LanAllowlist }
  | { type: 'nzb-bytes'; data: Buffer };

const DATA_TORRENT_URI_PREFIX = 'data:application/x-bittorrent;base64,';
const DATA_NZB_URI_PREFIX = 'data:application/x-nzb;base64,';

/**
 * `hostPort` is authoritative during preflight; `hostname` repeats validation at socket connect to
 * resist DNS rebinding. Derive both from parsed URLs because splitting host:port is ambiguous for IPv6.
 */
export interface LanAllowlist {
  hostPort: Set<string>;
  hostname: Set<string>;
}

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

  async resolve(lanAllowlist?: LanAllowlist): Promise<DownloadArtifact> {
    if (this.isMagnet) {
      return this.resolveMagnet();
    }

    if (this.isDataUri) {
      return this.resolveDataUri();
    }

    // Blackhole downloads nzb-url artifacts itself, so carry the LAN allowlist with them.
    if (this.protocol === 'usenet' && this.isHttp) {
      return { type: 'nzb-url', url: this.raw, ...(lanAllowlist && { lanAllowlist }) };
    }

    if (this.isHttp) {
      return this.resolveHttp(this.raw, lanAllowlist);
    }

    // An indexer sentinel reaching artifact resolution means no adapter resolve hook translated
    // it — the indexer that minted it is gone or unwired. Name that, not a URL-scheme bug.
    if (this.raw.startsWith(ABB_DETAILS_SENTINEL_PREFIX) || this.raw.startsWith(MAM_TORRENT_SENTINEL_PREFIX)) {
      throw new Error('This release requires its indexer to resolve the download — the indexer that produced it is no longer configured');
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

  private async resolveHttp(url: string, lanAllowlist?: LanAllowlist): Promise<DownloadArtifact> {
    const dispatcher = createSsrfSafeDispatcher(lanAllowlist?.hostname);
    try {
      const response = await fetchWithSsrfRedirect(url, {
        dispatcher,
        headers: { 'User-Agent': getUserAgent() },
        ...(lanAllowlist && { lanAllowlist: lanAllowlist.hostPort }),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => { /* best-effort */ });
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      return await processResponseBody(response);
    } catch (error: unknown) {
      if (error instanceof UnsupportedRedirectSchemeError && error.location.startsWith('magnet:')) {
        const infoHash = parseInfoHash(error.location);
        if (!infoHash) {
          throw new Error('Download failed: redirect to magnet URI with no info hash', { cause: error });
        }
        return { type: 'magnet-uri', uri: error.location, infoHash: normalizeInfoHash(infoHash) };
      }
      throw sanitizeNetworkError(error);
    } finally {
      await dispatcher.close().catch(() => { /* best-effort cleanup */ });
    }
  }
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

/** Hashes the first valid bencoded info dictionary, skipping marker bytes inside string payloads. */
export function extractInfoHashFromTorrent(torrent: Buffer): string | null {
  const marker = Buffer.from('4:info');
  let searchFrom = 0;

  while (searchFrom < torrent.length) {
    const idx = torrent.indexOf(marker, searchFrom);
    if (idx === -1) return null;

    const infoStart = idx + marker.length;
    // 0x64 (`d`) is the only valid type for the info value.
    if (infoStart < torrent.length && torrent[infoStart] === 0x64) {
      const result = hashBencodeDict(torrent, infoStart);
      if (result !== null) return result;
    }

    searchFrom = idx + 1;
  }

  return null;
}

function hashBencodeDict(torrent: Buffer, start: number): string | null {
  let depth = 0;
  let pos = start;
  do {
    const byte = torrent[pos]!;
    if (byte === 0x64 || byte === 0x6C) depth++; // `d` dictionary or `l` list
    else if (byte === 0x65) depth--; // `e` container terminator
    else if (byte === 0x69) { // An integer's closing `e` is not a container terminator.
      pos = torrent.indexOf(0x65, pos + 1);
      if (pos === -1) return null;
    } else if (byte >= 0x30 && byte <= 0x39) { // String length prefix
      const colonIdx = torrent.indexOf(0x3A, pos); // ':'
      if (colonIdx === -1) return null;
      const len = parseInt(torrent.subarray(pos, colonIdx).toString(), 10);
      pos = colonIdx + len;
    }
    pos++;
  } while (depth > 0 && pos < torrent.length);

  if (depth !== 0) return null;

  const infoDict = torrent.subarray(start, pos);
  return createHash('sha1').update(infoDict).digest('hex');
}

function isHtmlResponse(response: Response, buffer: Buffer): boolean {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/html')) return true;

  const head = buffer.subarray(0, Math.min(100, buffer.length)).toString('utf-8').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

/** Sanitize network errors to never include the raw URL (passkey/token safety). */
function sanitizeNetworkError(error: unknown): Error {
  const mapped = mapNetworkError(error);
  return new Error(`Download failed: ${redactUrlsFromMessage(mapped.message)}`);
}
