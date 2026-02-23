import type { AudibleRegion, OutputFormat, MergeBehavior } from '../../../shared/schemas.js';
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
  metadata: {
    audibleRegion: AudibleRegion;
  };
  processing: {
    enabled: boolean;
    ffmpegPath: string;
    outputFormat: OutputFormat;
    bitrate: number;
    mergeBehavior: MergeBehavior;
  };
}

export interface FfmpegProbeResult {
  version: string;
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
  probeFfmpeg: (path: string) =>
    fetchApi<FfmpegProbeResult>('/settings/ffmpeg-probe', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};
