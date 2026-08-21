import { dirname, basename } from 'node:path';
import { nzbgetRpcResponseSchema, nzbgetGroupSchema, nzbgetHistorySchema } from './schemas.js';
import type {
  DownloadClientAdapter,
  DownloadItemInfo,
  AddDownloadOptions,
  DownloadArtifact,
  DownloadProtocol,
} from './types.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { externalIdRefusal, normalizeExternalId } from './external-id.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface NZBGetConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
}

import { z } from 'zod';

type NZBGetGroup = z.infer<typeof nzbgetGroupSchema>;
type NZBGetHistoryItem = z.infer<typeof nzbgetHistorySchema>;

// DestDir is the full download folder; split it into the import contract's parent/name.
// Guard empty first because dirname('') returns the truthy value '.'.
function splitDest(dest: string | undefined, fallbackName: string): { savePath: string; name: string } {
  if (!dest) return { savePath: '', name: fallbackName };
  return { savePath: dirname(dest), name: basename(dest) };
}

export class NZBGetClient implements DownloadClientAdapter {
  readonly type = 'nzbget';
  readonly name = 'NZBGet';
  readonly protocol: DownloadProtocol = 'usenet';
  readonly supportsCategories = true;

  private rpcUrl: string;
  private authHeader: string;

  constructor(config: NZBGetConfig) {
    const scheme = config.useSsl ? 'https' : 'http';
    this.rpcUrl = `${scheme}://${config.host}:${config.port}/jsonrpc`;
    this.authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;
  }

  async addDownload(
    artifact: DownloadArtifact,
    options?: AddDownloadOptions,
  ): Promise<string> {
    if (artifact.type !== 'nzb-url' && artifact.type !== 'nzb-bytes') {
      throw new DownloadClientError(this.name, 'NZBGet only supports usenet artifacts (nzb-url, nzb-bytes)');
    }

    if (artifact.type === 'nzb-bytes') {
      if (artifact.data.length === 0) {
        throw new DownloadClientError(this.name, 'Cannot add empty NZB file');
      }
      return this.appendNzb('upload.nzb', artifact.data.toString('base64'), options);
    }

    return this.appendNzb('', artifact.url, options);
  }

  private async appendNzb(
    filename: string,
    content: string,
    options?: AddDownloadOptions,
  ): Promise<string> {
    const params = [
      filename,
      content,
      options?.category || '',
      options?.paused ? -1 : 0,
      false,
      false,
      '',
      0,
      'score',
    ];

    const result = await this.rpc<number>('append', params);

    if (!result || result <= 0) {
      throw new DownloadClientError(this.name, 'NZBGet failed to add download');
    }

    return String(result);
  }

  /**
   * NZBGet addresses downloads by integer NZBID and `editqueue` takes an explicit IDs array with
   * no empty-means-all axis, so the danger here is mis-resolution rather than widening. `parseInt`
   * made two ids unsafe: a blank one became `NaN`, which `JSON.stringify` serializes as `null` in
   * the IDs array, and `'12abc'` became a plausible NZBID 12 naming an unrelated real download
   * ([[parsefloat-grouped-number-truncation]]). Requiring an exact non-negative integer after
   * trimming keeps today's padding tolerance while removing both (#2488).
   */
  private parseNzbId(id: string): number | undefined {
    const normalized = normalizeExternalId(id);
    if (normalized === undefined || !/^\d+$/.test(normalized)) return undefined;
    return Number(normalized);
  }

  /** Reads return `null`; only controls throw — `monitor` escalates a thrown read as infra. */
  private requireNzbId(id: string): number {
    const nzbId = this.parseNzbId(id);
    if (nzbId === undefined) {
      throw externalIdRefusal(this.name, 'it is blank or is not a non-negative integer NZBID');
    }
    return nzbId;
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const nzbId = this.parseNzbId(id);
    if (nzbId === undefined) return null;

    const rawGroups = await this.rpc<unknown[]>('listgroups');
    const groups = this.parseGroups(rawGroups);
    const group = groups.find((g) => g.NZBID === nzbId);
    if (group) {
      return this.mapGroup(group);
    }

    const rawHistory = await this.rpc<unknown[]>('history', [false]);
    const history = this.parseHistory(rawHistory);
    const histItem = history.find((h) => h.NZBID === nzbId);
    if (histItem) {
      return this.mapHistoryItem(histItem);
    }

    return null;
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const [rawGroups, rawHistory] = await Promise.all([
      this.rpc<unknown[]>('listgroups'),
      this.rpc<unknown[]>('history', [false]),
    ]);

    const groups = this.parseGroups(rawGroups);
    const history = this.parseHistory(rawHistory);

    const items: DownloadItemInfo[] = [];

    for (const group of groups) {
      if (category && group.Category !== category) continue;
      items.push(this.mapGroup(group));
    }
    for (const histItem of history) {
      if (category && histItem.Category !== category) continue;
      items.push(this.mapHistoryItem(histItem));
    }

    return items;
  }

  async pauseDownload(id: string): Promise<void> {
    await this.rpc('editqueue', ['GroupPause', '', [this.requireNzbId(id)]]);
  }

  async resumeDownload(id: string): Promise<void> {
    await this.rpc('editqueue', ['GroupResume', '', [this.requireNzbId(id)]]);
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    const nzbId = this.requireNzbId(id);
    const command = deleteFiles ? 'GroupFinalDelete' : 'GroupDelete';
    await this.rpc('editqueue', [command, '', [nzbId]]);
  }

