import { basename, dirname, relative } from 'node:path';
import type { z } from 'zod';
import { type DownloadClientAdapter, type DownloadItemInfo, type AddDownloadOptions, type DownloadArtifact, type DownloadProtocol, ETA_UPPER_BOUND_SEC } from './types.js';
import { qbCategoriesResponseSchema, qbTorrentsResponseSchema } from './schemas.js';
import type { qbTorrentSchema } from './schemas.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError } from './errors.js';
import { externalIdRefusal, normalizeExternalId } from './external-id.js';
import { requestWithRetry } from './retry.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface QBittorrentConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
  // Scopes the hybrid-hash fallback list scan; absent means scan every category.
  category?: string | undefined;
}

type QBTorrent = z.infer<typeof qbTorrentSchema>;

export class QBittorrentClient implements DownloadClientAdapter {
  readonly type = 'qbittorrent';
  readonly name = 'qBittorrent';
  readonly protocol: DownloadProtocol = 'torrent';
  readonly supportsCategories = true;

  private baseUrl: string;
  private cookie?: string | undefined;
  private loginPromise?: Promise<void> | undefined;

  /**
   * Requested hash -> the canonical hash a fallback scan resolved it to (#2433), both lowercased.
   * An INSTANCE field: two clients configured against different qBittorrent hosts must never share
   * entries. `DownloadClientService` caches one adapter per clientId and drops it on a settings
   * change, which is what makes this survive monitor polls and self-clear on reconfiguration.
   *
   * Deliberately uncapped — no LRU, no TTL. The bound is the distinct hashes THIS instance resolved
   * via fallback since the last settings change or restart, trimmed further by removeDownload's
   * eviction; an eviction policy would add its own failure modes to guard nothing.
   */
  private readonly canonicalHashes = new Map<string, string>();

  constructor(private config: QBittorrentConfig) {
    const protocol = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
  }

  private async login(): Promise<void> {
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

    // qBittorrent 5.x may include the WebUI port in the cookie name
    // (e.g. QBT_SID_8080), so keep the cookie name returned by the server.
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const sidMatch = setCookie.match(/(?:^|,\s*)([A-Za-z0-9_-]*SID[A-Za-z0-9_-]*)=([^;]+)/);
      if (sidMatch) {
        this.cookie = `${sidMatch[1]}=${sidMatch[2]}`;
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

      try {
        await this.request('/api/v2/torrents/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData,
        });
      } catch (error: unknown) {
        if (this.isDuplicateAddError(error)) {
          return this.adoptDuplicateOrRethrow(artifact.infoHash, error);
        }
        throw error;
      }

      return artifact.infoHash;
    }

