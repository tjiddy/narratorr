import { dirname, basename } from 'node:path';
import type { z } from 'zod';
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
import {
  sabnzbdQueueResponseSchema,
  sabnzbdHistoryResponseSchema,
  sabnzbdVersionResponseSchema,
  sabnzbdAddResponseSchema,
  sabnzbdCategoriesResponseSchema,
} from './schemas.js';
import type {
  sabnzbdQueueSlotSchema,
  sabnzbdHistorySlotSchema,
} from './schemas.js';

const SABNZBD_LIST_LIMIT = '1000';

// storage is the full destination folder; split it into the import contract's parent/name.
function splitStorage(storage: string | undefined, fallbackName: string): { parent: string; base: string } {
  if (!storage) return { parent: '', base: fallbackName };
  return { parent: dirname(storage), base: basename(storage) };
}

// SABnzbd reports binary KiB/s. Preserve zero as stalled; invalid values are unreported.
function parseKbpersec(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const kib = parseFloat(raw);
  if (!Number.isFinite(kib)) return undefined;
  return kib * 1024;
}

export interface SABnzbdConfig {
  host: string;
  port: number;
  apiKey: string;
  useSsl: boolean;
}

type SABnzbdQueueSlot = z.infer<typeof sabnzbdQueueSlotSchema>;
type SABnzbdHistorySlot = z.infer<typeof sabnzbdHistorySlotSchema>;

export class SABnzbdClient implements DownloadClientAdapter {
  readonly type = 'sabnzbd';
  readonly name = 'SABnzbd';
  readonly protocol: DownloadProtocol = 'usenet';
  readonly supportsCategories = true;

  private baseUrl: string;
  private apiKey: string;

  constructor(config: SABnzbdConfig) {
    const scheme = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${scheme}://${config.host}:${config.port}`;
    this.apiKey = config.apiKey;
  }

  async addDownload(
    artifact: DownloadArtifact,
    options?: AddDownloadOptions,
  ): Promise<string> {
    if (artifact.type !== 'nzb-url' && artifact.type !== 'nzb-bytes') {
      throw new DownloadClientError(this.name, 'SABnzbd only supports usenet artifacts (nzb-url, nzb-bytes)');
    }

    if (artifact.type === 'nzb-bytes') {
      return this.addDownloadFromBytes(artifact.data, options);
    }

    const params: Record<string, string> = {
      mode: 'addurl',
      name: artifact.url,
    };

    if (options?.category) {
      params.cat = options.category;
    }
    if (options?.paused) {
      params.priority = '-1'; // SABnzbd: -1 = paused
    }

    const response = this.parseAddResponse(await this.request<unknown>(params));

    if (!response.status || !response.nzo_ids.length) {
      throw new DownloadClientError(this.name, 'SABnzbd failed to add download');
    }

    return response.nzo_ids[0]!;
  }

  private async addDownloadFromBytes(
    data: Buffer,
    options?: AddDownloadOptions,
  ): Promise<string> {
    if (data.length === 0) {
      throw new DownloadClientError(this.name, 'Cannot add empty NZB file');
    }

    const url = new URL('/api', this.baseUrl);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('output', 'json');
    url.searchParams.set('mode', 'addlocalfile');

    if (options?.category) {
      url.searchParams.set('cat', options.category);
    }
    if (options?.paused) {
      url.searchParams.set('priority', '-1');
    }

    const formData = new FormData();
    formData.append(
      'name',
      new Blob([new Uint8Array(data)], { type: 'application/x-nzb' }),
      'upload.nzb',
    );

    const result = this.parseAddResponse(await this.fetchApi<unknown>(url.toString(), {
      method: 'POST',
      body: formData,
    }));

    if (!result.status || !result.nzo_ids.length) {
      throw new DownloadClientError(this.name, 'SABnzbd failed to add download');
    }

    return result.nzo_ids[0]!;
  }

