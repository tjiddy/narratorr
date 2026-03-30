import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { resolveSavePath } from './download-path.js';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';

function mockDownloadClientService(item: { savePath: string; name: string } | null = null) {
  const adapter = item ? { getDownload: vi.fn().mockResolvedValue(item) } : { getDownload: vi.fn().mockResolvedValue(null) };
  return {
    getAdapter: vi.fn().mockResolvedValue(item !== undefined ? adapter : null),
    adapter,
  };
}

function mockRemotePathMappingService(mappings: { remotePath: string; localPath: string }[] = []) {
  return { getByClientId: vi.fn().mockResolvedValue(mappings) };
}

describe('resolveSavePath', () => {
  it('joins savePath and name from adapter download item', async () => {
    const dcs = mockDownloadClientService({ savePath: '/downloads', name: 'The.Book.2024' });
    const download = { id: 1, downloadClientId: 1, externalId: 'ext-1' };

    const result = await resolveSavePath(download, dcs as unknown as DownloadClientService);

    expect(result.resolvedPath).toBe(join('/downloads', 'The.Book.2024'));
    expect(result.originalPath).toBe(join('/downloads', 'The.Book.2024'));
    expect(dcs.getAdapter).toHaveBeenCalledWith(1);
    expect(dcs.adapter.getDownload).toHaveBeenCalledWith('ext-1');
  });

  it('applies remote path mapping to the full joined path', async () => {
    const dcs = mockDownloadClientService({ savePath: '/remote/downloads', name: 'Book' });
    const rpms = mockRemotePathMappingService([{ remotePath: '/remote/downloads', localPath: '/local/downloads' }]);
    const download = { id: 1, downloadClientId: 1, externalId: 'ext-1' };

    const result = await resolveSavePath(download, dcs as unknown as DownloadClientService, rpms as unknown as RemotePathMappingService);

    // applyPathMapping normalizes to forward slashes
    expect(result.resolvedPath).toBe('/local/downloads/Book');
    expect(result.originalPath).toBe(join('/remote/downloads', 'Book'));
    expect(rpms.getByClientId).toHaveBeenCalledWith(1);
  });

  it('returns unmapped path when no remote path mappings exist', async () => {
    const dcs = mockDownloadClientService({ savePath: '/downloads', name: 'Book' });
    const rpms = mockRemotePathMappingService([]);
    const download = { id: 1, downloadClientId: 1, externalId: 'ext-1' };

    const result = await resolveSavePath(download, dcs as unknown as DownloadClientService, rpms as unknown as RemotePathMappingService);

    expect(result.resolvedPath).toBe(join('/downloads', 'Book'));
  });

  it('returns unmapped path when remotePathMappingService is not provided', async () => {
    const dcs = mockDownloadClientService({ savePath: '/downloads', name: 'Book' });
    const download = { id: 1, downloadClientId: 1, externalId: 'ext-1' };

    const result = await resolveSavePath(download, dcs as unknown as DownloadClientService);

    expect(result.resolvedPath).toBe(join('/downloads', 'Book'));
  });

  it('throws when download has no downloadClientId', async () => {
    const dcs = mockDownloadClientService();
    const download = { id: 1, downloadClientId: null, externalId: 'ext-1' };

    await expect(resolveSavePath(download, dcs as unknown as DownloadClientService)).rejects.toThrow('missing client or external ID');
  });

  it('throws when download has no externalId', async () => {
    const dcs = mockDownloadClientService();
    const download = { id: 1, downloadClientId: 1, externalId: null };

    await expect(resolveSavePath(download, dcs as unknown as DownloadClientService)).rejects.toThrow('missing client or external ID');
  });

  it('throws when adapter is not found for downloadClientId', async () => {
    const dcs = { getAdapter: vi.fn().mockResolvedValue(null) };
    const download = { id: 1, downloadClientId: 99, externalId: 'ext-1' };

    await expect(resolveSavePath(download, dcs as unknown as DownloadClientService)).rejects.toThrow('not found');
  });

  it('throws when download item is not found in client', async () => {
    const adapter = { getDownload: vi.fn().mockResolvedValue(null) };
    const dcs = { getAdapter: vi.fn().mockResolvedValue(adapter) };
    const download = { id: 1, downloadClientId: 1, externalId: 'ext-1' };

    await expect(resolveSavePath(download, dcs as unknown as DownloadClientService)).rejects.toThrow('not found in client');
  });
});
