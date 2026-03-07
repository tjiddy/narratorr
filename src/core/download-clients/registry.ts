import type { DownloadClientAdapter } from './types.js';
import { QBittorrentClient } from './qbittorrent.js';
import { SABnzbdClient } from './sabnzbd.js';
import { NZBGetClient } from './nzbget.js';
import { TransmissionClient } from './transmission.js';
import { DelugeClient } from './deluge.js';
import { BlackholeClient } from './blackhole.js';

interface FactoryOptions {
  onWarn?: (msg: string) => void;
}

type AdapterFactory = (settings: Record<string, unknown>, options?: FactoryOptions) => DownloadClientAdapter;

export const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  qbittorrent: (s) => new QBittorrentClient({
    host: (s.host as string) || 'localhost',
    port: (s.port as number) || 8080,
    username: (s.username as string) || 'admin',
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
  }),
  sabnzbd: (s) => new SABnzbdClient({
    host: (s.host as string) || 'localhost',
    port: (s.port as number) || 8080,
    apiKey: (s.apiKey as string) || '',
    useSsl: (s.useSsl as boolean) || false,
  }),
  nzbget: (s) => new NZBGetClient({
    host: (s.host as string) || 'localhost',
    port: (s.port as number) || 6789,
    username: (s.username as string) || 'nzbget',
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
  }),
  transmission: (s) => new TransmissionClient({
    host: (s.host as string) || 'localhost',
    port: (s.port as number) || 9091,
    username: (s.username as string) || '',
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
  }),
  deluge: (s, opts) => new DelugeClient({
    host: (s.host as string) || 'localhost',
    port: (s.port as number) || 8112,
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
    onWarn: opts?.onWarn,
  }),
  blackhole: (s) => new BlackholeClient({
    watchDir: (s.watchDir as string) || '',
    protocol: ((s.protocol as string) || 'torrent') as 'torrent' | 'usenet',
  }),
};
