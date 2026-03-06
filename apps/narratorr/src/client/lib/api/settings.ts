import type { AudibleRegion, OutputFormat, MergeBehavior, TagMode, ProtocolPreference } from '../../../shared/schemas.js';
import { fetchApi } from './client.js';

export interface Settings {
  library: {
    path: string;
    folderFormat: string;
    fileFormat: string;
  };
  search: {
    intervalMinutes: number;
    enabled: boolean;
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
    keepOriginalBitrate: boolean;
    bitrate: number;
    mergeBehavior: MergeBehavior;
  };
  tagging: {
    enabled: boolean;
    mode: TagMode;
    embedCover: boolean;
  };
  quality: {
    grabFloor: number;
    protocolPreference: ProtocolPreference;
    minSeeders: number;
    searchImmediately: boolean;
    monitorForUpgrades: boolean;
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
