import type { CreateDownloadClientFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

interface FieldConfig {
  username: boolean;
  password: boolean;
  useSsl: boolean;
  apiKey: boolean;
}

export interface DownloadClientTypeMetadata extends RegistryEntry<CreateDownloadClientFormData['settings']> {
  fieldConfig: FieldConfig;
  supportsCategories: boolean;
  protocol: 'torrent' | 'usenet' | 'per-instance';
}

export const DOWNLOAD_CLIENT_TYPES = ['qbittorrent', 'transmission', 'sabnzbd', 'nzbget', 'deluge', 'blackhole'] as const;
export type DownloadClientType = typeof DOWNLOAD_CLIENT_TYPES[number];

export const DOWNLOAD_CLIENT_REGISTRY = {
  qbittorrent: {
    label: 'qBittorrent',
    defaultSettings: { host: '', port: 8080, username: '', password: '', useSsl: false, category: '' },
    requiredFields: [
      { path: 'host', message: 'Host is required' },
      { path: 'port', message: 'Port is required' },
    ],
    fieldConfig: { username: true, password: true, useSsl: true, apiKey: false },
    viewSubtitle: (s) => {
      const host = (s.host as string) || '';
      const port = (s.port as number) || '';
      return host && port ? `${host}:${port}` : 'qbittorrent';
    },
    supportsCategories: true,
    protocol: 'torrent',
  },
  transmission: {
    label: 'Transmission',
    defaultSettings: { host: '', port: 9091, username: '', password: '', category: '' },
    requiredFields: [
      { path: 'host', message: 'Host is required' },
      { path: 'port', message: 'Port is required' },
    ],
    fieldConfig: { username: true, password: true, useSsl: true, apiKey: false },
    viewSubtitle: (s) => {
      const host = (s.host as string) || '';
      const port = (s.port as number) || '';
      return host && port ? `${host}:${port}` : 'transmission';
    },
    supportsCategories: false,
    protocol: 'torrent',
  },
  sabnzbd: {
    label: 'SABnzbd',
    defaultSettings: { host: '', port: 8080, apiKey: '', category: '' },
    requiredFields: [
      { path: 'host', message: 'Host is required' },
      { path: 'port', message: 'Port is required' },
      { path: 'apiKey', message: 'API key is required' },
    ],
    fieldConfig: { username: false, password: false, useSsl: true, apiKey: true },
    viewSubtitle: (s) => {
      const host = (s.host as string) || '';
      const port = (s.port as number) || '';
      return host && port ? `${host}:${port}` : 'sabnzbd';
    },
    supportsCategories: true,
    protocol: 'usenet',
  },
  nzbget: {
    label: 'NZBGet',
    defaultSettings: { host: '', port: 6789, username: '', password: '', category: '' },
    requiredFields: [
      { path: 'host', message: 'Host is required' },
      { path: 'port', message: 'Port is required' },
    ],
    fieldConfig: { username: true, password: true, useSsl: true, apiKey: false },
    viewSubtitle: (s) => {
      const host = (s.host as string) || '';
      const port = (s.port as number) || '';
      return host && port ? `${host}:${port}` : 'nzbget';
    },
    supportsCategories: true,
    protocol: 'usenet',
  },
  deluge: {
    label: 'Deluge',
    defaultSettings: { host: '', port: 8112, password: '', useSsl: false, category: '' },
    requiredFields: [
      { path: 'host', message: 'Host is required' },
      { path: 'port', message: 'Port is required' },
    ],
    fieldConfig: { username: false, password: true, useSsl: true, apiKey: false },
    viewSubtitle: (s) => {
      const host = (s.host as string) || '';
      const port = (s.port as number) || '';
      return host && port ? `${host}:${port}` : 'deluge';
    },
    supportsCategories: true,
    protocol: 'torrent',
  },
  blackhole: {
    label: 'Blackhole',
    defaultSettings: { watchDir: '', protocol: 'torrent' },
    requiredFields: [
      { path: 'watchDir', message: 'Watch directory is required' },
      { path: 'protocol', message: 'Protocol is required' },
    ],
    fieldConfig: { username: false, password: false, useSsl: false, apiKey: false },
    viewSubtitle: (_s: Record<string, unknown>) => 'blackhole',
    supportsCategories: false,
    protocol: 'per-instance',
  },
} satisfies Record<DownloadClientType, DownloadClientTypeMetadata>;

/** Normalize raw DB settings into typed form settings */
export function settingsFromClient(
  client: { type: DownloadClientType; settings: unknown },
): CreateDownloadClientFormData['settings'] {
  const meta = DOWNLOAD_CLIENT_REGISTRY[client.type];
  const defaults = meta?.defaultSettings ?? {};
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, val] of Object.entries(client.settings as Record<string, unknown>)) {
    if (val != null) result[key] = val;
  }
  return result as CreateDownloadClientFormData['settings'];
}
