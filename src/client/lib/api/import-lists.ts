import { fetchApi } from './client.js';
import { type TestResult } from './settings.js';

export interface ImportList {
  id: number;
  name: string;
  type: 'abs' | 'nyt' | 'hardcover';
  enabled: boolean;
  syncIntervalMinutes: number;
  settings: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface ImportListItem {
  title: string;
  author?: string;
  asin?: string;
  isbn?: string;
}

export interface ImportListPreview {
  items: ImportListItem[];
  total: number;
}

type ImportListInput = Omit<ImportList, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt' | 'lastSyncError'>;

export interface AbsLibrary {
  id: string;
  name: string;
}

export const importListsApi = {
  getImportLists: () => fetchApi<ImportList[]>('/import-lists'),
  createImportList: (data: ImportListInput) =>
    fetchApi<ImportList>('/import-lists', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateImportList: (id: number, data: Partial<ImportListInput>) =>
    fetchApi<ImportList>(`/import-lists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteImportList: (id: number) =>
    fetchApi<{ success: boolean }>(`/import-lists/${id}`, { method: 'DELETE' }),
  testImportList: (id: number) =>
    fetchApi<TestResult>(`/import-lists/${id}/test`, { method: 'POST' }),
  testImportListConfig: (data: ImportListInput) =>
    fetchApi<TestResult>('/import-lists/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  previewImportList: (data: ImportListInput) =>
    fetchApi<ImportListPreview>('/import-lists/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  fetchAbsLibraries: (data: { serverUrl: string; apiKey: string }) =>
    fetchApi<{ libraries: AbsLibrary[] }>('/import-lists/abs/libraries', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
