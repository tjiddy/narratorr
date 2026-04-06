import { type DownloadClientAdapter, type DownloadItemInfo, type AddDownloadOptions, type DownloadProtocol, ETA_UPPER_BOUND_SEC } from './types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';

export interface DelugeConfig {
  host: string;
  port: number;
  password: string;
  useSsl: boolean;
  onWarn?: (msg: string) => void;
}

interface DelugeRpcResponse {
  id: number;
  result: unknown;
  error: { message: string; code: number } | null;
}

interface DelugeTorrentStatus {
  hash: string;
  name: string;
  state: string;
  progress: number;
  total_size: number;
  total_done: number;
  total_uploaded: number;
  ratio: number;
  num_seeds: number;
  num_peers: number;
  eta: number;
  save_path: string;
  time_added: number;
  label?: string;
  is_finished: boolean;
}

const TORRENT_STATUS_KEYS = [
  'hash', 'name', 'state', 'progress', 'total_size',
  'total_done', 'total_uploaded', 'ratio', 'num_seeds',
  'num_peers', 'eta', 'save_path', 'time_added', 'label',
  'is_finished',
];

export class DelugeClient implements DownloadClientAdapter {
  readonly type = 'deluge';
  readonly name = 'Deluge';
  readonly protocol: DownloadProtocol = 'torrent';
  readonly supportsCategories = true;

  private baseUrl: string;
  private authenticated = false;
  private sessionCookie: string | null = null;
  private requestId = 0;

  constructor(private config: DelugeConfig) {
    const protocol = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
  }

  private async rpc(method: string, params: unknown[] = [], retried = false): Promise<unknown> {
    if (!this.authenticated) {
      await this.login();
    }

    const id = ++this.requestId;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionCookie) {
      headers.Cookie = this.sessionCookie;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params, id }),
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if ((response.status === 401 || response.status === 403) && !retried) {
      this.authenticated = false;
      await this.login();
      return this.rpc(method, params, true);
    }

    if (!response.ok) {
      throw new Error(`Deluge request failed: HTTP ${response.status}`);
    }

    let data: DelugeRpcResponse;
    try {
      data = await response.json() as DelugeRpcResponse;
    } catch {
      throw new Error('Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy that may be intercepting requests.');
    }

    if (data.error) {
      // Session expired — auth error from Deluge itself
      if (!retried && data.error.code === 1) {
        this.authenticated = false;
        await this.login();
        return this.rpc(method, params, true);
      }
      throw new Error(`Deluge RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  private async login(): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'auth.login',
        params: [this.config.password],
        id: ++this.requestId,
      }),
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`Deluge login failed: HTTP ${response.status}`);
    }

    let data: DelugeRpcResponse;
    try {
      data = await response.json() as DelugeRpcResponse;
    } catch {
      throw new Error('Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy that may be intercepting requests.');
    }

    if (data.error) {
      throw new Error(`Deluge login error: ${data.error.message}`);
    }

    if (data.result !== true) {
      throw new Error('Deluge login failed: Invalid password');
    }

    // Persist session cookie for subsequent authenticated requests
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.sessionCookie = setCookie.split(';')[0];
    }

    this.authenticated = true;
  }

  async addDownload(url: string, options?: AddDownloadOptions): Promise<string> {
    const addOptions: Record<string, unknown> = {};
    if (options?.savePath) {
      addOptions.download_location = options.savePath;
    }
    if (options?.paused) {
      addOptions.add_paused = true;
    }

    const torrentId = await this.addTorrent(url, addOptions, options?.torrentFile);

    // Try to set label (category) — graceful fallback if plugin unavailable
    if (options?.category) {
      try {
        await this.rpc('label.set_torrent', [torrentId, options.category]);
      } catch {
        this.config.onWarn?.(`Label plugin not available — category '${options.category}' was not set on torrent ${torrentId}`);
      }
    }

    return torrentId;
  }

  private async addTorrent(url: string, addOptions: Record<string, unknown>, torrentFile?: Buffer): Promise<string> {
    let result: unknown;

    if (torrentFile) {
      const fileContent = torrentFile.toString('base64');
      result = await this.rpc('core.add_torrent_file', ['upload.torrent', fileContent, addOptions]);
    } else if (url.startsWith('magnet:')) {
      result = await this.rpc('core.add_torrent_magnet', [url, addOptions]);
    } else {
      result = await this.rpc('core.add_torrent_url', [url, addOptions]);
    }

    if (!result || typeof result !== 'string') {
      throw new Error('Deluge returned no torrent hash');
    }

    return result;
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const result = await this.rpc('core.get_torrent_status', [id, TORRENT_STATUS_KEYS]) as Record<string, unknown> | null;

    if (!result || Object.keys(result).length === 0) {
      return null;
    }

    return this.mapTorrent(id, result as unknown as DelugeTorrentStatus);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const filterDict: Record<string, unknown> = {};
    if (category) {
      filterDict.label = category;
    }

    const result = await this.rpc('core.get_torrents_status', [filterDict, TORRENT_STATUS_KEYS]) as Record<string, Record<string, unknown>> | null;

    if (!result) return [];

    return Object.entries(result).map(([hash, torrent]) =>
      this.mapTorrent(hash, torrent as unknown as DelugeTorrentStatus)
    );
  }

  async pauseDownload(id: string): Promise<void> {
    await this.rpc('core.pause_torrent', [[id]]);
  }

  async resumeDownload(id: string): Promise<void> {
    await this.rpc('core.resume_torrent', [[id]]);
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    await this.rpc('core.remove_torrent', [id, deleteFiles]);
  }

  async getCategories(): Promise<string[]> {
    try {
      const result = await this.rpc('label.get_labels') as string[] | null;
      return result ?? [];
    } catch {
      // Label plugin not installed
      return [];
    }
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.login();
      const version = await this.rpc('daemon.info') as string;
      return { success: true, message: `Deluge ${version}` };
    } catch (error: unknown) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private mapTorrent(hash: string, t: DelugeTorrentStatus): DownloadItemInfo {
    return {
      id: hash,
      name: t.name,
      progress: Math.round(t.progress),
      status: this.mapState(t.state, t.is_finished),
      savePath: t.save_path,
      size: t.total_size,
      downloaded: t.total_done,
      uploaded: t.total_uploaded,
      ratio: t.ratio,
      seeders: t.num_seeds,
      leechers: t.num_peers,
      eta: t.eta > 0 && t.eta < ETA_UPPER_BOUND_SEC ? t.eta : undefined,
      addedAt: new Date(t.time_added * 1000),
    };
  }

  private mapState(state: string, isFinished: boolean): DownloadItemInfo['status'] {
    if (state === 'Error') return 'error';
    if (state === 'Moving') return 'downloading';
    if (isFinished && state !== 'Checking' && state !== 'Moving') return 'completed';
    if (state === 'Paused') return 'paused';
    return 'downloading';
  }
}
