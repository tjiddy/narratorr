import { describe, it, expect } from 'vitest';
import { DownloadError as LeafDownloadError, DuplicateDownloadError as LeafDuplicateDownloadError } from './download-errors.js';
import {
  DownloadError as ServiceDownloadError,
  DuplicateDownloadError as ServiceDuplicateDownloadError,
} from './download.service.js';

describe('download-errors leaf module / back-compat re-export', () => {
  it('resolves DownloadError to the same class reference from both import paths', () => {
    expect(LeafDownloadError).toBe(ServiceDownloadError);
  });

  it('resolves DuplicateDownloadError to the same class reference from both import paths', () => {
    expect(LeafDuplicateDownloadError).toBe(ServiceDuplicateDownloadError);
  });

  it('round-trips instanceof regardless of which path constructed or checks the error', () => {
    const fromLeaf = new LeafDownloadError('not found', 'NOT_FOUND');
    const fromService = new ServiceDownloadError('not found', 'NOT_FOUND');

    expect(fromLeaf).toBeInstanceOf(ServiceDownloadError);
    expect(fromService).toBeInstanceOf(LeafDownloadError);

    const dupFromLeaf = new LeafDuplicateDownloadError('dup', 'ACTIVE_DOWNLOAD_EXISTS');
    const dupFromService = new ServiceDuplicateDownloadError('dup', 'PIPELINE_ACTIVE');

    expect(dupFromLeaf).toBeInstanceOf(ServiceDuplicateDownloadError);
    expect(dupFromService).toBeInstanceOf(LeafDuplicateDownloadError);
  });

  it('preserves name and code on both error classes', () => {
    const dl = new LeafDownloadError('bad status', 'INVALID_STATUS');
    expect(dl.name).toBe('DownloadError');
    expect(dl.code).toBe('INVALID_STATUS');

    const dup = new LeafDuplicateDownloadError('active', 'ACTIVE_DOWNLOAD_EXISTS');
    expect(dup.name).toBe('DuplicateDownloadError');
    expect(dup.code).toBe('ACTIVE_DOWNLOAD_EXISTS');
  });
});
