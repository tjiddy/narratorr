import { describe, it, expect, beforeAll, afterAll, beforeEach, type vi } from 'vitest';
import { createTestApp, createMockServices, resetMockServices, installMockAppLog } from '../__tests__/helpers.js';
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

    it('rejects invalid clientSubmissionId shapes with 400 (F32 — same validator as by-client)', async () => {
      for (const bad of ['not-a-uuid', '0'.repeat(36), '3f0f1a52-3b6e-0c1a-9d2b-2a4e6c8f0a11', '3f0f1a52-3b6e-4c1a-cd2b-2a4e6c8f0a11', UUID + '0']) {
        const res = await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: bad, payloadDigest: DIGEST, expectedCount: 2 } });
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects expectedCount 0 and > max with 400, accepts exactly max (F33)', async () => {
      mockFn(services, 'createSubmission').mockResolvedValue(summary);
      expect((await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 0 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 10001 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 10000 } })).statusCode).toBe(200);
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
    it('includeItems=true → report service projection, NOT staging.getById (F87)', async () => {
      const reportDetail = services.importSubmissionReport.reportDetail as unknown as ReturnType<typeof vi.fn>;
      reportDetail.mockResolvedValue({ ...summary, itemsIncluded: true, items: [] });
      await app.inject({ method: 'GET', url: '/api/import/submissions/1?includeItems=true' });
      expect(reportDetail).toHaveBeenCalledWith(1);
      expect(mockFn(services, 'getById')).not.toHaveBeenCalled();
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

    it('logs a serialized error when getById fails unexpectedly, then rethrows (F30)', async () => {
      const { spies, restore } = installMockAppLog(app);
      mockFn(services, 'getById').mockRejectedValue(new Error('projection boom'));
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/7' });
      expect(res.statusCode).toBe(500); // rethrown to the generic handler
      expect(spies.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'projection boom' }), submissionId: 7 }),
        expect.stringContaining('GET by id'),
      );
      restore();
    });
  });

  describe('GET /api/import/submissions/by-client/:clientSubmissionId (F14 — same query-selected DTO contract)', () => {
    const detail = {
      ...summary, itemsIncluded: true,
      items: [{ disposition: 'pending', ordinal: 0, path: '/a', title: 'A' }],
    };

    it('omitted includeItems → summary (service called with false)', async () => {
      mockFn(services, 'getByClientId').mockResolvedValue(summary);
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}` });
      expect(res.statusCode).toBe(200);
      expect(mockFn(services, 'getByClientId')).toHaveBeenCalledWith(UUID, false);
      expect(res.json().itemsIncluded).toBe(false);
      expect('items' in res.json()).toBe(false);
    });

    it('includeItems=false → summary (service called with false)', async () => {
      mockFn(services, 'getByClientId').mockResolvedValue(summary);
      await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}?includeItems=false` });
      expect(mockFn(services, 'getByClientId')).toHaveBeenCalledWith(UUID, false);
    });

    it('includeItems=true → detail (service called with true, items present)', async () => {
      mockFn(services, 'getByClientId').mockResolvedValue(detail);
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}?includeItems=true` });
      expect(res.statusCode).toBe(200);
      expect(mockFn(services, 'getByClientId')).toHaveBeenCalledWith(UUID, true);
      expect(res.json().itemsIncluded).toBe(true);
      expect(res.json().items).toHaveLength(1);
    });

    it('invalid includeItems value → 400', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}?includeItems=yes` });
      expect(res.statusCode).toBe(400);
    });

    it('unknown query key → 400 (strict)', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}?bogus=1` });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid clientSubmissionId shapes with 400 (F32 — same validator as create)', async () => {
      for (const bad of ['not-a-uuid', '0'.repeat(36), '3f0f1a52-3b6e-0c1a-9d2b-2a4e6c8f0a11', '3f0f1a52-3b6e-4c1a-cd2b-2a4e6c8f0a11']) {
        const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${bad}` });
        expect(res.statusCode).toBe(400);
      }
    });

    it('unknown clientSubmissionId → 404', async () => {
      mockFn(services, 'getByClientId').mockRejectedValue(new SubmissionError('submission-not-found', 404, 'nf'));
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}` });
      expect(res.statusCode).toBe(404);
    });

    it('logs a serialized error when getByClientId fails unexpectedly, then rethrows (F30)', async () => {
      const { spies, restore } = installMockAppLog(app);
      mockFn(services, 'getByClientId').mockRejectedValue(new Error('lookup boom'));
      const res = await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}` });
      expect(res.statusCode).toBe(500);
      expect(spies.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'lookup boom' }), clientSubmissionId: UUID }),
        expect.stringContaining('GET by-client'),
      );
      restore();
    });
  });

  // F46: the id-scoped routes must use the canonical positive-integer contract.
  describe('numeric :id validation (canonical idParamSchema, F46)', () => {
    const validRow = { ordinal: 0, item: { path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } } };
    it('rejects non-numeric / zero / negative ids with 400 on GET, PUT, and finalize', async () => {
      for (const badId of ['abc', '0', '-1']) {
        expect((await app.inject({ method: 'GET', url: `/api/import/submissions/${badId}` })).statusCode).toBe(400);
        expect((await app.inject({ method: 'PUT', url: `/api/import/submissions/${badId}/items`, payload: { items: [validRow] } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: `/api/import/submissions/${badId}/finalize` })).statusCode).toBe(400);
      }
    });
    it('accepts a valid positive id', async () => {
      mockFn(services, 'getById').mockResolvedValue(summary);
      expect((await app.inject({ method: 'GET', url: '/api/import/submissions/1' })).statusCode).toBe(200);
    });
  });

  // F47: every mutation-route catch must log a serialized error before rethrowing.
  describe('mutation-route error diagnostics (F47)', () => {
    const validRow = { ordinal: 0, item: { path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } } };
    const cases = [
      { name: 'create', fn: 'createSubmission' as const, msg: 'create', op: () => app.inject({ method: 'POST', url: '/api/import/submissions', payload: { source: 'library', clientSubmissionId: UUID, payloadDigest: DIGEST, expectedCount: 2 } }) },
      { name: 'PUT', fn: 'putItems' as const, msg: 'PUT', op: () => app.inject({ method: 'PUT', url: '/api/import/submissions/1/items', payload: { items: [validRow] } }) },
      { name: 'finalize', fn: 'finalize' as const, msg: 'finalize', op: () => app.inject({ method: 'POST', url: '/api/import/submissions/1/finalize' }) },
    ];
    for (const c of cases) {
      it(`logs a serialized error when ${c.name} fails unexpectedly, then returns 500`, async () => {
        const { spies, restore } = installMockAppLog(app);
        mockFn(services, c.fn).mockRejectedValue(new Error(`${c.name} boom`));
        const res = await c.op();
        expect(res.statusCode).toBe(500); // rethrown to the generic handler
        expect(spies.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: `${c.name} boom` }) }),
          expect.stringContaining(c.msg),
        );
        restore();
      });
    }
  });

  // ── #1894 read side ──────────────────────────────────────────────────────

  const reportList = () => services.importSubmissionReport.list as unknown as ReturnType<typeof vi.fn>;
  const reportAttention = () => services.importSubmissionReport.attention as unknown as ReturnType<typeof vi.fn>;
  const stagingDiscard = () => services.importStaging.discardReceiving as unknown as ReturnType<typeof vi.fn>;

  describe('GET /api/import/submissions (list, F56)', () => {
    it('returns the {data,total} envelope and passes coerced defaults', async () => {
      reportList().mockResolvedValue({ data: [summary], total: 1 });
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [summary], total: 1 });
      expect(reportList()).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    });

    it('coerces numeric-string limit and threads source', async () => {
      reportList().mockResolvedValue({ data: [], total: 0 });
      await app.inject({ method: 'GET', url: '/api/import/submissions?limit=1&source=library' });
      expect(reportList()).toHaveBeenCalledWith({ limit: 1, offset: 0, source: 'library' });
    });

    it('rejects invalid queries with 400 invalid-query', async () => {
      reportList().mockResolvedValue({ data: [], total: 0 });
      for (const q of ['source=bogus', 'limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=2.5', 'bogus=1']) {
        const res = await app.inject({ method: 'GET', url: `/api/import/submissions?${q}` });
        expect(res.statusCode, q).toBe(400);
        expect(res.json().error).toBe('invalid-query');
      }
    });

    it('latest arm — no submissions returns {data:[],total:0} (never 204)', async () => {
      reportList().mockResolvedValue({ data: [], total: 0 });
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions?limit=1&source=manual' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /api/import/submissions/attention', () => {
    it('returns the {data,watch} envelope', async () => {
      reportAttention().mockResolvedValue({ data: null, watch: true });
      const res = await app.inject({ method: 'GET', url: '/api/import/submissions/attention' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: null, watch: true });
      expect(reportAttention()).toHaveBeenCalledWith({});
    });

    it('threads source and rejects unknown keys / bad source with 400', async () => {
      reportAttention().mockResolvedValue({ data: null, watch: false });
      await app.inject({ method: 'GET', url: '/api/import/submissions/attention?source=library' });
      expect(reportAttention()).toHaveBeenCalledWith({ source: 'library' });
      for (const q of ['source=bogus', 'bogus=1']) {
        const res = await app.inject({ method: 'GET', url: `/api/import/submissions/attention?${q}` });
        expect(res.statusCode, q).toBe(400);
      }
    });
  });

  describe('DELETE /api/import/submissions/:id', () => {
    it('discards a receiving submission → 200 {success:true}', async () => {
      stagingDiscard().mockResolvedValue({ success: true });
      const res = await app.inject({ method: 'DELETE', url: '/api/import/submissions/5' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(stagingDiscard()).toHaveBeenCalledWith(5);
    });

    it('maps non-receiving → 409 and unknown → 404 via SubmissionError', async () => {
      stagingDiscard().mockRejectedValue(new SubmissionError('submission-not-receiving', 409, 'nope'));
      expect((await app.inject({ method: 'DELETE', url: '/api/import/submissions/5' })).statusCode).toBe(409);
      stagingDiscard().mockRejectedValue(new SubmissionError('submission-not-found', 404, 'gone'));
      expect((await app.inject({ method: 'DELETE', url: '/api/import/submissions/5' })).statusCode).toBe(404);
    });

    it('invalid id → 400', async () => {
      expect((await app.inject({ method: 'DELETE', url: '/api/import/submissions/abc' })).statusCode).toBe(400);
    });
  });

  describe('by-client GET stays on ImportStagingService (F87)', () => {
    it('includeItems=true routes to staging.getByClientId, not the report service', async () => {
      mockFn(services, 'getByClientId').mockResolvedValue({ ...summary, itemsIncluded: true, items: [] });
      await app.inject({ method: 'GET', url: `/api/import/submissions/by-client/${UUID}?includeItems=true` });
      expect(mockFn(services, 'getByClientId')).toHaveBeenCalledWith(UUID, true);
      expect(reportList()).not.toHaveBeenCalled();
    });
  });

  // F25 — the new read/discard routes must serialize + log an unexpected (non-typed)
  // rejection before rethrowing to the generic 500 handler.
  describe('#1894 read/discard route error diagnostics (F25)', () => {
    const cases = [
      { name: 'list', setup: () => reportList().mockRejectedValue(new Error('list boom')), op: () => app.inject({ method: 'GET', url: '/api/import/submissions' }), msg: 'list', boom: 'list boom' },
      { name: 'attention', setup: () => reportAttention().mockRejectedValue(new Error('attention boom')), op: () => app.inject({ method: 'GET', url: '/api/import/submissions/attention' }), msg: 'attention', boom: 'attention boom' },
      { name: 'discard', setup: () => stagingDiscard().mockRejectedValue(new Error('discard boom')), op: () => app.inject({ method: 'DELETE', url: '/api/import/submissions/5' }), msg: 'discard', boom: 'discard boom' },
    ];
    for (const c of cases) {
      it(`${c.name}: an unexpected rejection returns 500 and logs the serialized error`, async () => {
        const { spies, restore } = installMockAppLog(app);
        c.setup();
        const res = await c.op();
        expect(res.statusCode).toBe(500); // rethrown to the generic handler
        expect(spies.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: c.boom }) }),
          expect.stringContaining(c.msg),
        );
        restore();
      });
    }
  });
});
