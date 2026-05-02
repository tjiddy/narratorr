import { fetchApi, fetchMultipart, URL_BASE } from './client.js';

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

export const backupsApi = {
  getBackups: () => fetchApi<BackupMetadata[]>('/system/backups'),

  createBackup: () => fetchApi<BackupJobResult>('/system/backups/create', { method: 'POST' }),

  getBackupDownloadUrl: (filename: string) =>
    `${URL_BASE}/api/system/backups/${encodeURIComponent(filename)}/download`,

  uploadRestore: (file: File): Promise<RestoreValidation> => {
    const formData = new FormData();
    formData.append('file', file);
    return fetchMultipart<RestoreValidation>('/system/restore', formData);
  },

  restoreBackupDirect: (filename: string) =>
    fetchApi<RestoreValidation>(`/system/backups/${encodeURIComponent(filename)}/restore`, { method: 'POST' }),

  confirmRestore: () => fetchApi<{ message: string }>('/system/restore/confirm', { method: 'POST' }),
};
