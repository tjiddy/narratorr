import { describe, it, expect, expectTypeOf } from 'vitest';
import { DOWNLOAD_CLIENT_REGISTRY, type DownloadClientType, type DownloadClientTypeMetadata } from './download-client-registry.js';
import { downloadClientTypeSchema } from './schemas/download-client.js';

describe('DOWNLOAD_CLIENT_REGISTRY', () => {
  const types = downloadClientTypeSchema.options;

  describe('type narrowing', () => {
    it('keys are narrowed to DownloadClientType — no string index signature', () => {
      expectTypeOf<keyof typeof DOWNLOAD_CLIENT_REGISTRY>().toEqualTypeOf<DownloadClientType>();
    });

    it('each entry is structurally a DownloadClientTypeMetadata', () => {
      expectTypeOf<(typeof DOWNLOAD_CLIENT_REGISTRY)[DownloadClientType]>().toExtend<DownloadClientTypeMetadata>();
    });

    it('indexing with a non-DownloadClientType key is a type error', () => {
      // @ts-expect-error — 'unknown' is not in DownloadClientType
      const probe = DOWNLOAD_CLIENT_REGISTRY['unknown'];
      expect(probe).toBeUndefined();
    });
  });

  describe('invariants', () => {
    it('has an entry for every download client type in the Zod enum', () => {
      for (const type of types) {
        expect(DOWNLOAD_CLIENT_REGISTRY[type], `Missing registry entry for type: ${type}`).toBeDefined();
      }
    });

    it('every entry has all required metadata fields', () => {
      for (const type of types) {
        const meta = DOWNLOAD_CLIENT_REGISTRY[type];
        expect(meta.label).toBeTypeOf('string');
        expect(meta.defaultSettings).toBeDefined();
        expect(Array.isArray(meta.requiredFields)).toBe(true);
        expect(meta.fieldConfig).toBeDefined();
        expect(meta.viewSubtitle).toBeTypeOf('function');
        expect(meta.supportsCategories).toBeTypeOf('boolean');
        expect(['torrent', 'usenet', 'per-instance']).toContain(meta.protocol);
      }
    });

    it('protocol values are valid', () => {
      for (const type of types) {
        const meta = DOWNLOAD_CLIENT_REGISTRY[type];
        expect(['torrent', 'usenet', 'per-instance']).toContain(meta.protocol);
      }
    });

    it('requiredFields paths are valid setting field names', () => {
      for (const type of types) {
        const meta = DOWNLOAD_CLIENT_REGISTRY[type];
        for (const field of meta.requiredFields) {
          expect(field.path).toBeTypeOf('string');
          expect(field.message).toBeTypeOf('string');
        }
      }
    });
  });

  describe('viewSubtitle', () => {
    it('returns host:port for standard client types', () => {
      const types = ['qbittorrent', 'transmission', 'sabnzbd', 'nzbget', 'deluge'] as const;
      for (const type of types) {
        const subtitle = DOWNLOAD_CLIENT_REGISTRY[type].viewSubtitle({ host: 'myhost', port: 9000 });
        expect(subtitle).toBe('myhost:9000');
      }
    });

    it('returns type name for blackhole (matches pre-refactor behavior)', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.blackhole.viewSubtitle({ watchDir: '/downloads/watch' })).toBe('blackhole');
      expect(DOWNLOAD_CLIENT_REGISTRY.blackhole.viewSubtitle({})).toBe('blackhole');
    });

    it('returns type label as fallback when settings fields are missing', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.qbittorrent.viewSubtitle({})).toBe('qbittorrent');
    });
  });

  describe('protocol mapping', () => {
    it('qbittorrent has protocol torrent', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.qbittorrent.protocol).toBe('torrent');
    });

    it('transmission has protocol torrent', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.transmission.protocol).toBe('torrent');
    });

    it('deluge has protocol torrent', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.deluge.protocol).toBe('torrent');
    });

    it('sabnzbd has protocol usenet', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.sabnzbd.protocol).toBe('usenet');
    });

    it('nzbget has protocol usenet', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.nzbget.protocol).toBe('usenet');
    });

    it('blackhole has protocol per-instance', () => {
      expect(DOWNLOAD_CLIENT_REGISTRY.blackhole.protocol).toBe('per-instance');
    });
  });
});
