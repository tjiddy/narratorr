import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { BlackholeClient } from './blackhole.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  constants: { R_OK: 4, W_OK: 2 },
}));

const { writeFile, access } = await import('node:fs/promises');

describe('BlackholeClient', () => {
  const server = useMswServer();
  let client: BlackholeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'torrent' });
  });

  describe('addDownload', () => {
    it('fetches URL content and writes file to watchDir', async () => {
      const fileContent = new Uint8Array([0x64, 0x38]); // d8 - start of torrent file
      server.use(
        http.get('https://example.com/file.torrent', () => {
          return new HttpResponse(fileContent);
        }),
      );

      await client.addDownload('https://example.com/file.torrent');
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('watch'),
        expect.any(Buffer),
      );
    });

    it('preserves .torrent extension from URL', async () => {
      server.use(
        http.get('https://example.com/my-audiobook.torrent', () => {
          return new HttpResponse(new Uint8Array([0x64]));
        }),
      );

      await client.addDownload('https://example.com/my-audiobook.torrent');
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/my-audiobook\.torrent$/),
        expect.any(Buffer),
      );
    });

    it('preserves .nzb extension from URL', async () => {
      const nzbClient = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'usenet' });
      server.use(
        http.get('https://example.com/my-audiobook.nzb', () => {
          return new HttpResponse(new Uint8Array([0x3c]));
        }),
      );

      await nzbClient.addDownload('https://example.com/my-audiobook.nzb');
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/my-audiobook\.nzb$/),
        expect.any(Buffer),
      );
    });

    it('generates filename with correct extension when URL has no extension', async () => {
      server.use(
        http.get('https://example.com/api/download/123', () => {
          return new HttpResponse(new Uint8Array([0x64]));
        }),
      );

      await client.addDownload('https://example.com/api/download/123');
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.torrent$/),
        expect.any(Buffer),
      );
    });

    it('generates .nzb extension for usenet protocol', async () => {
      const nzbClient = new BlackholeClient({ watchDir: '/downloads/watch', protocol: 'usenet' });
      server.use(
        http.get('https://example.com/api/download/123', () => {
          return new HttpResponse(new Uint8Array([0x3c]));
        }),
      );

      await nzbClient.addDownload('https://example.com/api/download/123');
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.nzb$/),
        expect.any(Buffer),
      );
    });

    it('returns null externalId', async () => {
      server.use(
        http.get('https://example.com/file.torrent', () => {
          return new HttpResponse(new Uint8Array([0x64]));
        }),
      );

      const result = await client.addDownload('https://example.com/file.torrent');
      expect(result).toBeNull();
    });

    it('throws on download failure', async () => {
      server.use(
        http.get('https://example.com/file.torrent', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      await expect(client.addDownload('https://example.com/file.torrent')).rejects.toThrow('HTTP 404');
    });

    it('throws when writeFile fails', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      server.use(
        http.get('https://example.com/file.torrent', () => {
          return new HttpResponse(new Uint8Array([0x64]));
        }),
      );

      await expect(client.addDownload('https://example.com/file.torrent')).rejects.toThrow('ENOSPC');
    });
  });

  describe('getDownload', () => {
    it('returns null (no progress monitoring)', async () => {
      const result = await client.getDownload('any-id');
      expect(result).toBeNull();
    });
  });

  describe('getAllDownloads', () => {
    it('returns empty array', async () => {
      const result = await client.getAllDownloads();
      expect(result).toEqual([]);
    });
  });

  describe('removeDownload', () => {
    it('is a no-op', async () => {
      await expect(client.removeDownload('any-id', true)).resolves.toBeUndefined();
    });
  });

  describe('supportsCategories', () => {
    it('is false', () => {
      expect(client.supportsCategories).toBe(false);
    });
  });

  describe('test', () => {
    it('succeeds when watchDir exists and is writable', async () => {
      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('watch');
    });

    it('fails when watchDir does not exist', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('ENOENT: no such file'));

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('fails when watchDir is not writable', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not writable');
    });
  });

  describe('protocol', () => {
    it('reflects configured protocol', () => {
      expect(client.protocol).toBe('torrent');

      const usenetClient = new BlackholeClient({ watchDir: '/watch', protocol: 'usenet' });
      expect(usenetClient.protocol).toBe('usenet');
    });
  });
});
