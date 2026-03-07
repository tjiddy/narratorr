import type { CreateDownloadClientFormData } from './schemas.js';

interface RequiredField {
  path: string;
  message: string;
}

interface FieldConfig {
  username: boolean;
  password: boolean;
  useSsl: boolean;
  apiKey: boolean;
}

interface DownloadClientTypeMetadata {
  label: string;
  defaultSettings: CreateDownloadClientFormData['settings'];
  requiredFields: RequiredField[];
  fieldConfig: FieldConfig;
  viewSubtitle: (settings: Record<string, unknown>) => string;
  supportsCategories: boolean;
  protocol: 'torrent' | 'usenet' | 'per-instance';
}

export const DOWNLOAD_CLIENT_REGISTRY: Record<string, DownloadClientTypeMetadata> = {
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
    viewSubtitle: () => 'blackhole',
    supportsCategories: false,
    protocol: 'per-instance',
  },
};

/** Normalize raw DB settings into typed form settings */
export function settingsFromClient(
  client: { settings: unknown },
): CreateDownloadClientFormData['settings'] {
  const s = client.settings as Record<string, unknown>;
  return {
    host: (s.host as string) || '',
    port: (s.port as number) || 8080,
    username: (s.username as string) || '',
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
    apiKey: (s.apiKey as string) || '',
    category: (s.category as string) || '',
    watchDir: (s.watchDir as string) || '',
    protocol: (s.protocol as 'torrent' | 'usenet') || 'torrent',
  };
}
