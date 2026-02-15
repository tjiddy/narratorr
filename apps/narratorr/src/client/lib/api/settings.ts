import { fetchApi } from './client.js';

export interface Settings {
  library: {
    path: string;
    folderFormat: string;
  };
  search: {
    intervalMinutes: number;
    enabled: boolean;
    autoGrab: boolean;
  };
  import: {
    deleteAfterImport: boolean;
    minSeedTime: number;
  };
  general: {
    logLevel: 'error' | 'warn' | 'info' | 'debug';
  };
}

export interface TestResult {
  success: boolean;
  message?: string;
}

export const settingsApi = {
  getSettings: () => fetchApi<Settings>('/settings'),
  updateSettings: (data: Partial<Settings>) =>
    fetchApi<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};
