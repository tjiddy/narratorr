import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { importSubmissions, importSubmissionItems, books, bookEvents, importJobs } from '@db/schema.js';
import { eq } from 'drizzle-orm';
import { ImportStagingService } from './import-staging.service.js';
import { serializeSubmissionForDigest, submissionResponseSchema, MAX_SUBMISSION_BYTES, EXPECTED_COUNT_MAX, type StagedImportItem } from '@core/import-staging/schemas.js';
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
  let dbFile: string;
  let db: Db;
  let nudge: ReturnType<typeof vi.fn>;
  let service: ImportStagingService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'staging-svc-'));
    dbFile = join(dir, 'narratorr.db');
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

    it('a create whose existence check missed still returns the existing header via the unique-violation reread (F15)', async () => {
      await service.createSubmission(createBody);
      // Force the pre-insert lookup to miss the raced row; the unique-index catch must reread it.
      const spy = vi.spyOn(service as unknown as { findHeaderByClientId: (id: string) => Promise<unknown> }, 'findHeaderByClientId');
      spy.mockResolvedValueOnce(undefined);
      const res = await service.createSubmission(createBody);
      expect(res.id).toBe(1);
      expect(await db.select().from(importSubmissions)).toHaveLength(1);
      spy.mockRestore();
    });

    it('a raced create with a DIFFERENT digest surfaces the typed 409 after the reread (F15)', async () => {
      await service.createSubmission(createBody);
      const spy = vi.spyOn(service as unknown as { findHeaderByClientId: (id: string) => Promise<unknown> }, 'findHeaderByClientId');
      spy.mockResolvedValueOnce(undefined);
      await expect(service.createSubmission({ ...createBody, payloadDigest: 'e'.repeat(64) }))
        .rejects.toMatchObject({ httpStatus: 409, code: 'submission-digest-conflict' });
      spy.mockRestore();
    });

    it('two concurrent identical creates both resolve to the same header id with one row (F15)', async () => {
      const results = await Promise.allSettled([
        service.createSubmission(createBody),
        service.createSubmission(createBody),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const ids = results.map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id);
      expect(ids[0]).toBe(ids[1]);
      expect(await db.select().from(importSubmissions)).toHaveLength(1);
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
      expect(nudge).toHaveBeenCalledTimes(1);
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

  describe('atomic state transitions (F1)', () => {
    const itemBytes = (it: StagedImportItem): number => Buffer.byteLength(JSON.stringify(it), 'utf8');

    it('two concurrent chunks crossing the byte cap: exactly one is rejected and receivedBytes never exceeds the cap', async () => {
      await service.createSubmission(createBody);
      // Each chunk is equal-sized; seed so one fits but the second cannot.
      const b = itemBytes(items[0]!);
      expect(itemBytes(items[1]!)).toBe(b);
      const seed = MAX_SUBMISSION_BYTES - b - Math.floor(b / 2);
      await db.update(importSubmissions).set({ receivedBytes: seed }).where(eq(importSubmissions.id, 1));

      // SQLite may reject the loser with 413 or SQLITE_BUSY; only one transaction may persist.
      const results = await Promise.allSettled([
        service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }),
        service.putItems(1, { items: [{ ordinal: 1, item: items[1]! }] }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.receivedBytes).toBeLessThanOrEqual(MAX_SUBMISSION_BYTES);
      expect(h!.receivedBytes).toBe(seed + b);
      expect(h!.receivedCount).toBe(1);
      expect(await db.select().from(importSubmissionItems)).toHaveLength(1);
    });

    it('concurrent PUT vs finalize never both apply: no ordinal leaks past the flip', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

      const results = await Promise.allSettled([
        service.finalize(1),
        service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }),
      ]);
      // A finalize lock loss is retryable and idempotent.
      if (results[0]!.status === 'rejected') {
        await service.finalize(1);
      }
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('processing');
      expect(h!.receivedCount).toBe(2);
      expect(await db.select().from(importSubmissionItems)).toHaveLength(2);
    });
  });

  it('summary poll returns live aggregates without any items key while detail loads them (F7)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    await service.finalize(1);
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

  it('summary poll issues no full-row item SELECT; the detail arm does (F16 deletion heuristic)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    await service.finalize(1);

    // A no-arg select loads itemPayload; the header accounts for one, and only detail may add another.
    const selectSpy = vi.spyOn(db, 'select');

    await service.getById(1, false);
    const summaryNoArgSelects = selectSpy.mock.calls.filter((c) => c[0] === undefined).length;
    expect(selectSpy.mock.calls.some((c) => c[0] !== undefined && 'disposition' in (c[0] as object))).toBe(true);

    selectSpy.mockClear();
    await service.getById(1, true);
    const detailNoArgSelects = selectSpy.mock.calls.filter((c) => c[0] === undefined).length;

    expect(summaryNoArgSelects).toBe(1);
    expect(detailNoArgSelects).toBeGreaterThan(summaryNoArgSelects);
    selectSpy.mockRestore();
  });

  describe('byte-cap inclusive boundary (F21)', () => {
    const itemBytes = (it: StagedImportItem): number => Buffer.byteLength(JSON.stringify(it), 'utf8');

    async function seedReceivingAtBytes(clientId: string, receivedBytes: number): Promise<number> {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 2, status: 'receiving', receivedBytes,
      }).returning();
      return row!.id;
    }

    it('accepts a PUT landing just below the cap', async () => {
      const b = itemBytes(items[0]!);
      const id = await seedReceivingAtBytes('cap-below', MAX_SUBMISSION_BYTES - b - 1);
      const res = await service.putItems(id, { items: [{ ordinal: 0, item: items[0]! }] });
      expect(res.receivedCount).toBe(1);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
      expect(h!.receivedBytes).toBe(MAX_SUBMISSION_BYTES - 1);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(1);
    });

    it('accepts a PUT landing EXACTLY at the cap (proves inclusive <=, not <)', async () => {
      const b = itemBytes(items[0]!);
      const id = await seedReceivingAtBytes('cap-at', MAX_SUBMISSION_BYTES - b);
      const res = await service.putItems(id, { items: [{ ordinal: 0, item: items[0]! }] });
      expect(res.receivedCount).toBe(1);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
      expect(h!.receivedBytes).toBe(MAX_SUBMISSION_BYTES);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(1);
    });

    it('rejects a PUT one byte over the cap with 413 and no state change', async () => {
      const b = itemBytes(items[0]!);
      const id = await seedReceivingAtBytes('cap-over', MAX_SUBMISSION_BYTES - b + 1);
      await expect(service.putItems(id, { items: [{ ordinal: 0, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 413, code: 'submission-byte-budget-exceeded' });
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
      expect(h!.receivedBytes).toBe(MAX_SUBMISSION_BYTES - b + 1);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(0);
    });
  });

  it('finalize on a max-count sparse submission returns a bounded gaps report (≤100 ordered, totalMissing, truncated) (F22/F33)', async () => {
    const expectedCount = EXPECTED_COUNT_MAX;
    const [row] = await db.insert(importSubmissions).values({
      clientSubmissionId: 'sparse-gaps', payloadDigest: 'a'.repeat(64), source: 'library',
      expectedCount, status: 'receiving',
    }).returning();
    await service.putItems(row!.id, { items: [{ ordinal: 0, item: items[0]! }] });

    try {
      await service.finalize(row!.id);
      throw new Error('expected finalize to reject with a gaps report');
    } catch (err) {
      const gaps = (err as { code: string; gaps?: { missing: number[]; totalMissing: number; truncated: boolean } });
      expect(gaps.code).toBe('finalize-gaps');
      expect(gaps.gaps!.missing).toHaveLength(100);
      expect(gaps.gaps!.missing[0]).toBe(1);
      expect(gaps.gaps!.missing).toEqual([...gaps.gaps!.missing].sort((a, b) => a - b));
      expect(gaps.gaps!.totalMissing).toBe(expectedCount - 1);
      expect(gaps.gaps!.truncated).toBe(true);
    }
    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, row!.id));
    expect(h!.status).toBe('receiving');
  });

  it('projects every terminal disposition through toItemDto and reflects accepted-book deletion (F31/F50)', async () => {
    const [placeholder] = await db.insert(books).values({ publicId: 'ph-term', title: 'Placeholder', status: 'importing' }).returning();
    const [incumbent] = await db.insert(books).values({ publicId: 'inc-term', title: 'Incumbent', status: 'imported' }).returning();
    const [row] = await db.insert(importSubmissions).values({
      clientSubmissionId: 'term-proj', payloadDigest: 'a'.repeat(64), source: 'library',
      expectedCount: 4, status: 'complete', receivedCount: 4,
      acceptedCount: 1, heldCount: 1, skippedCount: 1, failedCount: 1, completedAt: new Date(),
    }).returning();
    const subId = row!.id;
    await db.insert(importSubmissionItems).values([
      { submissionId: subId, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted', bookId: placeholder!.id },
      { submissionId: subId, ordinal: 1, itemPayload: items[1]!, path: '/b', title: 'B', disposition: 'held', existingBookId: incumbent!.id },
      { submissionId: subId, ordinal: 2, itemPayload: items[0]!, path: '/c', title: 'C', disposition: 'skipped', reason: 'already-in-library', existingBookId: incumbent!.id, existingTitle: 'Incumbent' },
      { submissionId: subId, ordinal: 3, itemPayload: items[1]!, path: '/d', title: 'D', disposition: 'failed', reason: 'Import failed — see server logs for details.' },
    ]);

    const res = await service.getById(subId, true);
    expect(res.itemsIncluded).toBe(true);
    if (!res.itemsIncluded) throw new Error('expected detail arm');
    const byOrd = Object.fromEntries(res.items.map((i) => [i.ordinal, i])) as Record<number, Record<string, unknown>>;
    expect(byOrd[0]).toMatchObject({ disposition: 'accepted', bookId: placeholder!.id });
    expect(byOrd[0]!.item).toBeTruthy();
    expect(byOrd[1]).toMatchObject({ disposition: 'held', reason: 'recording-review-required', existingBookId: incumbent!.id });
    expect(byOrd[2]).toMatchObject({ disposition: 'skipped', reason: 'already-in-library', existingBookId: incumbent!.id, existingTitle: 'Incumbent' });
    expect(byOrd[3]).toMatchObject({ disposition: 'failed', message: 'Import failed — see server logs for details.' });
    expect(submissionResponseSchema.safeParse(res).success).toBe(true);

    await db.delete(books).where(eq(books.id, placeholder!.id));
    const res2 = await service.getById(subId, true);
    if (!res2.itemsIncluded) throw new Error('expected detail arm');
    const acc = res2.items.find((i) => i.ordinal === 0)!;
    expect(acc).toMatchObject({ disposition: 'accepted', bookId: null });
    expect(submissionResponseSchema.safeParse(res2).success).toBe(true);
  });

  it('GET detail projects a malformed accepted itemPayload as item:null (still schema-valid) + logs a warning; valid control keeps its item (F50)', async () => {
    const warnSpy = vi.spyOn(noopLog, 'warn');
    const [placeholder] = await db.insert(books).values({ publicId: 'ph-mal', title: 'PH', status: 'importing' }).returning();
    const [row] = await db.insert(importSubmissions).values({
      clientSubmissionId: 'mal-detail', payloadDigest: 'a'.repeat(64), source: 'library',
      expectedCount: 2, status: 'complete', receivedCount: 2, acceptedCount: 2, completedAt: new Date(),
    }).returning();
    const subId = row!.id;
    await db.insert(importSubmissionItems).values([
      { submissionId: subId, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted', bookId: placeholder!.id },
      { submissionId: subId, ordinal: 1, itemPayload: { bogus: true } as never, path: '/b', title: 'B', disposition: 'accepted', bookId: placeholder!.id },
    ]);

    const res = await service.getById(subId, true);
    expect(res.itemsIncluded).toBe(true);
    if (!res.itemsIncluded) throw new Error('expected detail arm');
    const byOrd = Object.fromEntries(res.items.map((i) => [i.ordinal, i])) as Record<number, Record<string, unknown>>;
    expect(byOrd[0]!.item).toBeTruthy();
    expect(byOrd[1]!.item).toBeNull();
    expect(submissionResponseSchema.safeParse(res).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: subId, ordinal: 1 }),
      expect.stringContaining('failed validation on read'),
    );
    warnSpy.mockRestore();
  });

  describe('persisted-item validation at mutation read boundaries (F41)', () => {
    it('re-PUT of an ordinal whose stored payload is malformed fails closed with 422 and no state change', async () => {
      await service.createSubmission(createBody);
      // SQLite does not enforce Drizzle's JSON $type.
      await db.insert(importSubmissionItems).values({ submissionId: 1, ordinal: 0, itemPayload: { bogus: true } as never, path: '/a', title: 'A', disposition: 'pending' });
      await db.update(importSubmissions).set({ receivedCount: 1, receivedBytes: 10 }).where(eq(importSubmissions.id, 1));

      await expect(service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] }))
        .rejects.toMatchObject({ code: 'item-invalid', httpStatus: 422 });

      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('receiving');
      expect(h!.receivedCount).toBe(1);
      expect(h!.receivedBytes).toBe(10);
    });

    it('finalize over a malformed persisted row fails closed with 422, no transition, and no nudge', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      await db.insert(importSubmissionItems).values({ submissionId: 1, ordinal: 1, itemPayload: { bogus: true } as never, path: '/b', title: 'B', disposition: 'pending' });

      await expect(service.finalize(1)).rejects.toMatchObject({ code: 'item-invalid', httpStatus: 422 });

      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
      expect(h!.status).toBe('receiving');
      expect(nudge).not.toHaveBeenCalled();
    });
  });

  it('recovers a lost finalize response via by-client lookup: summary → retained detail → pruned aggregate arm (F43)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    await service.finalize(1);

    const summary = await service.getByClientId(UUID, false);
    expect(summary.clientSubmissionId).toBe(UUID);
    expect(summary.status).toBe('processing');
    expect(summary.itemsIncluded).toBe(false);
    expect('items' in summary).toBe(false);

    const detail = await service.getByClientId(UUID, true);
    expect(detail.itemsIncluded).toBe(true);
    if (detail.itemsIncluded) {
      expect(detail.items.map((i) => i.ordinal)).toEqual([0, 1]);
    }

    await db.update(importSubmissions).set({ status: 'complete', receivedCount: 2, acceptedCount: 2, completedAt: new Date() }).where(eq(importSubmissions.id, 1));
    await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, 1));
    const pruned = await service.getByClientId(UUID, true);
    expect(pruned.detailsPruned).toBe(true);
    expect(pruned.itemsIncluded).toBe(false);
    expect('items' in pruned).toBe(false);
    expect(pruned.aggregates).toEqual({ accepted: 2, held: 0, skipped: 0, failed: 0 });
  });

  it('two simultaneous finalize callers on one service BOTH fulfill with the processing header and exactly one nudge (F36)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

    // The in-process write lane serializes both original promises; only the winning CAS nudges.
    const results = await Promise.allSettled([service.finalize(1), service.finalize(1)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      expect((r as PromiseFulfilledResult<{ status: string }>).value.status).toBe('processing');
    }
    expect(nudge).toHaveBeenCalledTimes(1);

    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
    expect(h!.status).toBe('processing');
    expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, 1))).toHaveLength(2);
  });

  // A distinct connection exercises SQLite locking and the durable-CAS backstop.
  it('finalize contention across SEPARATE connections still transitions once (F23 backstop)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

    const db2 = createDb(dbFile);
    const service2 = new ImportStagingService(db2, noopLog, nudge as unknown as () => void);
    const results = await Promise.allSettled([service.finalize(1), service2.finalize(1)]);
    db2.$client.close();
    for (const r of results) {
      if (r.status === 'rejected') await service.finalize(1); // Lock-loss is retryable and idempotent.
    }

    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
    expect(h!.status).toBe('processing');
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  describe('deleteSubmission (#1894 DELETE, broadened by #2220)', () => {
    async function putAll(id: number): Promise<void> {
      await service.putItems(id, { items: items.map((it, i) => ({ ordinal: i, item: it })) });
    }

    async function seedTerminal(clientId: string, counts: Partial<{ heldCount: number; skippedCount: number; failedCount: number }> = {}): Promise<number> {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, status: 'complete', receivedCount: 1, acceptedCount: 1,
        completedAt: new Date(), ...counts,
      }).returning();
      await db.insert(importSubmissionItems).values({ submissionId: row!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted' });
      return row!.id;
    }

    it('deletes a receiving header and cascades its items → {success:true} (pins the abandoned-upload Discard path)', async () => {
      const created = await service.createSubmission(createBody);
      await putAll(created.id);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, created.id))).toHaveLength(2);
      expect(await service.deleteSubmission(created.id)).toEqual({ success: true });
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, created.id))).toHaveLength(0);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, created.id))).toHaveLength(0);
    });

    it('deletes a complete header and cascades its items', async () => {
      const id = await seedTerminal('del-complete', { heldCount: 2, failedCount: 1 });
      expect(await service.deleteSubmission(id)).toEqual({ success: true });
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, id))).toHaveLength(0);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(0);
    });

    it('deletes a complete header whose details were already pruned (zero item rows)', async () => {
      const id = await seedTerminal('del-pruned');
      await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id));
      expect(await service.deleteSubmission(id)).toEqual({ success: true });
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, id))).toHaveLength(0);
    });

    it('a processing header is never deleted → 409 submission-in-flight', async () => {
      const created = await service.createSubmission(createBody);
      await putAll(created.id);
      await service.finalize(created.id);
      await expect(service.deleteSubmission(created.id)).rejects.toMatchObject({ httpStatus: 409, code: 'submission-in-flight' });
      const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, created.id));
      expect(hdr!.status).toBe('processing');
    });

    it('an unknown id → 404 submission-not-found', async () => {
      await expect(service.deleteSubmission(9999)).rejects.toMatchObject({ httpStatus: 404, code: 'submission-not-found' });
    });

    it('logs the deleted submission id at info, and logs nothing when the delete is refused', async () => {
      const info = vi.fn();
      const logged = new ImportStagingService(db, { ...noopLog, info } as unknown as FastifyBaseLogger, nudge as unknown as () => void);
      const id = await seedTerminal('del-logged');
      await logged.deleteSubmission(id);
      expect(info).toHaveBeenCalledWith({ submissionId: id }, expect.stringContaining('deleted'));

      info.mockClear();
      await expect(logged.deleteSubmission(9999)).rejects.toThrow();
      expect(info).not.toHaveBeenCalled();
    });

    it('delete racing finalize on the write lane: the finalized header survives, delete 409s (atomic WHERE status != processing)', async () => {
      const created = await service.createSubmission(createBody);
      await putAll(created.id);
      // The write lane preserves call order: finalize commits before the delete checks status.
      const [fin, del] = await Promise.allSettled([service.finalize(created.id), service.deleteSubmission(created.id)]);
      expect(fin.status).toBe('fulfilled');
      expect(del.status).toBe('rejected');
      expect((del as PromiseRejectedResult).reason).toMatchObject({ httpStatus: 409, code: 'submission-in-flight' });
      const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, created.id));
      expect(hdr!.status).toBe('processing');
    });
  });

  describe('deleteCleanCompleted (#2220 bulk clear)', () => {
    async function seedHeader(clientId: string, values: Partial<typeof importSubmissions.$inferInsert>): Promise<number> {
      const [row] = await db.insert(importSubmissions).values({
        clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, receivedCount: 1, status: 'complete', acceptedCount: 1, completedAt: new Date(),
        ...values,
      }).returning();
      await db.insert(importSubmissionItems).values({ submissionId: row!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted' });
      return row!.id;
    }

    async function seedMix(): Promise<{ clean: number; others: number[] }> {
      const clean = await seedHeader('mix-clean', {});
      const held = await seedHeader('mix-held', { heldCount: 1 });
      const skipped = await seedHeader('mix-skipped', { skippedCount: 1 });
      const failed = await seedHeader('mix-failed', { failedCount: 1 });
      const receiving = await seedHeader('mix-receiving', { status: 'receiving', completedAt: null });
      const processing = await seedHeader('mix-processing', { status: 'processing', completedAt: null });
      return { clean, others: [held, skipped, failed, receiving, processing] };
    }

    it('deletes exactly the clean completed run and returns its id, leaving every other header', async () => {
      const { clean, others } = await seedMix();

      expect(await service.deleteCleanCompleted()).toEqual({ deleted: 1, ids: [clean] });

      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, clean))).toHaveLength(0);
      for (const id of others) {
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, id))).toHaveLength(1);
      }
    });

    it('cascades only the deleted runs items; a surviving run keeps its own', async () => {
      const { clean, others } = await seedMix();
      await service.deleteCleanCompleted();
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, clean))).toHaveLength(0);
      for (const id of others) {
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(1);
      }
    });

    it('returns every deleted id, and the returned ids are exactly the headers that disappeared', async () => {
      const a = await seedHeader('multi-a', {});
      const b = await seedHeader('multi-b', {});
      const c = await seedHeader('multi-c', {});
      const kept = await seedHeader('multi-kept', { failedCount: 1 });

      const result = await service.deleteCleanCompleted();
      expect(result.deleted).toBe(result.ids.length);
      expect([...result.ids].sort((x, y) => x - y)).toEqual([a, b, c].sort((x, y) => x - y));

      const remaining = (await db.select({ id: importSubmissions.id }).from(importSubmissions)).map((r) => r.id);
      expect(remaining).toEqual([kept]);
    });

    it('with no matching row returns {deleted:0, ids:[]} and deletes nothing', async () => {
      await seedHeader('none-held', { heldCount: 1 });
      await seedHeader('none-processing', { status: 'processing', completedAt: null });

      expect(await service.deleteCleanCompleted()).toEqual({ deleted: 0, ids: [] });
      expect(await db.select().from(importSubmissions)).toHaveLength(2);
      expect(await db.select().from(importSubmissionItems)).toHaveLength(2);
    });

    it('reads the frozen header counters, so a clean run whose details were pruned is still eligible', async () => {
      const id = await seedHeader('clean-pruned', {});
      await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id));
      expect(await service.deleteCleanCompleted()).toEqual({ deleted: 1, ids: [id] });
    });

    it('logs the deleted count at info', async () => {
      const info = vi.fn();
      const logged = new ImportStagingService(db, { ...noopLog, info } as unknown as FastifyBaseLogger, nudge as unknown as () => void);
      await seedHeader('logged-clean', {});
      await logged.deleteCleanCompleted();
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), expect.stringContaining('cleared'));
    });
  });

  // The confirm copy promises exactly this: the report goes, the library and its trail stay.
  describe('deleting a run leaves the imported book, its events, and its import jobs (#2220)', () => {
    it('removes only the submission and its items', async () => {
      const [book] = await db.insert(books).values({ publicId: 'kept-book', title: 'Kept Book', status: 'imported' }).returning();
      const [event] = await db.insert(bookEvents).values({ bookId: book!.id, bookTitle: 'Kept Book', eventType: 'imported' }).returning();
      const [job] = await db.insert(importJobs).values({ bookId: book!.id, type: 'auto', status: 'completed', metadata: '{}' }).returning();
      const [header] = await db.insert(importSubmissions).values({
        clientSubmissionId: 'cross-table', payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: 1, receivedCount: 1, status: 'complete', acceptedCount: 1, completedAt: new Date(),
      }).returning();
      await db.insert(importSubmissionItems).values({ submissionId: header!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'Kept Book', disposition: 'accepted', bookId: book!.id });

      await service.deleteSubmission(header!.id);

      expect(await db.select().from(books).where(eq(books.id, book!.id))).toHaveLength(1);
      const events = await db.select().from(bookEvents).where(eq(bookEvents.id, event!.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBe(book!.id);
      const jobs = await db.select().from(importJobs).where(eq(importJobs.id, job!.id));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.bookId).toBe(book!.id);
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, header!.id))).toHaveLength(0);
    });
  });

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
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }] });
      const deleted = await service.sweepStaleReceiving();
      expect(deleted).toBe(0);
      expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1))).toHaveLength(1);
    });

    // Fake only Date: libSQL needs real timers, and a frozen boundary distinguishes < from <=.
    it('48h sweep boundary distinguishes strict lt from lte with a frozen clock (F24)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const ms48 = 48 * 60 * 60 * 1000;
        const older = await seedReceiving('sw-older', new Date(now.getTime() - ms48 - 1000));
        const exact = await seedReceiving('sw-exact', new Date(now.getTime() - ms48));
        const newer = await seedReceiving('sw-newer', new Date(now.getTime() - ms48 + 1000));

        const deleted = await service.sweepStaleReceiving();
        expect(deleted).toBe(1);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, older))).toHaveLength(0);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, exact))).toHaveLength(1);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, newer))).toHaveLength(1);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, older))).toHaveLength(0);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, exact))).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('completed-detail retention boundary distinguishes strict lt from lte with a frozen clock (F25)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const msDay = 24 * 60 * 60 * 1000;
        const exact = await seedComplete('rt-exact', new Date(now.getTime() - 90 * msDay));
        const beyond = await seedComplete('rt-beyond', new Date(now.getTime() - 90 * msDay - 1000));

        const pruned = await service.pruneCompletedDetails(90);
        expect(pruned).toBe(1);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, exact))).toHaveLength(1);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, beyond))).toHaveLength(0);
        for (const id of [exact, beyond]) {
          const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
          expect(h!.status).toBe('complete');
          expect(h!.acceptedCount).toBe(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    describe('pruneCleanCompleted (#2220)', () => {
      async function seedHeader(clientId: string, values: Partial<typeof importSubmissions.$inferInsert>): Promise<number> {
        const [row] = await db.insert(importSubmissions).values({
          clientSubmissionId: clientId, payloadDigest: 'a'.repeat(64), source: 'library',
          expectedCount: 1, receivedCount: 1, status: 'complete', acceptedCount: 1,
          ...values,
        }).returning();
        await db.insert(importSubmissionItems).values({ submissionId: row!.id, ordinal: 0, itemPayload: items[0]!, path: '/a', title: 'A', disposition: 'accepted' });
        return row!.id;
      }

      // Fake only Date: libSQL needs real timers, and a frozen boundary distinguishes < from <=.
      async function atBoundary(retentionDays: number): Promise<{ older: number; exact: number; newer: number; pruned: number }> {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
        const older = await seedHeader('cut-older', { completedAt: new Date(cutoff - 1000) });
        const exact = await seedHeader('cut-exact', { completedAt: new Date(cutoff) });
        const newer = await seedHeader('cut-newer', { completedAt: new Date(cutoff + 1000) });
        const pruned = await service.pruneCleanCompleted(retentionDays);
        return { older, exact, newer, pruned };
      }

      it('deletes strictly beyond the cutoff only (lt, not lte)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const { older, exact, newer, pruned } = await atBoundary(90);
          expect(pruned).toBe(1);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, older))).toHaveLength(0);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, exact))).toHaveLength(1);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, newer))).toHaveLength(1);
          expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, older))).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('holds the same 24h boundary at the settings minimum of 1 day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const { older, exact, newer, pruned } = await atBoundary(1);
          expect(pruned).toBe(1);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, older))).toHaveLength(0);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, exact))).toHaveLength(1);
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, newer))).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('retains an ancient run with held, skipped, or failed activity', async () => {
        const held = await seedHeader('anc-held', { completedAt: daysAgo(400), heldCount: 1 });
        const skipped = await seedHeader('anc-skipped', { completedAt: daysAgo(400), skippedCount: 1 });
        const failed = await seedHeader('anc-failed', { completedAt: daysAgo(400), failedCount: 1 });

        expect(await service.pruneCleanCompleted(90)).toBe(0);
        for (const id of [held, skipped, failed]) {
          expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, id))).toHaveLength(1);
          expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(1);
        }
      });

      it('never touches receiving or processing headers regardless of age', async () => {
        const receiving = await seedHeader('anc-receiving', { status: 'receiving', updatedAt: daysAgo(400) });
        const processing = await seedHeader('anc-processing', { status: 'processing', updatedAt: daysAgo(400) });

        expect(await service.pruneCleanCompleted(90)).toBe(0);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, receiving))).toHaveLength(1);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, processing))).toHaveLength(1);
      });

      it('ignores a complete row with a null completedAt', async () => {
        const orphan = await seedHeader('null-completed', { completedAt: null });
        expect(await service.pruneCleanCompleted(90)).toBe(0);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, orphan))).toHaveLength(1);
      });

      it('logs the pruned count at info', async () => {
        const info = vi.fn();
        const logged = new ImportStagingService(db, { ...noopLog, info } as unknown as FastifyBaseLogger, nudge as unknown as () => void);
        await seedHeader('prune-logged', { completedAt: daysAgo(120) });
        await logged.pruneCleanCompleted(90);
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ count: 1, retentionDays: 90 }), expect.stringContaining('pruned'));
      });
    });

    // Each raced result is classified explicitly; no vacuous branches.
    it('cleanup racing a concurrent PUT: fulfilled PUT retains header+item+counters; cleanup winner leaves neither (F37)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const id = await seedReceiving('race-put', new Date(now.getTime() - 49 * 60 * 60 * 1000));
        await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id));

        const db2 = createDb(dbFile);
        const service2 = new ImportStagingService(db2, noopLog, vi.fn() as unknown as () => void);
        const results = await Promise.allSettled([
          service.putItems(id, { items: [{ ordinal: 0, item: items[0]! }] }),
          service2.sweepStaleReceiving(),
        ]);
        db2.$client.close();

        const putResult = results[0]!;
        const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
        const itemRows = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id));

        if (putResult.status === 'fulfilled') {
          // PUT won: its header refresh, item, and counters commit atomically.
          expect(hdr).toBeDefined();
          expect(hdr!.status).toBe('receiving');
          expect(hdr!.receivedCount).toBe(1);
          expect(hdr!.receivedBytes).toBeGreaterThan(0);
          expect(hdr!.updatedAt.getTime()).toBe(now.getTime());
          expect(itemRows).toHaveLength(1);
        } else if (!hdr) {
          // Cleanup won: the cascade leaves no orphan item.
          expect(itemRows).toHaveLength(0);
        } else {
          // SQLITE_BUSY must leave no partial item or counter update.
          expect(hdr!.status).toBe('receiving');
          expect(itemRows).toHaveLength(0);
          expect(hdr!.receivedCount).toBe(0);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('finalize on an already-deleted header returns a typed 404 (cleanup-winner outcome, F38)', async () => {
      await service.createSubmission(createBody);
      await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
      await db.delete(importSubmissions).where(eq(importSubmissions.id, 1));
      await expect(service.finalize(1)).rejects.toMatchObject({ httpStatus: 404 });
      expect(nudge).not.toHaveBeenCalled();
    });

    it('cleanup racing a concurrent finalize: fulfilled finalize → processing+one nudge; cleanup winner → typed 404, no record, zero nudges (F38)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        await service.createSubmission(createBody);
        await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
        await db.update(importSubmissions).set({ updatedAt: new Date(now.getTime() - 49 * 60 * 60 * 1000) }).where(eq(importSubmissions.id, 1));

        const db2 = createDb(dbFile);
        const service2 = new ImportStagingService(db2, noopLog, vi.fn() as unknown as () => void);
        const results = await Promise.allSettled([service.finalize(1), service2.sweepStaleReceiving()]);
        db2.$client.close();

        const finalizeResult = results[0]!;
        const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));

        if (finalizeResult.status === 'fulfilled') {
          expect((finalizeResult.value as { status: string }).status).toBe('processing');
          expect(hdr!.status).toBe('processing');
          expect(nudge).toHaveBeenCalledTimes(1);
        } else if (!hdr) {
          expect((finalizeResult.reason as { httpStatus?: number }).httpStatus).toBe(404);
          expect(nudge).not.toHaveBeenCalled();
          expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, 1))).toHaveLength(0);
        } else {
          // SQLITE_BUSY leaves the transition and nudge unapplied; finalize remains retryable.
          expect(hdr!.status).toBe('receiving');
          expect(nudge).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
