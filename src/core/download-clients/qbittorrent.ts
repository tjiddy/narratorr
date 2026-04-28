import { basename, dirname, relative } from 'node:path';
import { type DownloadClientAdapter, type DownloadItemInfo, type AddDownloadOptions, type DownloadArtifact, type DownloadProtocol, ETA_UPPER_BOUND_SEC } from './types.js';
import { qbTorrentsResponseSchema } from './schemas.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError } from './errors.js';
import { requestWithRetry } from './retry.js';
import { getErrorMessage } from '../../shared/error-message.js';

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
  dlspeed?: number;
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
      throw new DownloadClientError(this.name, `Login failed: HTTP ${response.status}`);
    }

    const text = await response.text();
    if (text === 'Fails.') {
      throw new DownloadClientAuthError(this.name, 'Login failed: Invalid credentials');
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
      throw new DownloadClientAuthError(this.name, 'Login failed: No session cookie received');
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return requestWithRetry(
      async () => {
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

        if (response.status === 403) {
          throw new DownloadClientAuthError(this.name, `Session expired: HTTP 403 ${path}`);
        }

        if (!response.ok) {
          throw new DownloadClientError(this.name, `Request failed: HTTP ${response.status} ${path}`);
        }

        const text = await response.text();
        if (!text) {
          return undefined as T;
        }

        try {
          return JSON.parse(text) as T;
        } catch {
          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('text/html')) {
            throw new DownloadClientError(this.name, 'Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.');
          }
          return undefined as T;
        }
      },
      {
        clientName: this.name,
        shouldRetry: (e) => e instanceof DownloadClientAuthError,
        onRetry: async () => {
          this.cookie = undefined;
          await this.login();
        },
      },
    );
  }

  async addDownload(artifact: DownloadArtifact, options?: AddDownloadOptions): Promise<string> {
    if (artifact.type === 'torrent-bytes') {
      return this.addDownloadFromFile(artifact.data, artifact.infoHash, options);
    }

    if (artifact.type === 'magnet-uri') {
      const formData = new URLSearchParams();
      formData.set('urls', artifact.uri);

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

      return artifact.infoHash;
    }

    throw new DownloadClientError(this.name, 'qBittorrent only supports torrent artifacts (torrent-bytes, magnet-uri)');
  }

  private async addDownloadFromFile(torrentFile: Buffer, infoHash: string, options?: AddDownloadOptions): Promise<string> {
    return requestWithRetry(
      async () => {
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

        if (response.status === 403) {
          throw new DownloadClientAuthError(this.name, `Session expired: HTTP 403 /api/v2/torrents/add`);
        }

        if (!response.ok) {
          throw new DownloadClientError(this.name, `Request failed: HTTP ${response.status} /api/v2/torrents/add`);
        }

        return infoHash;
      },
      {
        clientName: this.name,
        shouldRetry: (e) => e instanceof DownloadClientAuthError,
        onRetry: async () => {
          this.cookie = undefined;
          await this.login();
        },
      },
    );
  }


  async getDownload(hash: string): Promise<DownloadItemInfo | null> {
    const raw = await this.request<unknown>(
      `/api/v2/torrents/info?hashes=${hash.toLowerCase()}`
    );

    // Pass `raw` through safeParse unconditionally — empty body / non-JSON body
    // surface as undefined here and must fail validation with a ZodError cause
    // rather than silently looking like "no torrents".
    const parsed = qbTorrentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `qBittorrent returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }

    if (parsed.data.length === 0) return null;
    return this.mapItem(parsed.data[0] as QBTorrent);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : '';
    const raw = await this.request<unknown>(`/api/v2/torrents/info${params}`);

    // Pass `raw` through safeParse unconditionally — empty body / non-JSON body
    // surface as undefined here and must fail validation with a ZodError cause
    // rather than silently looking like "no torrents".
    const parsed = qbTorrentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `qBittorrent returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
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
        message: getErrorMessage(error),
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
      status: this.mapState(qbt.state, qbt.save_path, contentPath),
      savePath: useFallback ? qbt.save_path : dirname(contentPath),
      size: qbt.total_size,
      downloaded: qbt.downloaded,
      uploaded: qbt.uploaded,
      ratio: qbt.ratio,
      seeders: qbt.num_seeds,
      leechers: qbt.num_leechs,
      eta: qbt.eta > 0 && qbt.eta < ETA_UPPER_BOUND_SEC ? qbt.eta : undefined,
      downloadSpeed: qbt.dlspeed,
      addedAt: new Date(qbt.added_on * 1000),
      completedAt: qbt.completion_on > 0 ? new Date(qbt.completion_on * 1000) : undefined,
    };
  }

  private mapState(state: string, savePath: string, contentPath: string | undefined): DownloadItemInfo['status'] {
    const stateMap: Record<string, DownloadItemInfo['status']> = {
      downloading: 'downloading',
      stalledDL: 'downloading',
      metaDL: 'downloading',
      forcedMetaDL: 'downloading',
      forcedDL: 'downloading',
      allocating: 'downloading',
      uploading: 'seeding',
      stalledUP: 'seeding',
      forcedUP: 'seeding',
      pausedDL: 'paused',
      stoppedDL: 'paused',
      pausedUP: 'seeding',
      stoppedUP: 'seeding',
      queuedDL: 'downloading',
      queuedUP: 'seeding',
      checkingDL: 'downloading',
      checkingUP: 'downloading',
      checkingResumeData: 'downloading',
      moving: 'downloading',
      error: 'error',
      missingFiles: 'error',
      unknown: 'error',
    };

    const mapped = stateMap[state] || 'downloading';

    // For seeding states, validate content_path is within save_path
    // to catch the incomplete→complete directory move race condition
    if (mapped === 'seeding' && contentPath) {
      const rel = relative(savePath, contentPath);
      if (rel.startsWith('..') || rel === contentPath) {
        return 'downloading';
      }
    }

    return mapped;
  }
}

