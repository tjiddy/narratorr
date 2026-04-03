import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { type DownloadClientAdapter, type DownloadItemInfo, type AddDownloadOptions, type DownloadProtocol, ETA_UPPER_BOUND_SEC } from './types.js';
import { qbTorrentsResponseSchema } from './schemas.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';

export interface QBittorrentConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
}

interface QBTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  total_size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  eta: number;
  save_path: string;
  content_path?: string;
  added_on: number;
  completion_on: number;
}

export class QBittorrentClient implements DownloadClientAdapter {
  readonly type = 'qbittorrent';
  readonly name = 'qBittorrent';
  readonly protocol: DownloadProtocol = 'torrent';
  readonly supportsCategories = true;

  private baseUrl: string;
  private cookie?: string;
  private loginPromise?: Promise<void>;

  constructor(private config: QBittorrentConfig) {
    const protocol = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
  }

  private async login(): Promise<void> {
    // Deduplicate concurrent login calls
    if (this.loginPromise) {
      return this.loginPromise;
    }
    this.loginPromise = this.doLogin();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = undefined;
    }
  }

  private async doLogin(): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: this.baseUrl,
      },
      body: new URLSearchParams({
        username: this.config.username,
        password: this.config.password,
      }),
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`Login failed: HTTP ${response.status}`);
    }

    const text = await response.text();
    if (text === 'Fails.') {
      throw new Error('Login failed: Invalid credentials');
    }

    // Extract SID cookie from response headers
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const sidMatch = setCookie.match(/SID=([^;]+)/);
      if (sidMatch) {
        this.cookie = `SID=${sidMatch[1]}`;
      }
    }

    if (!this.cookie) {
      throw new Error('Login failed: No session cookie received');
    }
  }

  private async request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
    if (!this.cookie) {
      await this.login();
    }

    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        Cookie: this.cookie!,
        Referer: this.baseUrl,
      },
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (response.status === 403 && !retried) {
      // Session expired, re-login and retry once
      this.cookie = undefined;
      await this.login();
      return this.request(path, options, true);
    }

    if (!response.ok) {
      throw new Error(`Request failed: HTTP ${response.status} ${path}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON 2xx response (e.g. qB returns "Ok." for /torrents/add).
      // Check Content-Type to distinguish: HTML/text from a proxy is an error,
      // plain text from qB (no content-type or text/plain) is a valid non-JSON response.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        throw new Error('Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.');
      }
      return undefined as T;
    }
  }

  async addDownload(url: string, options?: AddDownloadOptions): Promise<string> {
    // Torrent file upload path — uses multipart form data
    if (options?.torrentFile) {
      return this.addDownloadFromFile(options.torrentFile, options);
    }

    // Validate magnet URI before sending to qBittorrent — .torrent URLs are not supported
    if (!url.startsWith('magnet:')) {
      throw new Error(
        'qBittorrent adapter only supports magnet URIs. Received a non-magnet URL (possibly a .torrent link — URL omitted to avoid leaking passkeys/tokens in logs).',
      );
    }

    const formData = new URLSearchParams();
    formData.set('urls', url);

    if (options?.savePath) {
      formData.set('savepath', options.savePath);
    }
    if (options?.category) {
      formData.set('category', options.category);
    }
    if (options?.paused) {
      formData.set('paused', 'true');
    }

    await this.request('/api/v2/torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData,
    });

    // Extract hash from magnet URI
    const hashMatch = url.match(/btih(?::|%3A)([a-f0-9]{40}|[a-z2-7]{32})/i);
    if (hashMatch) {
      // If it's base32, convert to hex
      const hash = hashMatch[1];
      if (hash.length === 32) {
        return base32ToHex(hash).toLowerCase();
      }
      return hash.toLowerCase();
    }

    throw new Error('Could not extract info hash from magnet URI');
  }

  private async addDownloadFromFile(torrentFile: Buffer, options?: AddDownloadOptions): Promise<string> {
    if (!this.cookie) {
      await this.login();
    }

    const formData = new FormData();
    formData.append('torrents', new Blob([new Uint8Array(torrentFile)], { type: 'application/x-bittorrent' }), 'upload.torrent');

    if (options?.savePath) {
      formData.append('savepath', options.savePath);
    }
    if (options?.category) {
      formData.append('category', options.category);
    }
    if (options?.paused) {
      formData.append('paused', 'true');
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: {
        Cookie: this.cookie!,
        Referer: this.baseUrl,
      },
      body: formData,
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`Request failed: HTTP ${response.status} /api/v2/torrents/add`);
    }

    // Compute info hash from torrent file content using SHA-1 of bencoded info dictionary
    const hash = extractInfoHashFromTorrent(torrentFile);
    if (hash) {
      return hash.toLowerCase();
    }

    throw new Error('Could not extract info hash from torrent file');
  }

  async getDownload(hash: string): Promise<DownloadItemInfo | null> {
    const raw = await this.request<unknown>(
      `/api/v2/torrents/info?hashes=${hash.toLowerCase()}`
    );

    if (!raw) return null;

    const parsed = qbTorrentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`qBittorrent returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }

    if (parsed.data.length === 0) return null;
    return this.mapItem(parsed.data[0] as QBTorrent);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : '';
    const raw = await this.request<unknown>(`/api/v2/torrents/info${params}`);

    if (!raw) return [];

    const parsed = qbTorrentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`qBittorrent returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }

    return parsed.data.map((t) => this.mapItem(t as QBTorrent));
  }

  async pauseDownload(hash: string): Promise<void> {
    await this.request('/api/v2/torrents/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash.toLowerCase() }),
    });
  }

  async resumeDownload(hash: string): Promise<void> {
    await this.request('/api/v2/torrents/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash.toLowerCase() }),
    });
  }

  async removeDownload(hash: string, deleteFiles = false): Promise<void> {
    await this.request('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        hashes: hash.toLowerCase(),
        deleteFiles: deleteFiles.toString(),
      }),
    });
  }

  async getCategories(): Promise<string[]> {
    const categories = await this.request<Record<string, { name: string; savePath: string }>>('/api/v2/torrents/categories');
    return Object.keys(categories || {});
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.login();
      const response = await fetchWithTimeout(`${this.baseUrl}/api/v2/app/version`, {
        headers: {
          Cookie: this.cookie!,
          Referer: this.baseUrl,
        },
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`Request failed: HTTP ${response.status} /api/v2/app/version`);
      }
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('text/html')) {
        throw new Error('Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.');
      }
      const version = await response.text();
      return { success: true, message: `qBittorrent ${version}` };
    } catch (error: unknown) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private mapItem(qbt: QBTorrent): DownloadItemInfo {
    const contentPath = qbt.content_path?.replace(/\/+$/, '');
    const useFallback = !contentPath;
    return {
      id: qbt.hash,
      name: useFallback ? qbt.name : basename(contentPath),
      progress: Math.round(qbt.progress * 100),
      status: this.mapState(qbt.state),
      savePath: useFallback ? qbt.save_path : dirname(contentPath),
      size: qbt.total_size,
      downloaded: qbt.downloaded,
      uploaded: qbt.uploaded,
      ratio: qbt.ratio,
      seeders: qbt.num_seeds,
      leechers: qbt.num_leechs,
      eta: qbt.eta > 0 && qbt.eta < ETA_UPPER_BOUND_SEC ? qbt.eta : undefined,
      addedAt: new Date(qbt.added_on * 1000),
      completedAt: qbt.completion_on > 0 ? new Date(qbt.completion_on * 1000) : undefined,
    };
  }

  private mapState(state: string): DownloadItemInfo['status'] {
    const stateMap: Record<string, DownloadItemInfo['status']> = {
      downloading: 'downloading',
      stalledDL: 'downloading',
      metaDL: 'downloading',
      forcedDL: 'downloading',
      allocating: 'downloading',
      uploading: 'seeding',
      stalledUP: 'seeding',
      forcedUP: 'seeding',
      pausedDL: 'paused',
      pausedUP: 'paused',
      queuedDL: 'downloading',
      queuedUP: 'seeding',
      checkingDL: 'downloading',
      checkingUP: 'seeding',
      checkingResumeData: 'downloading',
      moving: 'downloading',
      error: 'error',
      missingFiles: 'error',
      unknown: 'error',
    };

    // Handle completed state based on progress
    if (state === 'pausedUP' || state === 'stalledUP' || state === 'uploading') {
      return 'seeding';
    }

    return stateMap[state] || 'downloading';
  }
}

/** Extract info_hash by finding '4:info' marker and hashing the bencode dict that follows.
 *  Searches all occurrences of '4:info' in case earlier string payloads contain the same bytes. */
function extractInfoHashFromTorrent(torrent: Buffer): string | null {
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

// Helper function to convert base32 to hex
function base32ToHex(base32: string): string {
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
