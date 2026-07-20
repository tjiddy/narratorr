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
    service = new ImportStagingService(db, noopLog, nudge as unknown as () => void);
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

  // ── F1: atomic PUT/finalize serialization ────────────────────────────────
  describe('atomic state transitions (F1)', () => {
    const itemBytes = (it: StagedImportItem): number => Buffer.byteLength(JSON.stringify(it), 'utf8');

    it('two concurrent chunks crossing the byte cap: exactly one is rejected and receivedBytes never exceeds the cap', async () => {
      await service.createSubmission(createBody);
      // Each chunk carries one equal-sized item. Seed receivedBytes so ONE chunk fits
      // (receivedBytes + B ≤ cap) but the SECOND cannot (receivedBytes + 2B > cap).
      const b = itemBytes(items[0]!);
      expect(itemBytes(items[1]!)).toBe(b); // '/a','A' vs '/b','B' — equal byte size
      const seed = MAX_SUBMISSION_BYTES - b - Math.floor(b / 2);
      await db.update(importSubmissions).set({ receivedBytes: seed }).where(eq(importSubmissions.id, 1));

      // Whichever chunk wins the SQLite write lock commits; the loser's whole tx
      // rolls back — either with the deterministic 413 (if it observed the updated
      // counters) or a transient SQLITE_BUSY that the staged client retries. The
      // load-bearing invariant is that the two can NEVER both apply: exactly one
      // chunk persists and receivedBytes never crosses the cap (no lost increment).
      const results = await Promise.allSettled([
        service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }),
        service.putItems(1, { items: [{ ordinal: 1, item: items[1]! }] }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.receivedBytes).toBeLessThanOrEqual(MAX_SUBMISSION_BYTES);
      expect(h!.receivedBytes).toBe(seed + b); // exactly one chunk's bytes accrued
      expect(h!.receivedCount).toBe(1);
      expect(await db.select().from(importSubmissionItems)).toHaveLength(1);
    });

    it('concurrent PUT vs finalize never both apply: no ordinal leaks past the flip', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

      const results = await Promise.allSettled([
        service.finalize(1),
        service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }), // identical re-PUT
      ]);
      // finalize is retried until it wins the lock; it always ends the header in processing.
      if (results[0]!.status === 'rejected') {
        await service.finalize(1); // a lock-loss on finalize is retryable and idempotent
      }
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('processing');
      // No extra ordinals leaked and the count is unchanged regardless of interleaving.
      expect(h!.receivedCount).toBe(2);
      expect(await db.select().from(importSubmissionItems)).toHaveLength(2);
    });
  });

  // ── F7: summary polling excludes item payloads ───────────────────────────
  it('summary poll returns live aggregates without any items key while detail loads them (F7)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    await service.finalize(1);
    // Drive dispositions directly (runner-independent) to give the summary live counts.
    await db.update(importSubmissionItems).set({ disposition: 'accepted' }).where(eq(importSubmissionItems.ordinal, 0));
    await db.update(importSubmissionItems).set({ disposition: 'held' }).where(eq(importSubmissionItems.ordinal, 1));

    const summary = await service.getById(1, false);
    expect(summary.itemsIncluded).toBe(false);
    expect('items' in summary).toBe(false);
    expect(summary.aggregates).toEqual({ accepted: 1, held: 1, skipped: 0, failed: 0 });
    expect(summary.processedCount).toBe(2);

    const detail = await service.getById(1, true);
    expect(detail.itemsIncluded).toBe(true);
    if (detail.itemsIncluded) expect(detail.items).toHaveLength(2);
  });

  // ── F12: retention method behavior ───────────────────────────────────────
  describe('retention & GC (F12)', () => {
    const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
    const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

    async function seedReceiving(clientId: string, updatedAt: Date): Promise<number> {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, status: 'receiving', updatedAt,
      }).returning();
      await db.insert(importSubmissionItems).values({ submissionId: row!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'pending' });
      return row!.id;
    }

    it('sweeps a receiving header older than 48h, keeps one just under, and cascades items', async () => {
      const stale = await seedReceiving('recv-stale', hoursAgo(49));
      const fresh = await seedReceiving('recv-fresh', hoursAgo(47));

      const deleted = await service.sweepStaleReceiving();
      expect(deleted).toBe(1);
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, stale))).toHaveLength(0);
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, fresh))).toHaveLength(1);
      // Cascade: the stale header's item row is gone; the fresh one's remains.
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, stale))).toHaveLength(0);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, fresh))).toHaveLength(1);
    });

    it('never sweeps a finalized (processing/complete) header regardless of age', async () => {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: 'proc-old', payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, status: 'processing', updatedAt: hoursAgo(200),
      }).returning();
      const deleted = await service.sweepStaleReceiving();
      expect(deleted).toBe(0);
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, row!.id))).toHaveLength(1);
    });

    async function seedComplete(clientId: string, completedAt: Date): Promise<number> {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, status: 'complete', receivedCount: 1, acceptedCount: 1, completedAt, updatedAt: completedAt,
      }).returning();
      await db.insert(importSubmissionItems).values({ submissionId: row!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted' });
      return row!.id;
    }

    it('prunes completed item details strictly beyond retention and keeps ones within the window', async () => {
      const old = await seedComplete('done-old', daysAgo(91));
      const recent = await seedComplete('done-recent', daysAgo(89));

      const pruned = await service.pruneCompletedDetails(90);
      expect(pruned).toBe(1);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, old))).toHaveLength(0);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, recent))).toHaveLength(1);
      // The pruned submission's HEADER + aggregate columns survive indefinitely.
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, old));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(1);
    });

    it('complete → prune → GET returns retained aggregates with detailsPruned:true and no items', async () => {
      const id = await seedComplete('done-prune-get', daysAgo(120));
      await service.pruneCompletedDetails(90);

      const res = await service.getById(id, true);
      expect(res.detailsPruned).toBe(true);
      expect(res.itemsIncluded).toBe(false);
      expect('items' in res).toBe(false);
      expect(res.aggregates).toEqual({ accepted: 1, held: 0, skipped: 0, failed: 0 });
    });

    it('does not sweep a receiving header that a concurrent PUT just refreshed (updatedAt guard)', async () => {
      await service.createSubmission(createBody); // id 1, updatedAt ≈ now
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }); // bumps updatedAt to now
      const deleted = await service.sweepStaleReceiving();
      expect(deleted).toBe(0);
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1))).toHaveLength(1);
    });
  });
});
