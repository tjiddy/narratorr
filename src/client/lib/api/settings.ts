import type { AppSettings } from '../../../shared/schemas.js';
import { fetchApi } from './client.js';

export type Settings = AppSettings;

export interface FfmpegProbeResult {
  version: string;
}

export interface TestResult {
  success: boolean;
  message?: string;
  ip?: string;
}

export interface ProxyTestResult {
  success: boolean;
  ip?: string;
  message?: string;
}

export const settingsApi = {
  getSettings: () => fetchApi<Settings>('/settings'),
  updateSettings: (data: Partial<Settings>) =>
    fetchApi<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  probeFfmpeg: (path: string) =>
    fetchApi<FfmpegProbeResult>('/settings/ffmpeg-probe', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  testProxy: (proxyUrl: string) =>
    fetchApi<ProxyTestResult>('/settings/test-proxy', {
      method: 'POST',
      body: JSON.stringify({ proxyUrl }),
    }),
};
