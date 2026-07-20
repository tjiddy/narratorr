import { describe, it, expect, beforeAll, afterAll, beforeEach, type vi } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { SubmissionError } from '../services/import-staging.service.js';

const UUID = '3f0f1a52-3b6e-4c1a-9d2b-2a4e6c8f0a11';
const DIGEST = 'a'.repeat(64);

function mockFn(services: Services, name: 'createSubmission' | 'putItems' | 'finalize' | 'getById' | 'getByClientId') {
  return services.importStaging[name] as unknown as ReturnType<typeof vi.fn>;
}

const summary = {
  id: 1, clientSubmissionId: UUID, source: 'library', status: 'receiving',
  expectedCount: 2, receivedCount: 0, processedCount: 0,
  aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 },
  detailsPruned: false, itemsIncluded: false,
  createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
};

describe('import-submissions routes (#1893)', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { resetMockServices(services); });

  describe('POST /api/import/submissions', () => {
    it('creates and returns the summary (200)', async () => {
      mockFn(services, 'createSubmission').mockResolvedValue(summary);
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 2 } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 1, status: 'receiving' });
    });

    it('rejects a bad digest with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: 'nothex', expectedCount: 2 } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects manual without mode with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'manual', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 2 } });
      expect(res.statusCode).toBe(400);
    });

    it('maps a digest conflict to 409 with the named code', async () => {
      mockFn(services, 'createSubmission').mockRejectedValue(new SubmissionError('submission-digest-conflict', 409, 'conflict'));
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 2 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('submission-digest-conflict');
    });
  });

  describe('PUT /api/import/submissions/:id/items', () => {
    const validRow = { ordinal: 0, item: { path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } } };

    it('accepts a valid body (200)', async () => {
      mockFn(services, 'putItems').mockResolvedValue(summary);
      const res = await app.inject({ method: 'PUT', url: '/api/import/submissions/1/items', payload: { items: [validRow] } });
      expect(res.statusCode).toBe(200);
    });

    it('rejects an over-bound item with 400 item-invalid', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/import/submissions/1/items', payload: { items: [{ ordinal: 0, item: { path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }], asin: 'a'.repeat(65) } } }] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('item-invalid');
    });

    it('maps an out-of-range ordinal SubmissionError to 400', async () => {
      mockFn(services, 'putItems').mockRejectedValue(new SubmissionError('ordinal-out-of-range', 400, 'oor'));
      const res = await app.inject({ method: 'PUT', url: '/api/import/submissions/1/items', payload: { items: [validRow] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('ordinal-out-of-range');
    });
  });

  describe('POST /api/import/submissions/:id/finalize', () => {
    it('returns 200 processing', async () => {
      mockFn(services, 'finalize').mockResolvedValue({ ...summary, status: 'processing' });
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions/1/finalize' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processing');
    });

    it('maps a gaps error to 409 with the bounded report', async () => {
      mockFn(services, 'finalize').mockRejectedValue(new SubmissionError('finalize-gaps', 409, 'gaps', { missing: [1], totalMissing: 1, truncated: false }));
      const res = await app.inject({ method: 'POST', url: '/api/import/submissions/1/finalize' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'finalize-gaps', gaps: { totalMissing: 1 } });
    });
  });

  describe('GET /api/import/submissions/:id (includeItems, F71)', () => {
    beforeEach(() => { mockFn(services, 'getById').mockResolvedValue(summary); });

    it('omitted → summary (service called with false)', async () => {
      await app.inject({ method: 'GET', url: '/api/import/submissions/1' });
      expect(mockFn(services, 'getById')).toHaveBeenCalledWith(1, false);
    });
    it('includeItems=true → detail (service called with true)', async () => {
      await app.inject({ method: 'GET', url: '/api/import/submissions/1?includeItems=true' });
      expect(mockFn(services, 'getById')).toHaveBeenCalledWith(1, true);
    });
    it('invalid includeItems value → 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/1?includeItems=yes' });
      expect(res.statusCode).toBe(400);
    });
    it('unknown query key → 400 (strict)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/1?bogus=1' });
      expect(res.statusCode).toBe(400);
    });
    it('unknown id → 404', async () => {
      mockFn(services, 'getById').mockRejectedValue(new SubmissionError('submission-not-found', 404, 'nf'));
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/999' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/import/submissions/by-client/:clientSubmissionId', () => {
    it('valid uuid → 200', async () => {
      mockFn(services, 'getByClientId').mockResolvedValue(summary);
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}` });
      expect(res.statusCode).toBe(200);
      expect(mockFn(services, 'getByClientId')).toHaveBeenCalledWith(UUID, false);
    });
    it('invalid uuid → 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/by-client/not-a-uuid' });
      expect(res.statusCode).toBe(400);
    });
  });
});
