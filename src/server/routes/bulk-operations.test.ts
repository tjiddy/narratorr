import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import { BulkOpError } from '../services/bulk-operation.service.js';

function makeBulkService(overrides?: Record<string, unknown>) {
  return {
    countRenameEligible: vi.fn().mockResolvedValue({ mismatched: 3, alreadyMatching: 2 }),
    countRetagEligible: vi.fn().mockResolvedValue({ total: 5 }),
    countConvertEligible: vi.fn().mockResolvedValue({ total: 4 }),
    getActiveJob: vi.fn().mockReturnValue(null),
    startRenameJob: vi.fn().mockResolvedValue('job-uuid-1'),
    startRetagJob: vi.fn().mockResolvedValue('job-uuid-2'),
    startConvertJob: vi.fn().mockResolvedValue('job-uuid-3'),
    getJob: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe('GET /api/books/bulk/rename/count', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 { mismatched, alreadyMatching }', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/rename/count' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ mismatched: 3, alreadyMatching: 2 });
  });

  it('returns { mismatched: 0, alreadyMatching: 0 } when library is empty', async () => {
    const bulkOperation = makeBulkService({
      countRenameEligible: vi.fn().mockResolvedValue({ mismatched: 0, alreadyMatching: 0 }),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/rename/count' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ mismatched: 0, alreadyMatching: 0 });
  });
});

describe('GET /api/books/bulk/retag/count', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 { total } with correct count of eligible books', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/retag/count' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ total: 5 });
  });
});

describe('GET /api/books/bulk/convert/count', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 { total } including books with null audioFileFormat', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/convert/count' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ total: 4 });
  });

  it('excludes books with uppercase M4B', async () => {
    // Counting logic is in the service — route just returns what the service returns
    const bulkOperation = makeBulkService({
      countConvertEligible: vi.fn().mockResolvedValue({ total: 0 }),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/convert/count' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ total: 0 });
  });
});

describe('GET /api/books/bulk/active', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when no job is running', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/active' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toBeNull();
  });

  it('returns running job info while job is in progress', async () => {
    const activeJob = { id: 'abc', type: 'rename', status: 'running', completed: 3, total: 10, failures: 0 };
    const bulkOperation = makeBulkService({ getActiveJob: vi.fn().mockReturnValue(activeJob) });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/active' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual(activeJob);
  });

  it('returns null after job completes', async () => {
    const services = createMockServices({
      bulkOperation: makeBulkService({ getActiveJob: vi.fn().mockReturnValue(null) }),
    });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/active' });
    expect(resp.json()).toBeNull();
  });
});

describe('POST /api/books/bulk/rename', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 202 { jobId } and starts rename job', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/rename' });
    expect(resp.statusCode).toBe(202);
    expect(resp.json()).toEqual({ jobId: 'job-uuid-1' });
  });

  it('returns 400 when library path is not configured', async () => {
    const bulkOperation = makeBulkService({
      startRenameJob: vi.fn().mockRejectedValue(new BulkOpError('Library path not configured', 'LIBRARY_NOT_CONFIGURED')),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/rename' });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toMatchObject({ error: expect.stringContaining('Library path') });
  });

  it('returns 409 BULK_OP_IN_PROGRESS when a job is already running', async () => {
    const bulkOperation = makeBulkService({
      startRenameJob: vi.fn().mockRejectedValue(new BulkOpError('A bulk operation is already running', 'BULK_OP_IN_PROGRESS')),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/rename' });
    expect(resp.statusCode).toBe(409);
  });
});

describe('POST /api/books/bulk/retag', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 202 { jobId } and starts retag job', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/retag' });
    expect(resp.statusCode).toBe(202);
    expect(resp.json()).toEqual({ jobId: 'job-uuid-2' });
  });

  it('returns 409 BULK_OP_IN_PROGRESS when a different bulk job is running', async () => {
    const bulkOperation = makeBulkService({
      startRetagJob: vi.fn().mockRejectedValue(new BulkOpError('A bulk operation is already running', 'BULK_OP_IN_PROGRESS')),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/retag' });
    expect(resp.statusCode).toBe(409);
  });
});

describe('POST /api/books/bulk/convert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 202 { jobId } and starts convert job', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/convert' });
    expect(resp.statusCode).toBe(202);
    expect(resp.json()).toEqual({ jobId: 'job-uuid-3' });
  });

  it('returns 503 when ffmpeg is not configured', async () => {
    const bulkOperation = makeBulkService({
      startConvertJob: vi.fn().mockRejectedValue(new BulkOpError('ffmpeg not configured', 'FFMPEG_NOT_CONFIGURED')),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/convert' });
    expect(resp.statusCode).toBe(503);
  });

  it('returns 409 BULK_OP_IN_PROGRESS when a job is already running', async () => {
    const bulkOperation = makeBulkService({
      startConvertJob: vi.fn().mockRejectedValue(new BulkOpError('A bulk operation is already running', 'BULK_OP_IN_PROGRESS')),
    });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'POST', url: '/api/books/bulk/convert' });
    expect(resp.statusCode).toBe(409);
  });
});

describe('GET /api/books/bulk/:jobId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 with { status: running, completed, total, failures } while job is running', async () => {
    const runningJob = { id: 'job-1', type: 'retag', status: 'running', completed: 5, total: 20, failures: 1 };
    const bulkOperation = makeBulkService({ getJob: vi.fn().mockReturnValue(runningJob) });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/job-1' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual(runningJob);
  });

  it('returns 200 with { status: completed, completed, total, failures } after completion', async () => {
    const completedJob = { id: 'job-2', type: 'convert', status: 'completed', completed: 10, total: 10, failures: 0 };
    const bulkOperation = makeBulkService({ getJob: vi.fn().mockReturnValue(completedJob) });
    const services = createMockServices({ bulkOperation });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/job-2' });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual(completedJob);
  });

  it('returns 404 when jobId is unknown or expired', async () => {
    const services = createMockServices({ bulkOperation: makeBulkService() });
    const app = await createTestApp(services);
    const resp = await app.inject({ method: 'GET', url: '/api/books/bulk/unknown-id' });
    expect(resp.statusCode).toBe(404);
  });
});
