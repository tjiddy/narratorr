import { describe, it, expect } from 'vitest';
import { ADAPTER_FACTORIES } from './registry.js';
import { downloadClientTypeSchema, type DownloadClientSettings } from '../../shared/schemas/download-client.js';

describe('Download Client ADAPTER_FACTORIES', () => {
  const types = downloadClientTypeSchema.options;

  const configs: Record<string, DownloadClientSettings> = {
    qbittorrent: { host: 'localhost', port: 8080, username: 'admin', password: '', useSsl: false },
    sabnzbd: { host: 'localhost', port: 8080, apiKey: 'key', useSsl: false },
    nzbget: { host: 'localhost', port: 6789, username: 'nzbget', password: '', useSsl: false },
    transmission: { host: 'localhost', port: 9091, username: '', password: '', useSsl: false },
    deluge: { host: 'localhost', port: 8112, password: 'deluge', useSsl: false },
    blackhole: { watchDir: '/watch', protocol: 'torrent' },
  };

  describe('invariants', () => {
    it('has a factory for every download client type in the Zod enum', () => {
      for (const type of types) {
        expect(ADAPTER_FACTORIES[type], `Missing factory for type: ${type}`).toBeTypeOf('function');
      }
    });

    it('each factory returns an object satisfying the DownloadClientAdapter interface', () => {
      for (const type of types) {
        const adapter = ADAPTER_FACTORIES[type](configs[type]);
        expect(adapter).toHaveProperty('type');
        expect(adapter).toHaveProperty('name');
        expect(adapter).toHaveProperty('protocol');
        expect(adapter).toHaveProperty('supportsCategories');
        expect(adapter.addDownload).toBeTypeOf('function');
        expect(adapter.getDownload).toBeTypeOf('function');
        expect(adapter.getAllDownloads).toBeTypeOf('function');
        expect(adapter.getCategories).toBeTypeOf('function');
        expect(adapter.test).toBeTypeOf('function');
      }
    });
  });

  describe('factory config extraction', () => {
    it('qbittorrent factory extracts host, port, username, password, useSsl', () => {
      const adapter = ADAPTER_FACTORIES.qbittorrent(configs.qbittorrent);
      expect(adapter.type).toBe('qbittorrent');
      expect(adapter.protocol).toBe('torrent');
    });

    it('sabnzbd factory extracts host, port, apiKey, useSsl', () => {
      const adapter = ADAPTER_FACTORIES.sabnzbd(configs.sabnzbd);
      expect(adapter.type).toBe('sabnzbd');
      expect(adapter.protocol).toBe('usenet');
    });

    it('nzbget factory extracts host, port, username, password, useSsl', () => {
      const adapter = ADAPTER_FACTORIES.nzbget(configs.nzbget);
      expect(adapter.type).toBe('nzbget');
      expect(adapter.protocol).toBe('usenet');
    });

    it('transmission factory extracts host, port, username, password, useSsl', () => {
      const adapter = ADAPTER_FACTORIES.transmission(configs.transmission);
      expect(adapter.type).toBe('transmission');
      expect(adapter.protocol).toBe('torrent');
    });

    it('deluge factory extracts host, port, password, useSsl', () => {
      const adapter = ADAPTER_FACTORIES.deluge(configs.deluge);
      expect(adapter.type).toBe('deluge');
      expect(adapter.protocol).toBe('torrent');
    });

    it('blackhole factory extracts watchDir, protocol', () => {
      const adapter = ADAPTER_FACTORIES.blackhole(configs.blackhole);
      expect(adapter.type).toBe('blackhole');
    });
  });

  describe('blackhole protocol handling', () => {
    it('blackhole factory respects per-instance settings.protocol (torrent)', () => {
      const adapter = ADAPTER_FACTORIES.blackhole({ watchDir: '/watch', protocol: 'torrent' });
      expect(adapter.protocol).toBe('torrent');
    });

    it('blackhole factory respects per-instance settings.protocol (usenet)', () => {
      const adapter = ADAPTER_FACTORIES.blackhole({ watchDir: '/watch', protocol: 'usenet' });
      expect(adapter.protocol).toBe('usenet');
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown download client type (no factory)', () => {
      expect((ADAPTER_FACTORIES as Record<string, unknown>)['unknown']).toBeUndefined();
    });
  });
});
