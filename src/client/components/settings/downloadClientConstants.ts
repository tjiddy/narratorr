import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

export const IMPLEMENTED_TYPES = ['qbittorrent', 'transmission', 'sabnzbd', 'nzbget', 'deluge', 'blackhole'];

export const TYPE_LABELS: Record<string, string> = {
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  deluge: 'Deluge',
  blackhole: 'Blackhole',
};

export const defaultSettings: Record<string, CreateDownloadClientFormData['settings']> = {
  qbittorrent: {
    host: '',
    port: 8080,
    username: '',
    password: '',
    useSsl: false,
    category: '',
  },
  transmission: {
    host: '',
    port: 9091,
    username: '',
    password: '',
    category: '',
  },
  sabnzbd: {
    host: '',
    port: 8080,
    apiKey: '',
    category: '',
  },
  nzbget: {
    host: '',
    port: 6789,
    username: '',
    password: '',
    category: '',
  },
  deluge: {
    host: '',
    port: 8112,
    password: '',
    useSsl: false,
    category: '',
  },
  blackhole: {
    watchDir: '',
    protocol: 'torrent',
  },
};

export const defaultValues: CreateDownloadClientFormData = {
  name: '',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: {
    host: '',
    port: 8080,
    username: '',
    password: '',
    useSsl: false,
    category: '',
  },
};

export function settingsFromClient(
  client: { settings: unknown; type?: string },
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