    throw new DownloadClientError(this.name, 'qBittorrent only supports torrent artifacts (torrent-bytes, magnet-uri)');
  }

  // Adopt a 409 only after confirming the same infohash exists. If it disappeared
  // between add and lookup, preserve the original error.
  private async adoptDuplicateOrRethrow(infoHash: string, originalError: unknown): Promise<string> {
    const existing = await this.getDownload(infoHash);
    if (existing) {
      return infoHash;
    }
    throw originalError;
  }

  private isDuplicateAddError(error: unknown): boolean {
    return (
      error instanceof DownloadClientError &&
      error.message.includes('HTTP 409') &&
      error.message.includes('/api/v2/torrents/add')
    );
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

        if (response.status === 409) {
          return this.adoptDuplicateOrRethrow(
            infoHash,
            new DownloadClientError(this.name, `Request failed: HTTP 409 /api/v2/torrents/add`),
          );
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
  private async fetchTorrents(query: string): Promise<QBTorrent[]> {
    const raw = await this.request<unknown>(`/api/v2/torrents/info${query}`);

    // Validate undefined too; empty/non-JSON responses are not an empty torrent list.
    const parsed = qbTorrentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `qBittorrent returned unexpected torrent data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }

    return parsed.data;
  }

  // A hybrid torrent answers to three hashes; empty/absent candidate axes match nothing.
  private isSameTorrent(torrent: QBTorrent, hash: string): boolean {
    const wanted = hash.toLowerCase();
    const candidates = [torrent.hash, torrent.infohash_v1, torrent.infohash_v2?.slice(0, 40)];
    return candidates.some((candidate) => !!candidate && candidate.toLowerCase() === wanted);
  }

  /**
   * The single blank/non-blank decision for the whole adapter: a blank hash never keys the memo
   * (#2433 A9) and, since #2485, never reaches the network either — `resolveTorrent` and the
   * controls both refuse on `undefined`. The lowercasing is qBittorrent-specific (its three hash
   * identities are case-folded on both sides); the blankness rule itself is shared (#2488).
   */
  private memoKey(hash: string): string | undefined {
    return normalizeExternalId(hash)?.toLowerCase();
  }

  /**
   * The canonical-hash filter is the fast path and stays byte-identical for v1-only torrents. On a
   * miss, scan the (optionally category-scoped) list for any of the three identities before
   * concluding the torrent is gone — libtorrent 2.x re-keys a hybrid to its v2 hash (#2423).
   * Once a scan has resolved one, the memo puts it back on the fast path (#2433).
   */
  private async resolveTorrent(hash: string): Promise<QBTorrent | null> {
    const key = this.memoKey(hash);
    // qBittorrent drops empty parts from the `hashes` filter and answers the FULL list, so probing
    // on a blank hash would adopt an arbitrary torrent below. Refuse before any I/O (#2485).
    if (!key) return null;
    const memoized = this.canonicalHashes.get(key);

    const probed = await this.fetchTorrents(`?hashes=${memoized ?? key}`);
    // A memo hit is NOT re-checked against isSameTorrent: a re-keyed hybrid whose client reports
    // `infohash_v1: ""` would fail that check and permanently lose the mapping in exactly the case
    // the memo exists for. Infohashes are content-derived, so a canonical hash that has come to
    // point at unrelated content is not a real failure mode.
    if (probed.length > 0) return probed[0]!;
    // Stale: drop it and rescan on the CALLER's hash, never the memoized one.
    if (memoized) this.canonicalHashes.delete(key);

    const scanned = await this.scanForTorrent(key);
    if (scanned) {
      const canonical = scanned.hash.toLowerCase();
      // An identity mapping already costs one request; only a re-key is worth remembering.
      if (canonical !== key) this.canonicalHashes.set(key, canonical);
    }
    return scanned;
  }

  /**
   * A torrent's real category is whatever it was added under or later moved to, so a miss in the
   * configured one must not read as absence — fall through to exactly ONE unscoped scan (#2433).
   * With no category configured the first scan already is that unscoped scan; issuing it twice
   * would double the cost of every genuine absence.
   */
  private async scanForTorrent(hash: string): Promise<QBTorrent | null> {
    const category = this.config.category;
    if (category) {
      const scoped = await this.fetchTorrents(`?category=${encodeURIComponent(category)}`);
      const hit = scoped.find((torrent) => this.isSameTorrent(torrent, hash));
      if (hit) return hit;
    }

    const scanned = await this.fetchTorrents('');
    return scanned.find((torrent) => this.isSameTorrent(torrent, hash)) ?? null;
  }

  async getDownload(hash: string): Promise<DownloadItemInfo | null> {
    const torrent = await this.resolveTorrent(hash);
    return torrent ? this.mapItem(torrent) : null;
  }

  async getAllDownloads(category = this.config.category): Promise<DownloadItemInfo[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : '';
    const torrents = await this.fetchTorrents(params);
    return torrents.map((t) => this.mapItem(t));
  }

  /**
   * Controls take the same three-identity resolution; an unresolvable hash goes through as-is.
   * A BLANK one does not: qBittorrent would read the empty `hashes` filter as "no filter" and
   * pause/resume/delete an arbitrary torrent. Refusing here — ahead of every caller's
   * `URLSearchParams` construction — is what structurally prevents the POST (#2485).
   */
  private async canonicalHashFor(hash: string): Promise<string> {
    const key = this.memoKey(hash);
    if (!key) throw externalIdRefusal(this.name);
    const torrent = await this.resolveTorrent(key);
    return (torrent?.hash ?? key).toLowerCase();
  }

  async pauseDownload(hash: string): Promise<void> {
    await this.request('/api/v2/torrents/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: await this.canonicalHashFor(hash) }),
    });
  }

  async resumeDownload(hash: string): Promise<void> {
    await this.request('/api/v2/torrents/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: await this.canonicalHashFor(hash) }),
    });
  }

  async removeDownload(hash: string, deleteFiles = false): Promise<void> {
    await this.request('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        hashes: await this.canonicalHashFor(hash),
        deleteFiles: deleteFiles.toString(),
      }),
    });

    // A re-add of the same infohash must start from a clean mapping, and the memo must not keep
    // entries for torrents this app deleted.
    const key = this.memoKey(hash);
    if (key) this.canonicalHashes.delete(key);
  }

  async getCategories(): Promise<string[]> {
    const raw = await this.request<unknown>('/api/v2/torrents/categories');
    const parsed = qbCategoriesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `qBittorrent returned unexpected categories response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return Object.keys(parsed.data);
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
      downloadSpeed: qbt.dlspeed ?? undefined,
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

    // A seeding item outside save_path is still in the incomplete-to-complete move race.
    if (mapped === 'seeding' && contentPath) {
      const rel = relative(savePath, contentPath);
      if (rel.startsWith('..') || rel === contentPath) {
        return 'downloading';
      }
    }

    return mapped;
  }
}

