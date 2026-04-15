import { describe, it, expect } from 'vitest';
import {
  createDownloadClientFormSchema,
  createDownloadClientSchema,
  createRemotePathMappingSchema,
  updateDownloadClientSchema,
  updateRemotePathMappingSchema,
} from './download-client.js';

const validBase = {
  name: 'Test Client',
  type: 'qbittorrent' as const,
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080 },
};

describe('createDownloadClientFormSchema', () => {
  describe('superRefine — host/port required', () => {
    it('accepts valid qbittorrent config', () => {
      const result = createDownloadClientFormSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('rejects missing host', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        settings: { port: 8080 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'host'],
            message: 'Host is required',
          }),
        );
      }
    });

    it('rejects empty host', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        settings: { host: '', port: 8080 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'host'],
            message: 'Host is required',
          }),
        );
      }
    });

    it('rejects missing port', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        settings: { host: 'localhost' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'port'],
            message: 'Port is required',
          }),
        );
      }
    });
  });

  describe('superRefine — sabnzbd requires apiKey', () => {
    it('rejects sabnzbd without apiKey', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'sabnzbd',
        settings: { host: 'localhost', port: 8080 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'apiKey'],
            message: 'API key is required',
          }),
        );
      }
    });

    it('accepts sabnzbd with apiKey', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'sabnzbd',
        settings: { host: 'localhost', port: 8080, apiKey: 'abc123' },
      });
      expect(result.success).toBe(true);
    });

    it('does not require apiKey for qbittorrent', () => {
      const result = createDownloadClientFormSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('does not require apiKey for transmission', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'transmission',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('superRefine — blackhole requires watchDir and protocol', () => {
    it('accepts blackhole with watchDir and protocol', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { watchDir: '/downloads/watch', protocol: 'torrent' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects blackhole without watchDir', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { protocol: 'torrent' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'watchDir'],
            message: 'Watch directory is required',
          }),
        );
      }
    });

    it('rejects blackhole without protocol', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { watchDir: '/downloads/watch' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'protocol'],
            message: 'Protocol is required',
          }),
        );
      }
    });

    it('does NOT require host/port for blackhole', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { watchDir: '/downloads/watch', protocol: 'usenet' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts deluge type', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'deluge',
        settings: { host: 'localhost', port: 8112, password: 'deluge' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts blackhole with usenet protocol', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { watchDir: '/watch', protocol: 'usenet' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects blackhole with empty watchDir', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'blackhole',
        settings: { watchDir: '', protocol: 'torrent' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'watchDir'],
            message: 'Watch directory is required',
          }),
        );
      }
    });
  });

  // ===== #263 — pathMappings in create schema =====

  describe('createDownloadClientSchema pathMappings', () => {
    it('accepts body with valid pathMappings array', () => {
      const result = createDownloadClientSchema.safeParse({
        ...validBase,
        pathMappings: [{ remotePath: '/remote/downloads', localPath: '/local/downloads' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pathMappings).toEqual([{ remotePath: '/remote/downloads', localPath: '/local/downloads' }]);
      }
    });

    it('accepts body with empty pathMappings array', () => {
      const result = createDownloadClientSchema.safeParse({
        ...validBase,
        pathMappings: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pathMappings).toEqual([]);
      }
    });

    it('accepts body with pathMappings omitted', () => {
      const result = createDownloadClientSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pathMappings).toBeUndefined();
      }
    });

    it('rejects pathMappings entries with empty remotePath', () => {
      const result = createDownloadClientSchema.safeParse({
        ...validBase,
        pathMappings: [{ remotePath: '', localPath: '/local' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects pathMappings entries with whitespace-only localPath', () => {
      const result = createDownloadClientSchema.safeParse({
        ...validBase,
        pathMappings: [{ remotePath: '/remote', localPath: '   ' }],
      });
      expect(result.success).toBe(false);
    });
  });

  // ===== #263 — downloadRoot removed from form schema =====

  describe('settings.downloadRoot removed', () => {
    it('form schema no longer includes downloadRoot field', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        settings: { ...validBase.settings, downloadRoot: '/downloads/complete' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // downloadRoot is stripped by the schema (not in the shape)
        expect(result.data.settings).not.toHaveProperty('downloadRoot');
      }
    });
  });

  describe('base field validation', () => {
    it('rejects empty name', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        name: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid type', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        type: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects priority out of range', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        priority: 101,
      });
      expect(result.success).toBe(false);
    });

    it('rejects port out of range', () => {
      const result = createDownloadClientFormSchema.safeParse({
        ...validBase,
        settings: { host: 'localhost', port: 70000 },
      });
      expect(result.success).toBe(false);
    });
  });
});

const validCreateClient = {
  name: 'My Client',
  type: 'qbittorrent' as const,
  settings: { host: 'localhost', port: 8080 },
};

describe('createDownloadClientSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createDownloadClientSchema.safeParse({ ...validCreateClient, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createDownloadClientSchema.safeParse({ ...validCreateClient, name: '  My Client  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Client');
  });
});

