import { fetchApi } from './client.js';

import type { HealthState, HealthCheckResult } from '@shared/health-types.js';

export type { HealthState, HealthCheckTarget, HealthCheckResult } from '@shared/health-types.js';

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
  /** Optional free-form instance badge (e.g. 'dev'); present only when configured (#1842). */
  instanceBadge?: string;
}

/** Third-party license notices shipped with the image, rendered on the System tab (#1862). */
export interface ThirdPartyNotices {
  content: string;
}

export const systemApi = {
  getSystemStatus: () => fetchApi<SystemStatus>('/system/status'),
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
  getThirdPartyNotices: () => fetchApi<ThirdPartyNotices>('/system/notices'),
};
