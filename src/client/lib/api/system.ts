import { fetchApi } from './client.js';

export type HealthState = 'healthy' | 'warning' | 'error';

export interface HealthCheckResult {
  checkName: string;
  state: HealthState;
  message?: string;
}

export interface HealthSummary {
  state: HealthState;
}

export interface TaskMetadata {
  name: string;
  type: 'cron' | 'timeout';
  lastRun: string | null;
  nextRun: string | null;
  running: boolean;
}

export interface SystemInfo {
  version: string;
  commit: string;
  buildTime?: string;
  nodeVersion: string;
  os: string;
  dbSize: number | null;
  libraryPath: string | null;
  freeSpace: number | null;
}

export interface SystemStatus {
  version: string;
  status: string;
}

export interface UpdateInfo {
  latestVersion: string;
  releaseUrl: string;
  dismissed: boolean;
}

export interface UpdateStatus {
  update: UpdateInfo | null;
}

export const systemApi = {
  getSystemStatus: () => fetchApi<SystemStatus>('/system/status'),
  getUpdateStatus: () => fetchApi<UpdateStatus>('/system/update-status'),
  dismissUpdate: (version: string) =>
    fetchApi<{ ok: true }>('/system/update/dismiss', {
      method: 'PUT',
      body: JSON.stringify({ version }),
    }),
  searchAllWanted: () =>
    fetchApi<{ searched: number; grabbed: number; skipped: number; errors: number }>(
      '/system/tasks/search-all-wanted',
      { method: 'POST' },
    ),
  getHealthStatus: () => fetchApi<HealthCheckResult[]>('/system/health/status'),
  getHealthSummary: () => fetchApi<HealthSummary>('/system/health/summary'),
  runHealthCheck: () => fetchApi<HealthCheckResult[]>('/system/health/run', { method: 'POST' }),
  getSystemTasks: () => fetchApi<TaskMetadata[]>('/system/tasks'),
  runSystemTask: (name: string) => fetchApi<{ ok: boolean }>(`/system/tasks/${name}/run`, { method: 'POST' }),
  getSystemInfo: () => fetchApi<SystemInfo>('/system/info'),
};
