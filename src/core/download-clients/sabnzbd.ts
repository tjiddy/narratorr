import { dirname, basename } from 'node:path';
import type {
  DownloadClientAdapter,
  DownloadItemInfo,
  AddDownloadOptions,
  DownloadArtifact,
  DownloadProtocol,
} from './types.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

const SABNZBD_LIST_LIMIT = '1000';

/**
 * SABnzbd's `storage` is the full destination path (e.g., `/downloads/complete/BookTitle`).
 * The import pipeline expects `savePath` (parent) + `name` (child) joined together.
 * Split storage into parent/base to match that contract.
 */
function splitStorage(storage: string | undefined, fallbackName: string): { parent: string; base: string } {
  if (!storage) return { parent: '', base: fallbackName };
  return { parent: dirname(storage), base: basename(storage) };
}

/**
 * Parse SABnzbd's queue `kbpersec` string into bytes/sec.
 * SABnzbd computes it as `bytes_per_sec / 1024` (binary KiB), so we reverse with `* 1024`.
 * Returns `undefined` if the field is absent or unparseable; preserves `0` (stalled).
 */
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

interface SABnzbdQueueSlot {
  nzo_id: string;
  filename: string;
  status: string;
  mb: string;
  mbleft: string;
  percentage: string;
  timeleft: string;
  kbpersec?: string;
  cat: string;
  storage?: string;
}

interface SABnzbdHistorySlot {
  nzo_id: string;
  name: string;
  status: string;
  bytes: number;
  download_time: number;
  completed: number; // unix timestamp
  category: string;
  storage: string;
  fail_message: string;
}

interface SABnzbdQueueResponse {
  queue: {
    slots: SABnzbdQueueSlot[];
  };
}

interface SABnzbdHistoryResponse {
  history: {
    slots: SABnzbdHistorySlot[];
  };
}

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

    const response = await this.request<{
      status: boolean;
      nzo_ids: string[];
    }>(params);

    if (!response.status || !response.nzo_ids?.length) {
      throw new DownloadClientError(this.name, 'SABnzbd failed to add download');
    }

    return response.nzo_ids[0];
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

    const result = await this.fetchApi<{ status: boolean; nzo_ids: string[] }>(url.toString(), {
      method: 'POST',
      body: formData,
    });

    if (!result.status || !result.nzo_ids?.length) {
      throw new DownloadClientError(this.name, 'SABnzbd failed to add download');
    }

    return result.nzo_ids[0];
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    // Check queue first
    const queueResponse = await this.request<SABnzbdQueueResponse>({
      mode: 'queue',
      limit: SABNZBD_LIST_LIMIT,
    });

    const queueSlot = queueResponse.queue.slots.find(
      (s) => s.nzo_id === id,
    );
    if (queueSlot) {
      return this.mapQueueSlot(queueSlot);
    }

    // Check history
    const historyResponse = await this.request<SABnzbdHistoryResponse>({
      mode: 'history',
      limit: SABNZBD_LIST_LIMIT,
    });

    const historySlot = historyResponse.history.slots.find(
      (s) => s.nzo_id === id,
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

    const [queueResponse, historyResponse] = await Promise.all([
      this.request<SABnzbdQueueResponse>(queueParams),
      this.request<SABnzbdHistoryResponse>(historyParams),
    ]);

    const items: DownloadItemInfo[] = [];

    for (const slot of queueResponse.queue.slots) {
      items.push(this.mapQueueSlot(slot));
    }
    for (const slot of historyResponse.history.slots) {
      items.push(this.mapHistorySlot(slot));
    }

    return items;
  }

  async pauseDownload(id: string): Promise<void> {
    await this.request({ mode: 'queue', name: 'pause', value: id });
  }

  async resumeDownload(id: string): Promise<void> {
    await this.request({ mode: 'queue', name: 'resume', value: id });
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    // Try removing from queue first
    await this.request({
      mode: 'queue',
      name: 'delete',
      value: id,
      del_files: deleteFiles ? '1' : '0',
    });

    // Also try removing from history (SABnzbd doesn't error if not found)
    await this.request({
      mode: 'history',
      name: 'delete',
      value: id,
      del_files: deleteFiles ? '1' : '0',
    });
  }

  async getCategories(): Promise<string[]> {
    const response = await this.request<{ categories: string[] }>({
      mode: 'get_cats',
    });
    return (response.categories ?? []).filter((c) => c !== '*');
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.request<{ version: string }>({
        mode: 'version',
      });

      return {
        success: true,
        message: `SABnzbd ${response.version}`,
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

    // SABnzbd's `storage` is the full destination path — split into parent + name
    // to match the contract expected by import (join(savePath, name))
    const { parent, base } = splitStorage(slot.storage, slot.filename);

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
      downloadSpeed: parseKbpersec(slot.kbpersec),
      addedAt: new Date(), // SABnzbd queue doesn't expose added time
      completedAt: undefined,
    };
  }

  private mapHistorySlot(slot: SABnzbdHistorySlot): DownloadItemInfo {
    // SABnzbd's `storage` is the full destination path — split into parent + name
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
    // Queued and other states map to downloading (waiting to start)
    return 'downloading';
  }

  private mapHistoryStatus(status: string): DownloadItemInfo['status'] {
    const lower = status.toLowerCase();
    if (lower === 'completed') return 'completed';
    if (lower === 'failed') return 'error';
    return 'downloading';
  }

  private parseTimeleft(timeleft: string): number | undefined {
    // SABnzbd timeleft format: "HH:MM:SS" or "0:00:00"
    const parts = timeleft.split(':').map(Number);
    if (parts.length !== 3) return undefined;
    const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return seconds > 0 ? seconds : undefined;
  }
}
