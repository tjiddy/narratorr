import type { DownloadClientAdapter, DownloadItemInfo, AddDownloadOptions, DownloadProtocol } from './types.js';
import { transmissionRpcResponseSchema } from './schemas.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';

export interface TransmissionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
}

const TORRENT_FIELDS = [
  'hashString',
  'name',
  'status',
  'percentDone',
  'totalSize',
  'downloadedEver',
  'uploadedEver',
  'uploadRatio',
  'peersSendingToUs',
  'peersGettingFromUs',
  'eta',
  'downloadDir',
  'addedDate',
  'doneDate',
  'errorString',
  'leftUntilDone',
] as const;

interface TransmissionTorrent {
  hashString: string;
  name: string;
  status: number;
  percentDone: number;
  totalSize: number;
  downloadedEver: number;
  uploadedEver: number;
  uploadRatio: number;
  peersSendingToUs: number;
  peersGettingFromUs: number;
  eta: number;
  downloadDir: string;
  addedDate: number;
  doneDate: number;
  errorString: string;
  leftUntilDone: number;
}

interface RpcResponse {
  result: string;
  arguments?: Record<string, unknown>;
}

export class TransmissionClient implements DownloadClientAdapter {
  readonly type = 'transmission';
  readonly name = 'Transmission';
  readonly protocol: DownloadProtocol = 'torrent';
  readonly supportsCategories = false;

  private baseUrl: string;
  private sessionId = '';
  private authHeader: string;

  constructor(config: TransmissionConfig) {
    const protocol = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this.authHeader = 'Basic ' + btoa(`${config.username}:${config.password}`);
  }

  async addDownload(url: string, options?: AddDownloadOptions): Promise<string> {
    const args: Record<string, unknown> = {};

    // Torrent file path — use metainfo base64 parameter
    if (options?.torrentFile) {
      args.metainfo = options.torrentFile.toString('base64');
    } else {
      args.filename = url;
    }

    if (options?.savePath) {
      args['download-dir'] = options.savePath;
    }
    if (options?.paused) {
      args.paused = true;
    }

    const response = await this.rpc('torrent-add', args);
    const added = (response.arguments?.['torrent-added'] || response.arguments?.['torrent-duplicate']) as
      | { hashString: string }
      | undefined;

    if (added?.hashString) {
      return added.hashString.toLowerCase();
    }

    throw new Error('Could not extract torrent hash from response');
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const response = await this.rpc('torrent-get', {
      ids: [id],
      fields: [...TORRENT_FIELDS],
    });

    const torrents = (response.arguments?.torrents || []) as TransmissionTorrent[];
    if (torrents.length === 0) {
      return null;
    }

    return this.mapTorrent(torrents[0]);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const response = await this.rpc('torrent-get', {
      fields: [...TORRENT_FIELDS],
    });

    const torrents = (response.arguments?.torrents || []) as TransmissionTorrent[];
    const mapped = torrents.map((t) => this.mapTorrent(t));

    if (category) {
      return mapped.filter((t) => t.savePath.includes(category));
    }

    return mapped;
  }

  async pauseDownload(id: string): Promise<void> {
    await this.rpc('torrent-stop', { ids: [id] });
  }

  async resumeDownload(id: string): Promise<void> {
    await this.rpc('torrent-start', { ids: [id] });
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    await this.rpc('torrent-remove', {
      ids: [id],
      'delete-local-data': deleteFiles,
    });
  }

  async getCategories(): Promise<string[]> {
    return [];
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.rpc('session-get', {});
      const version = response.arguments?.version as string | undefined;
      return {
        success: true,
        message: version ? `Transmission ${version}` : `Connected to ${this.name}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private async rpc(method: string, args: Record<string, unknown>, retried = false): Promise<RpcResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}/transmission/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
        'X-Transmission-Session-Id': this.sessionId,
      },
      body: JSON.stringify({ method, arguments: args }),
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (response.status === 409 && !retried) {
      const newSessionId = response.headers.get('X-Transmission-Session-Id');
      if (newSessionId) {
        this.sessionId = newSessionId;
      }
      return this.rpc(method, args, true);
    }

    if (response.status === 409) {
      throw new Error('Session ID rotation failed: repeated 409');
    }

    if (response.status === 401) {
      throw new Error('Authentication failed: invalid credentials');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      throw new Error(`Connection failed: server didn't respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.`);
    }

    const raw = await response.json();
    const parsed = transmissionRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Transmission returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    const data = parsed.data as RpcResponse;

    if (data.result !== 'success') {
      throw new Error(`RPC error: ${data.result}`);
    }

    return data;
  }

  private mapTorrent(t: TransmissionTorrent): DownloadItemInfo {
    return {
      id: t.hashString,
      name: t.name,
      progress: Math.round(t.percentDone * 100),
      status: this.mapStatus(t),
      savePath: t.downloadDir,
      size: t.totalSize,
      downloaded: t.downloadedEver,
      uploaded: t.uploadedEver,
      ratio: t.uploadRatio,
      seeders: t.peersSendingToUs,
      leechers: t.peersGettingFromUs,
      eta: t.eta > 0 ? t.eta : undefined,
      addedAt: new Date(t.addedDate * 1000),
      completedAt: t.doneDate > 0 ? new Date(t.doneDate * 1000) : undefined,
    };
  }

  private mapStatus(t: TransmissionTorrent): DownloadItemInfo['status'] {
    // errorString takes precedence over all other fields
    if (t.errorString) return 'error';
    // No metadata yet — still resolving
    if (t.totalSize === 0) return 'downloading';
    // leftUntilDone is the authoritative completion signal
    if (t.leftUntilDone === 0) {
      // Transmission status codes: 0 = stopped, 5 = seed-wait, 6 = seeding
      if (t.status === 0) return 'completed';
      if (t.status === 5 || t.status === 6) return 'seeding';
    }
    // Active download or other states
    return 'downloading';
  }
}
