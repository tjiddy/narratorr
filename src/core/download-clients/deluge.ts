import type { z } from 'zod';
import { type DownloadClientAdapter, type DownloadItemInfo, type AddDownloadOptions, type DownloadArtifact, type DownloadProtocol, ETA_UPPER_BOUND_SEC } from './types.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError } from './errors.js';
import { requestWithRetry } from './retry.js';
import { getErrorMessage } from '../../shared/error-message.js';
import {
  delugeRpcResponseSchema,
  delugeTorrentStatusSchema,
  delugeTorrentsStatusMapSchema,
} from './schemas.js';

export interface DelugeConfig {
  host: string;
  port: number;
  password: string;
  useSsl: boolean;
  onWarn?: ((msg: string) => void) | undefined;
}

type DelugeTorrentStatus = z.infer<typeof delugeTorrentStatusSchema>;
type DelugeRpcEnvelope = z.infer<typeof delugeRpcResponseSchema>;

const TORRENT_STATUS_KEYS = [
  'hash', 'name', 'state', 'progress', 'total_size',
  'total_done', 'total_uploaded', 'ratio', 'num_seeds',
  'num_peers', 'eta', 'download_rate', 'save_path', 'time_added', 'label',
  'is_finished',
];

const NO_DAEMON_MESSAGE =
  'Deluge WebUI is not connected to a daemon. Open Deluge’s Connection Manager and configure (and connect to) a daemon host, then try again.';

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

  private async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    let wasAuthFailure = false;

    return requestWithRetry(
      async () => {
        wasAuthFailure = false;

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

        if (response.status === 401 || response.status === 403) {
          wasAuthFailure = true;
          throw new DownloadClientAuthError(this.name, `Deluge request failed: HTTP ${response.status}`);
        }

        const data = await this.parseRpcResponse(response);

        if (data.error) {
          if (data.error.code === 1) {
            wasAuthFailure = true;
            throw new DownloadClientAuthError(this.name, `Deluge session expired: ${data.error.message}`);
          }
          throw new DownloadClientError(this.name, `Deluge RPC error: ${data.error.message}`);
        }

        return data.result;
      },
      {
        clientName: this.name,
        shouldRetry: () => wasAuthFailure,
        onRetry: async () => {
          this.authenticated = false;
          await this.login();
        },
      },
    );
  }

  /**
   * Issue a JSON-RPC call WITHOUT the auth gate that `rpc()` applies. Reuses the
   * persisted session cookie from `login()`. The auth handshake (web.*) must use
   * this rather than `rpc()` — `rpc()` calls `login()` when `!this.authenticated`,
   * which would recurse back into the handshake.
   */
  private async rawRpc(method: string, params: unknown[] = []): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionCookie) {
      headers.Cookie = this.sessionCookie;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params, id: ++this.requestId }),
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    const data = await this.parseRpcResponse(response);
    if (data.error) {
      throw new DownloadClientError(this.name, `Deluge RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Shared, policy-free response pipeline for `rpc()` and `rawRpc()`: HTTP
   * status check, JSON decode, and schema validation. Returns the validated
   * envelope and performs NO `data.error` interpretation — each caller keeps
   * its own `data.error` policy (auth-retry in `rpc()`, plain throw in
   * `rawRpc()`). `rpc()`'s 401/403 auth pre-check also stays caller-side,
   * ahead of this helper's generic `!response.ok` branch.
   */
  private async parseRpcResponse(response: Response): Promise<DelugeRpcEnvelope> {
    if (!response.ok) {
      throw new DownloadClientError(this.name, `Deluge request failed: HTTP ${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new DownloadClientError(this.name, 'Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy that may be intercepting requests.');
    }

    const parsed = delugeRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `Deluge returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  /**
   * `auth.login` only authenticates to the web server — it does NOT connect the
   * web server to a daemon. Daemon-proxied methods (`daemon.*`, `core.*`) are
   * absent from the callable-method map until a daemon is connected, so they fail
   * with "Unknown method". Ensure a daemon is connected before any such call.
   */
  private async ensureDaemonConnected(): Promise<void> {
    const connected = await this.rawRpc('web.connected');
    if (connected === true) {
      return;
    }

    const hosts = await this.rawRpc('web.get_hosts');
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new DownloadClientError(this.name, NO_DAEMON_MESSAGE);
    }

    const firstHost = hosts[0];
    if (!Array.isArray(firstHost) || typeof firstHost[0] !== 'string' || firstHost[0].length === 0) {
      throw new DownloadClientError(this.name, NO_DAEMON_MESSAGE);
    }

    await this.rawRpc('web.connect', [firstHost[0]]);
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
      throw new DownloadClientError(this.name, `Deluge login failed: HTTP ${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new DownloadClientError(this.name, 'Connection failed: server didn\'t respond as expected. Check host, port, SSL settings, and any reverse proxy that may be intercepting requests.');
    }

    const parsed = delugeRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `Deluge returned unexpected login response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    const data = parsed.data;

    if (data.error) {
      throw new DownloadClientAuthError(this.name, `Deluge login error: ${data.error.message}`);
    }

    if (data.result !== true) {
      throw new DownloadClientAuthError(this.name, 'Deluge login failed: Invalid password');
    }

    // Persist session cookie for subsequent authenticated requests
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.sessionCookie = setCookie.split(';')[0]!;
    }

    // auth.login only authenticates to the web server — connect it to a daemon
    // before any daemon.*/core.* call. Reuses the cookie just persisted above.
    await this.ensureDaemonConnected();

    this.authenticated = true;
  }

  async addDownload(artifact: DownloadArtifact, options?: AddDownloadOptions): Promise<string> {
    if (artifact.type !== 'torrent-bytes' && artifact.type !== 'magnet-uri') {
      throw new DownloadClientError(this.name, 'Deluge only supports torrent artifacts (torrent-bytes, magnet-uri)');
    }

    const addOptions: Record<string, unknown> = {};
    if (options?.savePath) {
      addOptions.download_location = options.savePath;
    }
    if (options?.paused) {
      addOptions.add_paused = true;
    }

    const torrentId = await this.addTorrent(artifact, addOptions);

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

  private async addTorrent(artifact: Extract<DownloadArtifact, { type: 'torrent-bytes' } | { type: 'magnet-uri' }>, addOptions: Record<string, unknown>): Promise<string> {
    try {
      let result: unknown;

      if (artifact.type === 'torrent-bytes') {
        const fileContent = artifact.data.toString('base64');
        result = await this.rpc('core.add_torrent_file', ['upload.torrent', fileContent, addOptions]);
      } else {
        result = await this.rpc('core.add_torrent_magnet', [artifact.uri, addOptions]);
      }

      if (!result || typeof result !== 'string') {
        throw new DownloadClientError(this.name, 'Deluge returned no torrent hash');
      }

      return result;
    } catch (error: unknown) {
      // Duplicate-add: Deluge raises an AddTorrentError ("Torrent already in
      // session") which rpc() surfaces as a thrown DownloadClientError. The
      // torrent the daemon already holds IS the release we wanted (matched by
      // infohash), so adopt it — confirm it is present, then return its infohash
      // so the grab persists a normal tracked download for the monitor to drive
      // to completion. Mirror Transmission's torrent-duplicate handling.
      if (this.isDuplicateAddError(error)) {
        const existing = await this.getDownload(artifact.infoHash);
        if (existing) {
          return artifact.infoHash;
        }
      }
      throw error;
    }
  }

  /**
   * Detect Deluge's duplicate-add signal. A duplicate `core.add_torrent_*`
   * returns `error.code === 4` (generic "RPC call failure") with an
   * `AddTorrentError` / "already in session" message — so the match must be
   * scoped to the message substrings, NOT `code 4` alone.
   */
  private isDuplicateAddError(error: unknown): boolean {
    return (
      error instanceof DownloadClientError &&
      (error.message.includes('AddTorrentError') || error.message.includes('already in session'))
    );
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const result = await this.rpc('core.get_torrent_status', [id, TORRENT_STATUS_KEYS]);

    if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
      return null;
    }

    const parsed = delugeTorrentStatusSchema.safeParse(result);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `Deluge returned unexpected torrent-status response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return this.mapTorrent(id, parsed.data);
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const filterDict: Record<string, unknown> = {};
    if (category) {
      filterDict.label = category;
    }

    const result = await this.rpc('core.get_torrents_status', [filterDict, TORRENT_STATUS_KEYS]);

    if (!result) return [];

    const parsed = delugeTorrentsStatusMapSchema.safeParse(result);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `Deluge returned unexpected torrents-status response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }

    return Object.entries(parsed.data).map(([hash, torrent]) =>
      this.mapTorrent(hash, torrent),
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
      const version = await this.rpc('daemon.get_version') as string;
      return { success: true, message: `Deluge ${version}` };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
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
      downloadSpeed: t.download_rate,
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
