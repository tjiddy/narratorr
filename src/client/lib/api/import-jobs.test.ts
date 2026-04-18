import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importJobsApi } from './import-jobs.js';

vi.mock('./client.js', () => ({
  fetchApi: vi.fn().mockResolvedValue([]),
}));

import { fetchApi } from './client.js';

describe('importJobsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getImportJobs calls /import-jobs with no params', async () => {
    await importJobsApi.getImportJobs();
    expect(fetchApi).toHaveBeenCalledWith('/import-jobs');
  });

  it('getImportJobs passes status query param', async () => {
    await importJobsApi.getImportJobs({ status: 'processing' });
    expect(fetchApi).toHaveBeenCalledWith('/import-jobs?status=processing');
  });
});