  async getCategories(): Promise<string[]> {
    const config = await this.rpc<Array<{ Name: string; Value: string }>>('config');
    return (config ?? [])
      .filter((item) => /^Category\d+\.Name$/.test(item.Name))
      .map((item) => item.Value)
      .filter(Boolean);
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const version = await this.rpc<string>('version');

      return {
        success: true,
        message: `NZBGet ${version}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          method,
          params,
        }),
      }, DEFAULT_REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      if (isTimeoutError(error)) throw new DownloadClientTimeoutError(this.name, (error as Error).message);
      throw new DownloadClientError(this.name, getErrorMessage(error));
    }

    if (response.status === 401) {
      throw new DownloadClientAuthError(this.name, `Authentication failed: invalid credentials`);
    }

    if (!response.ok) {
      throw new DownloadClientError(this.name, `HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      throw new DownloadClientError(this.name, `Connection failed: server didn't respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.`);
    }

    const json = await response.json();
    const parsed = nzbgetRpcResponseSchema.safeParse(json);

    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `NZBGet returned unexpected response: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }

    if (parsed.data.error) {
      const { message, code, name } = parsed.data.error;
      const detail = message || `${name} (code ${code})`;
      throw new DownloadClientError(this.name, `NZBGet RPC error: ${detail}`);
    }

    return parsed.data.result as T;
  }

  private parseGroups(raw: unknown): NZBGetGroup[] {
    const parsed = z.array(nzbgetGroupSchema).safeParse(raw ?? []);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `NZBGet returned unexpected listgroups response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private parseHistory(raw: unknown): NZBGetHistoryItem[] {
    const parsed = z.array(nzbgetHistorySchema).safeParse(raw ?? []);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `NZBGet returned unexpected history response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private mapGroup(group: NZBGetGroup): DownloadItemInfo {
    const sizeMb = group.FileSizeMB || 0;
    const downloadedMb = group.DownloadedSizeMB || 0;
    const size = Math.round(sizeMb * 1024 * 1024);
    const downloaded = Math.round(downloadedMb * 1024 * 1024);
    const progress = sizeMb > 0 ? Math.round((downloadedMb / sizeMb) * 100) : 0;

    const remainingMb = group.RemainingSizeMB || 0;
    let speedMbps: number | undefined;
    if (group.DownloadTimeSec > 0 && downloadedMb > 0) {
      speedMbps = downloadedMb / group.DownloadTimeSec;
    }
    const eta = remainingMb > 0 && speedMbps !== undefined && speedMbps > 0
      ? Math.round(remainingMb / speedMbps)
      : undefined;
    const downloadSpeed = speedMbps !== undefined
      ? Math.round(speedMbps * 1024 * 1024)
      : undefined;

    const { savePath, name } = splitDest(group.DestDir, group.NZBName);

    return {
      id: String(group.NZBID),
      name,
      progress,
      status: this.mapGroupStatus(group.Status),
      savePath,
      size,
      downloaded,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      eta,
      downloadSpeed,
      addedAt: group.MinPostTime
        ? new Date(group.MinPostTime * 1000)
        : new Date(),
      completedAt: undefined,
    };
  }

  private mapHistoryItem(item: NZBGetHistoryItem): DownloadItemInfo {
    const size = Math.round((item.FileSizeMB || 0) * 1024 * 1024);
    const status = this.mapHistoryStatus(item);
    const { savePath, name } = splitDest(item.DestDir, item.Name);

    return {
      id: String(item.NZBID),
      name,
      progress: status === 'error' ? 0 : 100,
      status,
      savePath,
      size,
      downloaded: size,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      addedAt: item.MinPostTime
        ? new Date(item.MinPostTime * 1000)
        : new Date(),
      completedAt: item.HistoryTime
        ? new Date(item.HistoryTime * 1000)
        : undefined,
    };
  }

  private mapGroupStatus(status: string): DownloadItemInfo['status'] {
    const upper = status.toUpperCase();
    if (upper === 'PAUSED') return 'paused';
    if (upper.startsWith('PP_') || upper === 'DOWNLOADING' || upper === 'FETCHING' || upper === 'QUEUED' || upper === 'LOADING')
      return 'downloading';
    return 'downloading';
  }

  private mapHistoryStatus(item: NZBGetHistoryItem): DownloadItemInfo['status'] {
    const upper = item.Status.toUpperCase();
    if (upper.startsWith('FAILURE') || upper.startsWith('DELETED')) return 'error';

    // SUCCESS and WARNING are terminal; post-processing fields decide degradation.
    if (upper.startsWith('SUCCESS') || upper.startsWith('WARNING')) {
      if (
        postProcFailed(item.ParStatus ?? undefined) ||
        postProcFailed(item.UnpackStatus ?? undefined) ||
        postProcFailed(item.MoveStatus ?? undefined) ||
        postProcFailed(item.ScriptStatus ?? undefined)
      )
        return 'error';
      return 'completed';
    }

    // Unknown future statuses must never auto-import.
    return 'downloading';
  }
}

function postProcFailed(value: string | undefined): boolean {
  if (!value) return false;
  const upper = value.toUpperCase();
  return upper !== 'SUCCESS' && upper !== 'NONE';
}
