import { fetchApi } from './client.js';

export const systemApi = {
  getSystemStatus: () => fetchApi<{ version: string; status: string }>('/system/status'),
  triggerSearch: () =>
    fetchApi<{ searched: number; grabbed: number }>('/system/tasks/search', { method: 'POST' }),
  searchAllWanted: () =>
    fetchApi<{ searched: number; grabbed: number; skipped: number; errors: number }>(
      '/system/tasks/search-all-wanted',
      { method: 'POST' },
    ),
};
