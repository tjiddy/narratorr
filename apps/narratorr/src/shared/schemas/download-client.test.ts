import { describe, it, expect } from 'vitest';
import { createDownloadClientFormSchema } from './download-client.js';

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