describe('updateDownloadClientSchema — trim behavior', () => {
  it('rejects whitespace-only name when provided', () => {
    const result = updateDownloadClientSchema.safeParse({ name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name when provided', () => {
    const result = updateDownloadClientSchema.safeParse({ name: '  My Client  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Client');
  });
});

const validMapping = { downloadClientId: 1, remotePath: '/remote/books', localPath: '/local/books' };

describe('createRemotePathMappingSchema — trim behavior', () => {
  it('rejects whitespace-only remotePath', () => {
    const result = createRemotePathMappingSchema.safeParse({ ...validMapping, remotePath: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only localPath', () => {
    const result = createRemotePathMappingSchema.safeParse({ ...validMapping, localPath: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from remotePath', () => {
    const result = createRemotePathMappingSchema.safeParse({ ...validMapping, remotePath: '  /remote/books  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.remotePath).toBe('/remote/books');
  });

  it('trims leading/trailing spaces from localPath', () => {
    const result = createRemotePathMappingSchema.safeParse({ ...validMapping, localPath: '  /local/books  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.localPath).toBe('/local/books');
  });
});

describe('updateRemotePathMappingSchema — trim behavior', () => {
  it('rejects whitespace-only remotePath when provided', () => {
    const result = updateRemotePathMappingSchema.safeParse({ remotePath: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only localPath when provided', () => {
    const result = updateRemotePathMappingSchema.safeParse({ localPath: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from remotePath when provided', () => {
    const result = updateRemotePathMappingSchema.safeParse({ remotePath: '  /remote/books  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.remotePath).toBe('/remote/books');
  });

  it('trims leading/trailing spaces from localPath when provided', () => {
    const result = updateRemotePathMappingSchema.safeParse({ localPath: '  /local/books  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.localPath).toBe('/local/books');
  });
});

describe('createDownloadClientFormSchema — settings trim (#284)', () => {
  it('trims whitespace from host', () => {
    const result = createDownloadClientFormSchema.safeParse({
      ...validBase,
      settings: { host: '  localhost  ', port: 8080 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.host).toBe('localhost');
  });

  it('trims whitespace from apiKey', () => {
    const result = createDownloadClientFormSchema.safeParse({
      ...validBase,
      settings: { host: 'localhost', port: 8080, apiKey: '  abc123  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.apiKey).toBe('abc123');
  });

  it('trims whitespace from username, password, category, watchDir', () => {
    const result = createDownloadClientFormSchema.safeParse({
      ...validBase,
      settings: {
        host: 'localhost',
        port: 8080,
        username: '  admin  ',
        password: '  secret  ',
        category: '  audiobooks  ',
        watchDir: '  /downloads  ',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.username).toBe('admin');
      expect(result.data.settings.password).toBe('secret');
      expect(result.data.settings.category).toBe('audiobooks');
      expect(result.data.settings.watchDir).toBe('/downloads');
    }
  });

  it('whitespace-only optional settings fields produce empty string, not undefined', () => {
    const result = createDownloadClientFormSchema.safeParse({
      ...validBase,
      settings: { host: 'localhost', port: 8080, category: '   ', watchDir: '   ', username: '   ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.category).toBe('');
      expect(result.data.settings.watchDir).toBe('');
      expect(result.data.settings.username).toBe('');
    }
  });
});

// #557 — Typed adapter settings schemas (discriminated unions)
describe('createDownloadClientSchema — typed settings validation', () => {
  const base = { name: 'Test', enabled: true, priority: 50 };

  describe('positive cases — each type with valid settings', () => {
    it('accepts valid qbittorrent settings (host + port)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 8080 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid transmission settings (host + port)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'transmission', settings: { host: 'localhost', port: 9091 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid sabnzbd settings (host + port + apiKey)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'sabnzbd', settings: { host: 'localhost', port: 8080, apiKey: 'key123' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid nzbget settings (host + port)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'nzbget', settings: { host: 'localhost', port: 6789 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid deluge settings (host + port)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'deluge', settings: { host: 'localhost', port: 8112 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid blackhole settings (watchDir + protocol)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'blackhole', settings: { watchDir: '/downloads', protocol: 'torrent' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('negative cases', () => {
    it('rejects missing required fields for qbittorrent (no host)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { port: 8080 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ['settings', 'host'] }),
        );
      }
    });

    it('rejects port as string instead of number', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: '8080' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra unknown fields', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 8080, badField: true },
      });
      expect(result.success).toBe(false);
    });

    it('rejects blackhole with invalid protocol', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'blackhole', settings: { watchDir: '/dl', protocol: 'ftp' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('boundary values', () => {
    it('accepts port at minimum (1)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts port at maximum (65535)', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 65535 },
      });
      expect(result.success).toBe(true);
    });

    it('rejects port at 0', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects port above 65535', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 65536 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('persisted metadata', () => {
    it('accepts download client settings with category field', () => {
      const result = createDownloadClientSchema.safeParse({
        ...base, type: 'qbittorrent', settings: { host: 'localhost', port: 8080, category: 'audiobooks' },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.settings.category).toBe('audiobooks');
    });

    it('blackhole protocol must be torrent or usenet', () => {
      for (const protocol of ['torrent', 'usenet']) {
        const result = createDownloadClientSchema.safeParse({
          ...base, type: 'blackhole', settings: { watchDir: '/dl', protocol },
        });
        expect(result.success).toBe(true);
      }
    });
  });
});

describe('updateDownloadClientSchema — type required when settings present', () => {
  it('accepts update with settings + type', () => {
    const result = updateDownloadClientSchema.safeParse({
      type: 'qbittorrent' as const, settings: { host: 'newhost', port: 8080 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts update without settings (type not required)', () => {
    const result = updateDownloadClientSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('rejects update with settings but no type', () => {
    const result = updateDownloadClientSchema.safeParse({
      settings: { host: 'localhost', port: 8080 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['type'], message: 'Type is required when settings are provided' }),
      );
    }
  });
});
