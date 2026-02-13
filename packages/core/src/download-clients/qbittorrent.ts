import type { DownloadClientAdapter, DownloadItemInfo, AddDownloadOptions, DownloadProtocol } from './types.js';

export interface QBittorrentConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;

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
  added_on: number;
  completion_on: number;
}

export class QBittorrentClient implements DownloadClientAdapter {
  readonly type = 'qbittorrent';
  readonly name = 'qBittorrent';
  readonly protocol: DownloadProtocol = 'torrent';

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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.baseUrl,
        },
        body: new URLSearchParams({
          username: this.config.username,
          password: this.config.password,
        }),
        signal: controller.signal,
      });

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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
    if (!this.cookie) {
      await this.login();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          Cookie: this.cookie!,
          Referer: this.baseUrl,
        },
        signal: controller.signal,
      });

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

      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async addDownload(url: string, options?: AddDownloadOptions): Promise<string> {
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

  async getDownload(hash: string): Promise<DownloadItemInfo | null> {
    const torrents = await this.request<QBTorrent[]>(
      `/api/v2/torrents/info?hashes=${hash.toLowerCase()}`
    );

    if (!torrents || torrents.length === 0) {
      return null;
    }

    return this.mapItem(torrents[0]);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : '';
    const torrents = await this.request<QBTorrent[]>(`/api/v2/torrents/info${params}`);

    if (!torrents) {
      return [];
    }

    return torrents.map((t) => this.mapItem(t));
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

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.login();
      const version = await this.request<string>('/api/v2/app/version');
      return { success: true, message: `qBittorrent ${version}` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private mapItem(qbt: QBTorrent): DownloadItemInfo {
    return {
      id: qbt.hash,
      name: qbt.name,
      progress: Math.round(qbt.progress * 100),
      status: this.mapState(qbt.state),
      savePath: qbt.save_path,
      size: qbt.total_size,
      downloaded: qbt.downloaded,
      uploaded: qbt.uploaded,
      ratio: qbt.ratio,
      seeders: qbt.num_seeds,
      leechers: qbt.num_leechs,
      eta: qbt.eta > 0 && qbt.eta < 8640000 ? qbt.eta : undefined,
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
