import type {
  DownloadClientAdapter,
  DownloadItemInfo,
  AddDownloadOptions,
  DownloadProtocol,
} from './types.js';

export interface NZBGetConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;

interface NZBGetGroup {
  NZBID: number;
  NZBName: string;
  Status: string;
  FileSizeMB: number;
  DownloadedSizeMB: number;
  RemainingSizeMB: number;
  DownloadTimeSec: number;
  Category: string;
  DestDir: string;
  MinPostTime: number; // unix timestamp
}

interface NZBGetHistoryItem {
  NZBID: number;
  Name: string;
  Status: string;
  FileSizeMB: number;
  DownloadTimeSec: number;
  Category: string;
  DestDir: string;
  HistoryTime: number; // unix timestamp
  MinPostTime: number;
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
    url: string,
    options?: AddDownloadOptions,
  ): Promise<string> {
    // NZBGet append method: (NZBFilename, NZBContent, Category, Priority, DupeKey, DupeScore, DupeMode, AddUrlParams)
    // For URL-based adds, we use empty NZBContent and pass URL via AddUrlParams
    const params = [
      '', // NZBFilename (auto-detected from URL)
      url, // NZBContent (or URL when filename is empty)
      options?.category || '', // Category
      options?.paused ? -1 : 0, // Priority: -1=paused, 0=normal
      false, // AddToTop
      false, // AddPaused (use priority instead)
      '', // DupeKey
      0, // DupeScore
      'score', // DupeMode
    ];

    const result = await this.rpc<number>('append', params);

    if (!result || result <= 0) {
      throw new Error('NZBGet failed to add download');
    }

    return String(result);
  }

  async getDownload(id: string): Promise<DownloadItemInfo | null> {
    const nzbId = parseInt(id, 10);

    // Check active groups first
    const groups = await this.rpc<NZBGetGroup[]>('listgroups');
    const group = groups?.find((g) => g.NZBID === nzbId);
    if (group) {
      return this.mapGroup(group);
    }

    // Check history
    const history = await this.rpc<NZBGetHistoryItem[]>('history', [false]);
    const histItem = history?.find((h) => h.NZBID === nzbId);
    if (histItem) {
      return this.mapHistoryItem(histItem);
    }

    return null;
  }

  async getAllDownloads(category?: string): Promise<DownloadItemInfo[]> {
    const [groups, history] = await Promise.all([
      this.rpc<NZBGetGroup[]>('listgroups'),
      this.rpc<NZBGetHistoryItem[]>('history', [false]),
    ]);

    const items: DownloadItemInfo[] = [];

    for (const group of groups || []) {
      if (category && group.Category !== category) continue;
      items.push(this.mapGroup(group));
    }
    for (const histItem of history || []) {
      if (category && histItem.Category !== category) continue;
      items.push(this.mapHistoryItem(histItem));
    }

    return items;
  }

  async pauseDownload(id: string): Promise<void> {
    await this.rpc('editqueue', ['GroupPause', '', [parseInt(id, 10)]]);
  }

  async resumeDownload(id: string): Promise<void> {
    await this.rpc('editqueue', ['GroupResume', '', [parseInt(id, 10)]]);
  }

  async removeDownload(id: string, deleteFiles = false): Promise<void> {
    const command = deleteFiles ? 'GroupFinalDelete' : 'GroupDelete';
    await this.rpc('editqueue', [command, '', [parseInt(id, 10)]]);
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
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
        throw new Error(`Connection failed: server didn't respond as expected. Check host, port, SSL settings, and any reverse proxy (e.g. Authelia) that may be intercepting requests.`);
      }

      const data = (await response.json()) as { result: T; error?: string };

      if (data.error) {
        throw new Error(`NZBGet RPC error: ${data.error}`);
      }

      return data.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapGroup(group: NZBGetGroup): DownloadItemInfo {
    const sizeMb = group.FileSizeMB || 0;
    const downloadedMb = group.DownloadedSizeMB || 0;
    const size = Math.round(sizeMb * 1024 * 1024);
    const downloaded = Math.round(downloadedMb * 1024 * 1024);
    const progress = sizeMb > 0 ? Math.round((downloadedMb / sizeMb) * 100) : 0;

    const remainingMb = group.RemainingSizeMB || 0;
    let eta: number | undefined;
    if (remainingMb > 0 && group.DownloadTimeSec > 0 && downloadedMb > 0) {
      const speedMbps = downloadedMb / group.DownloadTimeSec;
      eta = speedMbps > 0 ? Math.round(remainingMb / speedMbps) : undefined;
    }

    return {
      id: String(group.NZBID),
      name: group.NZBName,
      progress,
      status: this.mapGroupStatus(group.Status),
      savePath: group.DestDir || '',
      size,
      downloaded,
      uploaded: 0,
      ratio: 0,
      seeders: 0,
      leechers: 0,
      eta,
      addedAt: group.MinPostTime
        ? new Date(group.MinPostTime * 1000)
        : new Date(),
      completedAt: undefined,
    };
  }

  private mapHistoryItem(item: NZBGetHistoryItem): DownloadItemInfo {
    const size = Math.round((item.FileSizeMB || 0) * 1024 * 1024);

    return {
      id: String(item.NZBID),
      name: item.Name,
      progress: 100,
      status: this.mapHistoryStatus(item.Status),
      savePath: item.DestDir || '',
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
    // NZBGet group statuses: DOWNLOADING, PAUSED, QUEUED, PP_QUEUED, LOADING, PP_*, FETCHING
    const upper = status.toUpperCase();
    if (upper === 'PAUSED') return 'paused';
    if (upper.startsWith('PP_') || upper === 'DOWNLOADING' || upper === 'FETCHING' || upper === 'QUEUED' || upper === 'LOADING')
      return 'downloading';
    return 'downloading';
  }

  private mapHistoryStatus(status: string): DownloadItemInfo['status'] {
    // NZBGet history statuses: SUCCESS/*, FAILURE/*, DELETED/*
    const upper = status.toUpperCase();
    if (upper.startsWith('SUCCESS')) return 'completed';
    if (upper.startsWith('FAILURE') || upper.startsWith('DELETED')) return 'error';
    return 'completed';
  }
}
