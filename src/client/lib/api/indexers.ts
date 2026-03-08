import { fetchApi } from './client.js';
import { type TestResult } from './settings.js';

export interface Indexer {
  id: number;
  name: string;
  type: 'abb' | 'torznab' | 'newznab' | 'myanonamouse';
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  createdAt: string;
}

export const indexersApi = {
  getIndexers: () => fetchApi<Indexer[]>('/indexers'),
  createIndexer: (data: Omit<Indexer, 'id' | 'createdAt'>) =>
    fetchApi<Indexer>('/indexers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateIndexer: (id: number, data: Partial<Indexer>) =>
    fetchApi<Indexer>(`/indexers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteIndexer: (id: number) =>
    fetchApi<{ success: boolean }>(`/indexers/${id}`, { method: 'DELETE' }),
  testIndexer: (id: number) =>
    fetchApi<TestResult>(`/indexers/${id}/test`, { method: 'POST' }),
  testIndexerConfig: (data: Omit<Indexer, 'id' | 'createdAt'>) =>
    fetchApi<TestResult>('/indexers/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