  private parseAddResponse(raw: unknown): z.infer<typeof sabnzbdAddResponseSchema> {
    const parsed = sabnzbdAddResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `SABnzbd returned unexpected add response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  /**
   * SABnzbd's widening token on the delete axis is the word `all` (plus `failed` on history), not
   * blankness, so a blank `value` selects nothing today — the refusal keeps production from
   * depending on that and makes the read free rather than two full-list fetches that cannot
   * match (#2488). Reads return `null`; `monitor` escalates a thrown read via
   * `blacklistOnInfraError`.
   */
  private requireNzoId(id: string): string {
    const nzoId = normalizeExternalId(id);
    if (!nzoId) throw externalIdRefusal(this.name);
    return nzoId;
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const nzoId = normalizeExternalId(id);
    if (!nzoId) return null;

    const queueResponse = this.parseQueueResponse(await this.request<unknown>({
      mode: 'queue',
      limit: SABNZBD_LIST_LIMIT,
    }));

    const queueSlot = queueResponse.queue.slots.find(
      (s) => s.nzo_id === nzoId,
    );
    if (queueSlot) {
      return this.mapQueueSlot(queueSlot);
    }

    const historyResponse = this.parseHistoryResponse(await this.request<unknown>({
      mode: 'history',
      limit: SABNZBD_LIST_LIMIT,
    }));

    const historySlot = historyResponse.history.slots.find(
      (s) => s.nzo_id === nzoId,
    );
    if (historySlot) {
      return this.mapHistorySlot(historySlot);
    }

    return null;
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const queueParams: Record<string, string> = {
      mode: 'queue',
      limit: SABNZBD_LIST_LIMIT,
    };
    if (category) {
      queueParams.cat = category;
    }

    const historyParams: Record<string, string> = {
      mode: 'history',
      limit: SABNZBD_LIST_LIMIT,
    };
    if (category) {
      historyParams.cat = category;
    }

    const [rawQueue, rawHistory] = await Promise.all([
      this.request<unknown>(queueParams),
      this.request<unknown>(historyParams),
    ]);
    const queueResponse = this.parseQueueResponse(rawQueue);
    const historyResponse = this.parseHistoryResponse(rawHistory);

    const items: DownloadItemInfo[] = [];

    for (const slot of queueResponse.queue.slots) {
      items.push(this.mapQueueSlot(slot));
    }
    for (const slot of historyResponse.history.slots) {
      items.push(this.mapHistorySlot(slot));
    }

    return items;
  }

  private parseQueueResponse(raw: unknown): z.infer<typeof sabnzbdQueueResponseSchema> {
    const parsed = sabnzbdQueueResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `SABnzbd returned unexpected queue response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private parseHistoryResponse(raw: unknown): z.infer<typeof sabnzbdHistoryResponseSchema> {
    const parsed = sabnzbdHistoryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `SABnzbd returned unexpected history response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async pauseDownload(id: string): Promise<void> {
    await this.request({ mode: 'queue', name: 'pause', value: this.requireNzoId(id) });
  }

  async resumeDownload(id: string): Promise<void> {
    await this.request({ mode: 'queue', name: 'resume', value: this.requireNzoId(id) });
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    const nzoId = this.requireNzoId(id);

    await this.request({
      mode: 'queue',
      name: 'delete',
      value: nzoId,
      del_files: deleteFiles ? '1' : '0',
    });

    // SABnzbd tolerates deleting a missing history item.
    await this.request({
      mode: 'history',
      name: 'delete',
      value: nzoId,
      del_files: deleteFiles ? '1' : '0',
    });
  }

  async getCategories(): Promise<string[]> {
    const raw = await this.request<unknown>({ mode: 'get_cats' });
    const parsed = sabnzbdCategoriesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DownloadClientError(
        this.name,
        `SABnzbd returned unexpected categories response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data.categories.filter((c) => c !== '*');
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const raw = await this.request<unknown>({ mode: 'version' });
      const parsed = sabnzbdVersionResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DownloadClientError(
          this.name,
          `SABnzbd returned unexpected version response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      return {
        success: true,
        message: `SABnzbd ${parsed.data.version}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async request<T>(params: Record<string, string>): Promise<T> {
    const url = new URL('/api', this.baseUrl);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('output', 'json');

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return this.fetchApi<T>(url.toString(), {});
  }

  private async fetchApi<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, DEFAULT_REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      if (isTimeoutError(error)) throw new DownloadClientTimeoutError(this.name, (error as Error).message);
      throw new DownloadClientError(this.name, getErrorMessage(error));
    }

    if (response.status === 401 || response.status === 403) {
      throw new DownloadClientAuthError(this.name, `HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.ok) {
      throw new DownloadClientError(this.name, `HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      throw new DownloadClientError(this.name, `Connection failed: server didn't respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.`);
    }

    return (await response.json()) as T;
  }

  private mapQueueSlot(slot: SABnzbdQueueSlot): DownloadItemInfo {
    const totalMb = parseFloat(slot.mb) || 0;
    const leftMb = parseFloat(slot.mbleft) || 0;
    const size = Math.round(totalMb * 1024 * 1024);
    const downloaded = Math.round((totalMb - leftMb) * 1024 * 1024);

    const { parent, base } = splitStorage(slot.storage ?? undefined, slot.filename);

    return {
      id: slot.nzo_id,
      name: base,
      progress: parseInt(slot.percentage, 10) || 0,
      status: this.mapQueueStatus(slot.status),
      savePath: parent,
      size,
      downloaded,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      eta: this.parseTimeleft(slot.timeleft),
      downloadSpeed: parseKbpersec(slot.kbpersec ?? undefined),
      addedAt: new Date(), // SABnzbd queue doesn't expose added time
      completedAt: undefined,
    };
  }

  private mapHistorySlot(slot: SABnzbdHistorySlot): DownloadItemInfo {
    const { parent, base } = splitStorage(slot.storage, slot.name);
    const status = this.mapHistoryStatus(slot.status);

    return {
      id: slot.nzo_id,
      name: base,
      progress: status === 'error' ? 0 : 100,
      status,
      savePath: parent,
      size: slot.bytes,
      downloaded: slot.bytes,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      addedAt: slot.completed
        ? new Date(slot.completed * 1000 - slot.download_time * 1000)
        : new Date(),
      completedAt: slot.completed
        ? new Date(slot.completed * 1000)
        : undefined,
      ...(slot.fail_message ? { errorMessage: slot.fail_message } : {}),
    };
  }

  private mapQueueStatus(status: string): DownloadItemInfo['status'] {
    const lower = status.toLowerCase();
    if (lower === 'downloading' || lower === 'fetching') return 'downloading';
    if (lower === 'paused') return 'paused';
    return 'downloading';
  }

  private mapHistoryStatus(status: string): DownloadItemInfo['status'] {
    const lower = status.toLowerCase();
    if (lower === 'completed') return 'completed';
    if (lower === 'failed') return 'error';
    return 'downloading';
  }

  private parseTimeleft(timeleft: string): number | undefined {
    // SABnzbd uses HH:MM:SS.
    const parts = timeleft.split(':').map(Number);
    if (parts.length !== 3) return undefined;
    const seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    return seconds > 0 ? seconds : undefined;
  }
}
