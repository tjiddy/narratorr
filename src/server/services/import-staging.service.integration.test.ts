import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { importSubmissions, importSubmissionItems, books } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { ImportStagingService } from './import-staging.service.js';
import { serializeSubmissionForDigest, MAX_SUBMISSION_BYTES, type StagedImportItem } from '../../core/import-staging/schemas.js';
import type { FastifyBaseLogger } from 'fastify';

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return noopLog; }, level: 'info', silent() {},
} as unknown as FastifyBaseLogger;

const UUID = '3f0f1a52-3b6e-4c1a-9d2b-2a4e6c8f0a11';

function item(path: string, title: string): StagedImportItem {
  return { path, title, metadata: { title, authors: [{ name: 'Author' }] } };
}

function libraryDigest(items: StagedImportItem[]): string {
  return createHash('sha256').update(serializeSubmissionForDigest({ source: 'library', items })).digest('hex');
}

describe('ImportStagingService (DB-backed, #1893)', () => {
  let dir: string;
  let db: Db;
  let nudge: ReturnType<typeof vi.fn>;
  let service: ImportStagingService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'staging-svc-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    nudge = vi.fn();
    service = new ImportStagingService(db, noopLog, nudge);
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const items = [item('/a', 'A'), item('/b', 'B')];
  const digest = libraryDigest(items);
  const createBody = { source: 'library' as const, clientSubmissionId: UUID, payloadDigest: digest, expectedCount: 2 };

  describe('create-or-return', () => {
    it('creates a receiving header and returns the summary arm', async () => {
      const res = await service.createSubmission(createBody);
      expect(res.status).toBe('receiving');
      expect(res.itemsIncluded).toBe(false);
      expect(res.expectedCount).toBe(2);
    });

    it('returns the same header for a replayed identical create (no second row)', async () => {
      const a = await service.createSubmission(createBody);
      const b = await service.createSubmission(createBody);
      expect(b.id).toBe(a.id);
      const rows = await db.select().from(importSubmissions);
      expect(rows).toHaveLength(1);
    });

    it('rejects same id + different digest with a typed 409', async () => {
      await service.createSubmission(createBody);
      await expect(service.createSubmission({ ...createBody, payloadDigest: 'b'.repeat(64) }))
        .rejects.toMatchObject({ httpStatus: 409, code: 'submission-digest-conflict' });
    });
  });

  describe('PUT items', () => {
    beforeEach(async () => { await service.createSubmission(createBody); });

    it('stores ordinals, accrues receivedCount/receivedBytes, and is a no-op on identical re-PUT', async () => {
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      const afterFirst = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      const bytesAfterFirst = afterFirst[0]!.receivedBytes;
      expect(afterFirst[0]!.receivedCount).toBe(1);
      expect(bytesAfterFirst).toBeGreaterThan(0);

      // Identical re-PUT adds zero.
      const res = await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      expect(res.receivedCount).toBe(1);
      const afterSecond = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(afterSecond[0]!.receivedBytes).toBe(bytesAfterFirst);
    });

    it('rejects an out-of-range ordinal with 400 ordinal-out-of-range and no write', async () => {
      await expect(service.putItems(1, { items: [{ ordinal: 2, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 400, code: 'ordinal-out-of-range' });
      await expect(service.putItems(1, { items: [{ ordinal: -1, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 400, code: 'ordinal-out-of-range' });
      expect(await db.select().from(importSubmissionItems)).toHaveLength(0);
    });

    it('rejects duplicate ordinals in one request with 409 and no partial write', async () => {
      await expect(service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 0, item: items[1]! }] }))
        .rejects.toMatchObject({ httpStatus: 409, code: 'ordinal-conflict' });
      expect(await db.select().from(importSubmissionItems)).toHaveLength(0);
    });

    it('rejects conflicting content for an already-stored ordinal with 409', async () => {
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      await expect(service.putItems(1, { items: [{ ordinal: 0, item: items[1]! }] }))
        .rejects.toMatchObject({ httpStatus: 409, code: 'ordinal-content-conflict' });
    });

    it('rejects a PUT crossing the byte budget with 413 and no state change', async () => {
      // Pre-seed receivedBytes near the cap so a small PUT crosses it.
      await db.update(importSubmissions).set({ receivedBytes: MAX_SUBMISSION_BYTES }).where(eq(importSubmissions.id, 1));
      await expect(service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 413, code: 'submission-byte-budget-exceeded' });
      expect(await db.select().from(importSubmissionItems)).toHaveLength(0);
    });

    it('rejects a PUT after finalize with 409 submission-not-receiving', async () => {
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
      await service.finalize(1);
      await expect(service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 409, code: 'submission-not-receiving' });
    });
  });

  describe('finalize', () => {
    beforeEach(async () => { await service.createSubmission(createBody); });

    it('gaps → 409 with a bounded report and no state change', async () => {
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      await expect(service.finalize(1)).rejects.toMatchObject({ httpStatus: 409, code: 'finalize-gaps' });
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('receiving');
    });

    it('digest mismatch → 409 with no state change', async () => {
      // Store the correct items but under a header whose digest was set to a wrong value.
      await db.update(importSubmissions).set({ payloadDigest: 'c'.repeat(64) }).where(eq(importSubmissions.id, 1));
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
      await expect(service.finalize(1)).rejects.toMatchObject({ httpStatus: 409, code: 'submission-digest-mismatch' });
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('receiving');
    });

    it('complete upload → CAS flip to processing, nudges once; replay is a no-op with no re-nudge', async () => {
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
      const res = await service.finalize(1);
      expect(res.status).toBe('processing');
      expect(nudge).toHaveBeenCalledTimes(1);

      const replay = await service.finalize(1);
      expect(replay.status).toBe('processing');
      expect(nudge).toHaveBeenCalledTimes(1); // no re-nudge
    });
  });

  describe('GET arms', () => {
    it('unknown id → typed 404', async () => {
      await expect(service.getById(999, false)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('summary arm during processing has itemsIncluded false and no items', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
      await service.finalize(1);
      const res = await service.getById(1, false);
      expect(res.itemsIncluded).toBe(false);
      expect('items' in res).toBe(false);
    });

    it('detail arm returns item rows ordered by ordinal', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 1, item: items[1]! }, { ordinal: 0, item: items[0]! }] });
      const res = await service.getById(1, true);
      expect(res.itemsIncluded).toBe(true);
      if (res.itemsIncluded) {
        expect(res.items.map((i) => i.ordinal)).toEqual([0, 1]);
        expect(res.items.every((i) => i.disposition === 'pending')).toBe(true);
      }
    });

    it('by-client lookup returns the header', async () => {
      await service.createSubmission(createBody);
      const res = await service.getByClientId(UUID, false);
      expect(res.clientSubmissionId).toBe(UUID);
    });

    it('detail + pruned complete header → summary arm with detailsPruned true, no items', async () => {
      // Seed a complete header with frozen aggregates and NO item rows (post-prune).
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: 'pruned-1', payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 3, status: 'complete', receivedCount: 3,
        acceptedCount: 2, heldCount: 0, skippedCount: 1, failedCount: 0, completedAt: new Date(),
      }).returning();
      const res = await service.getById(row!.id, true);
      expect(res.detailsPruned).toBe(true);
      expect(res.itemsIncluded).toBe(false);
      expect(res.aggregates).toEqual({ accepted: 2, held: 0, skipped: 1, failed: 0 });
      expect(res.processedCount).toBe(3);
    });
  });

  it('inert invariant: no books or item dispositions change before finalize', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    expect(await db.select().from(books)).toHaveLength(0);
    const rows = await db.select().from(importSubmissionItems);
    expect(rows.every((r) => r.disposition === 'pending')).toBe(true);
  });
});
