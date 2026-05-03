import type { z } from 'zod';
import type { DownloadClientAdapter, DownloadItemInfo, AddDownloadOptions, DownloadArtifact, DownloadProtocol } from './types.js';
import { transmissionRpcResponseSchema, transmissionSessionGetSchema, transmissionTorrentsArraySchema } from './schemas.js';
import type { transmissionTorrentSchema } from './schemas.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError } from './errors.js';
import { requestWithRetry } from './retry.js';
import { getErrorMessage } from '../../shared/error-message.js';

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

type TransmissionTorrent = z.infer<typeof transmissionTorrentSchema>;

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

  async addDownload(artifact: DownloadArtifact, options?: AddDownloadOptions): Promise<string> {
    if (artifact.type !== 'torrent-bytes' && artifact.type !== 'magnet-uri') {
      throw new DownloadClientError(this.name, 'Transmission only supports torrent artifacts (torrent-bytes, magnet-uri)');
    }

    const args: Record<string, unknown> = {};

    if (artifact.type === 'torrent-bytes') {
      args.metainfo = artifact.data.toString('base64');
    } else {
      args.filename = artifact.uri;
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

    throw new DownloadClientError(this.name, 'Could not extract torrent hash from response');
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const response = await this.rpc('torrent-get', {
      ids: [id],
      fields: [...TORRENT_FIELDS],
    });

    const torrents = this.parseTorrents(response.arguments?.torrents);
    if (torrents.length === 0) {
      return null;
    }

    return this.mapTorrent(torrents[0]!);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const response = await this.rpc('torrent-get', {
      fields: [...TORRENT_FIELDS],
    });

    const torrents = this.parseTorrents(response.arguments?.torrents);
    const mapped = torrents.map((t) => this.mapTorrent(t));

    if (category) {
      return mapped.filter((t) => t.savePath.includes(category));
    }

    return mapped;
  }

  private parseTorrents(raw: unknown): TransmissionTorrent[] {
    if (raw === undefined) return [];
    const parsed = transmissionTorrentsArraySchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `Transmission returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
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
      const parsed = transmissionSessionGetSchema.safeParse(response.arguments ?? {});
      if (!parsed.success) {
        throw new DownloadClientError(
          this.name,
          `Transmission returned unexpected session-get response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      const { version } = parsed.data;
      return {
        success: true,
        message: version ? `Transmission ${version}` : `Connected to ${this.name}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async rpc(method: string, args: Record<string, unknown>): Promise<RpcResponse> {
    let retrySessionId: string | undefined;
    let was409 = false;

    return requestWithRetry(
      async () => {
        was409 = false;
        const response = await fetchWithTimeout(`${this.baseUrl}/transmission/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.authHeader,
            'X-Transmission-Session-Id': this.sessionId,
          },
          body: JSON.stringify({ method, arguments: args }),
        }, DEFAULT_REQUEST_TIMEOUT_MS);

        if (response.status === 409) {
          was409 = true;
          retrySessionId = response.headers.get('X-Transmission-Session-Id') ?? undefined;
          throw new DownloadClientAuthError(this.name, 'Session ID rotation failed: repeated 409');
        }

        if (response.status === 401) {
          throw new DownloadClientAuthError(this.name, 'Authentication failed: invalid credentials');
        }

        if (!response.ok) {
          throw new DownloadClientError(this.name, `HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
          throw new DownloadClientError(this.name, `Connection failed: server didn't respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.`);
        }

        const raw = await response.json();
        const parsed = transmissionRpcResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new DownloadClientError(
            this.name,
            `Transmission returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
            { cause: parsed.error },
          );
        }
        const data = parsed.data as RpcResponse;

        if (data.result !== 'success') {
          throw new DownloadClientError(this.name, `RPC error: ${data.result}`);
        }

        return data;
      },
      {
        clientName: this.name,
        shouldRetry: () => was409,
        onRetry: async () => {
          if (retrySessionId) this.sessionId = retrySessionId;
        },
      },
    );
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
