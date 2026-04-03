import { fetchApi, URL_BASE, ApiError } from './client.js';

export interface BackupMetadata {
  filename: string;
  timestamp: string;
  size: number;
}

export interface RestoreValidation {
  valid: boolean;
  backupMigrationCount?: number;
  appMigrationCount?: number;
  error?: string;
}

export interface BackupJobResult {
  created: boolean;
  pruned: number;
}

const API_BASE = `${URL_BASE}/api`;

export const backupsApi = {
  getBackups: () => fetchApi<BackupMetadata[]>('/system/backups'),

  createBackup: () => fetchApi<BackupJobResult>('/system/backups/create', { method: 'POST' }),

  getBackupDownloadUrl: (filename: string) => `${API_BASE}/system/backups/${encodeURIComponent(filename)}/download`,

  uploadRestore: async (file: File): Promise<RestoreValidation> => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/system/restore`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new ApiError(response.status, error);
    }

    return response.json();
  },

  restoreBackupDirect: (filename: string) =>
    fetchApi<RestoreValidation>(`/system/backups/${encodeURIComponent(filename)}/restore`, { method: 'POST' }),

  confirmRestore: () => fetchApi<{ message: string }>('/system/restore/confirm', { method: 'POST' }),
};
