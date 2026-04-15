import type { DownloadClientAdapter } from './types.js';
import type { DownloadClientType } from '../../shared/download-client-registry.js';
import type { DownloadClientSettingsMap, DownloadClientSettings } from '../../shared/schemas/download-client.js';
import { QBittorrentClient } from './qbittorrent.js';
import { SABnzbdClient } from './sabnzbd.js';
import { NZBGetClient } from './nzbget.js';
import { TransmissionClient } from './transmission.js';
import { DelugeClient } from './deluge.js';
import { BlackholeClient } from './blackhole.js';

interface FactoryOptions {
  onWarn?: (msg: string) => void;
}

const TYPED_FACTORIES: { [K in DownloadClientType]: (settings: DownloadClientSettingsMap[K], options?: FactoryOptions) => DownloadClientAdapter } = {
  qbittorrent: (s) => new QBittorrentClient({
    host: s.host || 'localhost',
    port: s.port || 8080,
    username: s.username || 'admin',
    password: s.password || '',
    useSsl: s.useSsl || false,
  }),
  sabnzbd: (s) => new SABnzbdClient({
    host: s.host || 'localhost',
    port: s.port || 8080,
    apiKey: s.apiKey || '',
    useSsl: s.useSsl || false,
  }),
  nzbget: (s) => new NZBGetClient({
    host: s.host || 'localhost',
    port: s.port || 6789,
    username: s.username || 'nzbget',
    password: s.password || '',
    useSsl: s.useSsl || false,
  }),
  transmission: (s) => new TransmissionClient({
    host: s.host || 'localhost',
    port: s.port || 9091,
    username: s.username || '',
    password: s.password || '',
    useSsl: s.useSsl || false,
  }),
  deluge: (s, opts) => new DelugeClient({
    host: s.host || 'localhost',
    port: s.port || 8112,
    password: s.password || '',
    useSsl: s.useSsl || false,
    onWarn: opts?.onWarn,
  }),
  blackhole: (s) => new BlackholeClient({
    watchDir: s.watchDir || '',
    protocol: s.protocol || 'torrent',
  }),
};

export type DownloadClientAdapterFactory = (settings: DownloadClientSettings, options?: FactoryOptions) => DownloadClientAdapter;

export const ADAPTER_FACTORIES: Record<DownloadClientType, DownloadClientAdapterFactory> =
  TYPED_FACTORIES as Record<DownloadClientType, DownloadClientAdapterFactory>;
