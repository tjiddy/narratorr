import type {
  DownloadClientAdapter,
  DownloadItemInfo,
  AddDownloadOptions,
  DownloadProtocol,
} from './types.js';

export interface SABnzbdConfig {
  host: string;
  port: number;
  apiKey: string;
  useSsl: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;

interface SABnzbdQueueSlot {
  nzo_id: string;
  filename: string;
  status: string;
  mb: string;
  mbleft: string;
  percentage: string;
  timeleft: string;
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

  private baseUrl: string;
  private apiKey: string;

  constructor(config: SABnzbdConfig) {
    const scheme = config.useSsl ? 'https' : 'http';
    this.baseUrl = `${scheme}://${config.host}:${config.port}`;
    this.apiKey = config.apiKey;
  }

  async addDownload(
    url: string,
    options?: AddDownloadOptions,
  ): Promise<string> {
    const params: Record<string, string> = {
      mode: 'addurl',
      name: url,
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
      throw new Error('SABnzbd failed to add download');
    }

    return response.nzo_ids[0];
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    // Check queue first
    const queueResponse = await this.request<SABnzbdQueueResponse>({
      mode: 'queue',
      limit: '1000',
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
      limit: '1000',
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
      limit: '1000',
    };
    if (category) {
      queueParams.cat = category;
    }

    const historyParams: Record<string, string> = {
      mode: 'history',
      limit: '1000',
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

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.request<{ version: string }>({
        mode: 'version',
      });

      return {
        success: true,
        message: `SABnzbd ${response.version}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapQueueSlot(slot: SABnzbdQueueSlot): DownloadItemInfo {
    const totalMb = parseFloat(slot.mb) || 0;
    const leftMb = parseFloat(slot.mbleft) || 0;
    const size = Math.round(totalMb * 1024 * 1024);
    const downloaded = Math.round((totalMb - leftMb) * 1024 * 1024);

    return {
      id: slot.nzo_id,
      name: slot.filename,
      progress: parseInt(slot.percentage, 10) || 0,
      status: this.mapQueueStatus(slot.status),
      savePath: slot.storage || '',
      size,
      downloaded,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      eta: this.parseTimeleft(slot.timeleft),
      addedAt: new Date(), // SABnzbd queue doesn't expose added time
      completedAt: undefined,
    };
  }

  private mapHistorySlot(slot: SABnzbdHistorySlot): DownloadItemInfo {
    return {
      id: slot.nzo_id,
      name: slot.name,
      progress: 100,
      status: this.mapHistoryStatus(slot.status),
      savePath: slot.storage || '',
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
    if (lower === 'extracting' || lower === 'verifying' || lower === 'repairing')
      return 'downloading';
    return 'completed';
  }

  private parseTimeleft(timeleft: string): number | undefined {
    // SABnzbd timeleft format: "HH:MM:SS" or "0:00:00"
    const parts = timeleft.split(':').map(Number);
    if (parts.length !== 3) return undefined;
    const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return seconds > 0 ? seconds : undefined;
  }
}
