import { fetchApi } from './client.js';
import { type TestResult } from './settings.js';

export interface DownloadClient {
  id: number;
  name: string;
  type: 'qbittorrent' | 'transmission' | 'sabnzbd' | 'nzbget';
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface CategoriesResult {
  categories: string[];
  error?: string;
}

export const downloadClientsApi = {
  getClients: () => fetchApi<DownloadClient[]>('/download-clients'),
  createClient: (data: Omit<DownloadClient, 'id' | 'createdAt'>) =>
    fetchApi<DownloadClient>('/download-clients', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateClient: (id: number, data: Partial<DownloadClient>) =>
    fetchApi<DownloadClient>(`/download-clients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteClient: (id: number) =>
    fetchApi<{ success: boolean }>(`/download-clients/${id}`, { method: 'DELETE' }),
  testClient: (id: number) =>
    fetchApi<TestResult>(`/download-clients/${id}/test`, { method: 'POST' }),
  testClientConfig: (data: Omit<DownloadClient, 'id' | 'createdAt'>) =>
    fetchApi<TestResult>('/download-clients/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getClientCategories: (id: number) =>
    fetchApi<CategoriesResult>(`/download-clients/${id}/categories`, { method: 'POST' }),
  getClientCategoriesFromConfig: (data: Omit<DownloadClient, 'id' | 'createdAt'>) =>
    fetchApi<CategoriesResult>('/download-clients/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
