import { fetchApi } from './client.js';
import { type TestResult } from './settings.js';

export interface ProwlarrConfig {
  url: string;
  apiKey: string;
  syncMode: 'addOnly' | 'fullSync';
  categories: number[];
}

export interface SyncPreviewItem {
  action: 'new' | 'updated' | 'unchanged' | 'removed';
  name: string;
  type: 'torznab' | 'newznab';
  prowlarrId: number;
  localId?: number;
  changes?: string[];
}

export interface SyncApplyRequest {
  items: Array<{
    prowlarrId: number;
    action: string;
    selected: boolean;
  }>;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

export const prowlarrApi = {
  prowlarrTestConnection: (url: string, apiKey: string) =>
    fetchApi<TestResult>('/prowlarr/test', {
      method: 'POST',
      body: JSON.stringify({ url, apiKey }),
    }),
  prowlarrGetConfig: () => fetchApi<ProwlarrConfig>('/prowlarr/config'),
  prowlarrSaveConfig: (config: ProwlarrConfig) =>
    fetchApi<ProwlarrConfig>('/prowlarr/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  prowlarrPreview: () => fetchApi<SyncPreviewItem[]>('/prowlarr/preview', { method: 'POST' }),
  prowlarrSync: (request: SyncApplyRequest) =>
    fetchApi<SyncResult>('/prowlarr/sync', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
};
