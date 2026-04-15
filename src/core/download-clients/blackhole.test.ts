import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { BlackholeClient } from './blackhole.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientError, DownloadClientTimeoutError } from './errors.js';

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
    it('writes torrent-bytes artifact as .torrent file', async () => {
      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64, 0x38]),
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.torrent$/),
        artifact.data,
      );
    });

    it('writes magnet-uri artifact as .magnet file', async () => {
      const magnetUri = 'magnet:?xt=urn:btih:abc123&dn=test';
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: magnetUri,
        infoHash: 'abc123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\d+\.magnet$/),
        magnetUri,
      );
    });

    it('fetches nzb-url artifact and writes .nzb file', async () => {
      const nzbContent = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62]);
      server.use(
        http.get('https://example.com/api/download/123', () => {
          return new HttpResponse(nzbContent);
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/api/download/123',
      };

      await client.addDownload(artifact);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/download-\d+\.nzb$/),
        expect.any(Buffer),
      );
    });

    it('returns null externalId for torrent-bytes', async () => {
      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64]),
        infoHash: 'abc123',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('returns null externalId for magnet-uri', async () => {
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: 'magnet:?xt=urn:btih:abc123',
        infoHash: 'abc123',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('returns null externalId for nzb-url', async () => {
      server.use(
        http.get('https://example.com/file.nzb', () => {
          return new HttpResponse(new Uint8Array([0x3c]));
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const result = await client.addDownload(artifact);
      expect(result).toBeNull();
    });

    it('throws DownloadClientError on nzb-url download failure', async () => {
      server.use(
        http.get('https://example.com/file.nzb', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      const error = await client.addDownload(artifact).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('HTTP 404');
    });

    it('throws DownloadClientTimeoutError on nzb-url fetch timeout', async () => {
      server.use(
        http.get('https://example.com/file.nzb', async () => {
          await delay('infinite');
          return new HttpResponse('');
        }),
      );

      const originalTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException('The operation was aborted', 'TimeoutError'));

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await expect(client.addDownload(artifact)).rejects.toBeInstanceOf(DownloadClientTimeoutError);

      AbortSignal.timeout = originalTimeout;
    });

    it('throws DownloadClientError on nzb-url network error', async () => {
      server.use(
        http.get('https://example.com/file.nzb', () => {
          return HttpResponse.error();
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'nzb-url',
        url: 'https://example.com/file.nzb',
      };

      await expect(client.addDownload(artifact)).rejects.toBeInstanceOf(DownloadClientError);
    });

    it('throws when writeFile fails', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      const artifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: Buffer.from([0x64]),
        infoHash: 'abc123',
      };

      await expect(client.addDownload(artifact)).rejects.toThrow('ENOSPC');
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
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('fails when watchDir is not writable', async () => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not writable');
    });

    // #197 — NodeJS.ErrnoException.code checks (ERR-1)
    it('detects ENOENT via error.code property (not message string matching)', async () => {
      const err = new Error('some unrelated message') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('detects EACCES via error.code property (not message string matching)', async () => {
      const err = new Error('some unrelated message') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not writable');
    });

    it('returns generic error message for other fs errors', async () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      vi.mocked(access).mockRejectedValueOnce(err);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('EPERM: operation not permitted');
    });
  });

  describe('addDownload — nzb-bytes', () => {
    it.todo('writes nzb-bytes data directly to watch dir as .nzb file (no HTTP fetch)');
    it.todo('file contents match the original buffer exactly');
    it.todo('rejects zero-length nzb-bytes with DownloadClientError before any filesystem write');
    it.todo('existing nzb-url path unchanged (still fetches URL and writes)');
  });

  describe('protocol', () => {
    it('reflects configured protocol', () => {
      expect(client.protocol).toBe('torrent');

      const usenetClient = new BlackholeClient({ watchDir: '/watch', protocol: 'usenet' });
      expect(usenetClient.protocol).toBe('usenet');
    });
  });
});
