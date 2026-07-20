import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { importSubmissions, importSubmissionItems, books } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { ImportStagingService } from './import-staging.service.js';
import { serializeSubmissionForDigest, submissionResponseSchema, MAX_SUBMISSION_BYTES, EXPECTED_COUNT_MAX, type StagedImportItem } from '../../core/import-staging/schemas.js';
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

    // F15: the read-then-insert is not atomic; a concurrent identical create must still
    // create-or-return (via the unique-index catch-and-reread), never leak a raw 5xx.
    it('a create whose existence check missed still returns the existing header via the unique-violation reread (F15)', async () => {
      await service.createSubmission(createBody); // row 1 exists
      // Force the pre-insert existence check to MISS (simulates the concurrent-create
      // race window) so the insert path runs and hits the client-id unique index.
      const spy = vi.spyOn(service as unknown as { findHeaderByClientId: (id: string) => Promise<unknown> }, 'findHeaderByClientId');
      spy.mockResolvedValueOnce(undefined);
      const res = await service.createSubmission(createBody);
      expect(res.id).toBe(1); // reread returned the existing header, not a raw error
      expect(await db.select().from(importSubmissions)).toHaveLength(1); // no second row
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
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // neither leaks a raw 5xx
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

  // ── F16: query-shape deletion heuristic — summary must not select itemPayload ──
  it('summary poll issues no full-row item SELECT; the detail arm does (F16 deletion heuristic)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
    await service.finalize(1); // status 'processing' so computeProgress takes the live-count path

    // A full-row item SELECT is `db.select()` with NO projection arg (all columns,
    // incl. itemPayload). getById itself issues exactly ONE no-arg select (the header).
    // If the summary path also did a full-row item select it would show 2 no-arg
    // selects — matching the detail arm — and this heuristic would fail.
    const selectSpy = vi.spyOn(db, 'select');

    await service.getById(1, false); // summary
    const summaryNoArgSelects = selectSpy.mock.calls.filter((c) => c[0] === undefined).length;
    // The live-count path must use a projected `{ disposition }` select (never itemPayload).
    expect(selectSpy.mock.calls.some((c) => c[0] !== undefined && 'disposition' in (c[0] as object))).toBe(true);

    selectSpy.mockClear();
    await service.getById(1, true); // detail
    const detailNoArgSelects = selectSpy.mock.calls.filter((c) => c[0] === undefined).length;

    // Detail loads full item rows (extra no-arg select); summary does not.
    expect(summaryNoArgSelects).toBe(1); // header only
    expect(detailNoArgSelects).toBeGreaterThan(summaryNoArgSelects);
    selectSpy.mockRestore();
  });

  // ── F21: cumulative byte-cap inclusive boundary (just-below / at / just-above) ──
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
      expect(h!.receivedBytes).toBe(MAX_SUBMISSION_BYTES); // landed exactly at the cap and was accepted
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(1);
    });

    it('rejects a PUT one byte over the cap with 413 and no state change', async () => {
      const b = itemBytes(items[0]!);
      const id = await seedReceivingAtBytes('cap-over', MAX_SUBMISSION_BYTES - b + 1);
      await expect(service.putItems(id, { items: [{ ordinal: 0, item: items[0]! }] }))
        .rejects.toMatchObject({ httpStatus: 413, code: 'submission-byte-budget-exceeded' });
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
      expect(h!.receivedBytes).toBe(MAX_SUBMISSION_BYTES - b + 1); // unchanged
      expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id))).toHaveLength(0);
    });
  });

  // ── F22/F33: bounded finalize gaps report on a MAX-sized sparse submission ──
  it('finalize on a max-count sparse submission returns a bounded gaps report (≤100 ordered, totalMissing, truncated) (F22/F33)', async () => {
    const expectedCount = EXPECTED_COUNT_MAX; // the explicitly-required maximum (10,000)
    const [row] = await db.insert(importSubmissions).values({
      clientSubmissionId: 'sparse-gaps', payloadDigest: 'a'.repeat(64), source: 'library',
      expectedCount, status: 'receiving',
    }).returning();
    // Only ordinal 0 present → ordinals 1..(MAX-1) are missing.
    await service.putItems(row!.id, { items: [{ ordinal: 0, item: items[0]! }] });

    try {
      await service.finalize(row!.id);
      throw new Error('expected finalize to reject with a gaps report');
    } catch (err) {
      const gaps = (err as { code: string; gaps?: { missing: number[]; totalMissing: number; truncated: boolean } });
      expect(gaps.code).toBe('finalize-gaps');
      expect(gaps.gaps!.missing).toHaveLength(100); // bounded to ≤100 even at the maximum count
      expect(gaps.gaps!.missing[0]).toBe(1); // ordered from the first gap
      expect(gaps.gaps!.missing).toEqual([...gaps.gaps!.missing].sort((a, b) => a - b)); // ascending
      expect(gaps.gaps!.totalMissing).toBe(expectedCount - 1); // the FULL count, not the truncated length
      expect(gaps.gaps!.truncated).toBe(true);
    }
    // No state change — the header stays receiving.
    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, row!.id));
    expect(h!.status).toBe('receiving');
  });

  // ── F31: terminal detail DTO projection driven through the service ────────
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
    expect(byOrd[0]!.item).toBeTruthy(); // accepted itemPayload parsed + projected
    expect(byOrd[1]).toMatchObject({ disposition: 'held', reason: 'recording-review-required', existingBookId: incumbent!.id });
    expect(byOrd[2]).toMatchObject({ disposition: 'skipped', reason: 'already-in-library', existingBookId: incumbent!.id, existingTitle: 'Incumbent' });
    expect(byOrd[3]).toMatchObject({ disposition: 'failed', message: 'Import failed — see server logs for details.' });
    // The full detail response validates against the strict DTO union (no cross-disposition leakage).
    expect(submissionResponseSchema.safeParse(res).success).toBe(true);

    // F50: deleting the accepted placeholder book set-nulls bookId while the disposition stays 'accepted'.
    await db.delete(books).where(eq(books.id, placeholder!.id));
    const res2 = await service.getById(subId, true);
    if (!res2.itemsIncluded) throw new Error('expected detail arm');
    const acc = res2.items.find((i) => i.ordinal === 0)!;
    expect(acc).toMatchObject({ disposition: 'accepted', bookId: null });
    expect(submissionResponseSchema.safeParse(res2).success).toBe(true);
  });

  // ── F23/F36: simultaneous finalize callers on the SAME service (single-process) ──
  it('two simultaneous finalize callers on one service BOTH fulfill with the processing header and exactly one nudge (F36)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

    // Both calls hit the SAME composed service (the supported single-process path). The
    // in-process write lane serializes them so neither rejects; both ORIGINAL promises
    // must fulfill with 'processing', and only the winning CAS nudges.
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

  // Cross-connection invariant (a separate durable-CAS backstop): a second process
  // contends via a distinct connection; SQLite file locking still yields exactly one
  // winning transition/nudge, with a retryable lock-loss on the loser.
  it('finalize contention across SEPARATE connections still transitions once (F23 backstop)', async () => {
    await service.createSubmission(createBody);
    await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });

    const db2 = createDb(dbFile);
    const service2 = new ImportStagingService(db2, noopLog, nudge as unknown as () => void);
    const results = await Promise.allSettled([service.finalize(1), service2.finalize(1)]);
    db2.$client.close();
    for (const r of results) {
      if (r.status === 'rejected') await service.finalize(1); // lock-loss is retryable + idempotent
    }

    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));
    expect(h!.status).toBe('processing');
    expect(nudge).toHaveBeenCalledTimes(1);
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

    // ── F24/F25: exact strict-lt boundaries with a FROZEN clock ──────────────
    // Freeze ONLY Date (real timers stay live so libSQL async is unaffected) so an
    // exactly-at-boundary fixture cannot drift between the helper's and the service's
    // independent Date.now() reads — that is what lets us distinguish `lt` from `lte`.
    it('48h sweep boundary distinguishes strict lt from lte with a frozen clock (F24)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const ms48 = 48 * 60 * 60 * 1000;
        const older = await seedReceiving('sw-older', new Date(now.getTime() - ms48 - 1000)); // strictly older → swept
        const exact = await seedReceiving('sw-exact', new Date(now.getTime() - ms48));         // exactly 48h → kept (lt)
        const newer = await seedReceiving('sw-newer', new Date(now.getTime() - ms48 + 1000));  // just under → kept

        const deleted = await service.sweepStaleReceiving();
        expect(deleted).toBe(1);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, older))).toHaveLength(0);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, exact))).toHaveLength(1);
        expect(await db.select().from(importSubmissions).where(eq(importSubmissions.id, newer))).toHaveLength(1);
        // Cascade only for the strictly-older row.
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
        const exact = await seedComplete('rt-exact', new Date(now.getTime() - 90 * msDay));        // exactly 90d → kept (lt)
        const beyond = await seedComplete('rt-beyond', new Date(now.getTime() - 90 * msDay - 1000)); // just beyond → pruned

        const pruned = await service.pruneCompletedDetails(90);
        expect(pruned).toBe(1);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, exact))).toHaveLength(1);
        expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, beyond))).toHaveLength(0);
        // Both permanent headers + aggregates survive.
        for (const id of [exact, beyond]) {
          const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, id));
          expect(h!.status).toBe('complete');
          expect(h!.acceptedCount).toBe(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    // ── F37/F38: concurrent cleanup vs PUT / finalize (separate connections) ──
    // Each raced result is classified explicitly — no vacuous branches.
    it('cleanup racing a concurrent PUT: fulfilled PUT retains header+item+counters; cleanup winner leaves neither (F37)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        const id = await seedReceiving('race-put', new Date(now.getTime() - 49 * 60 * 60 * 1000)); // stale
        await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id)); // clear pre-seeded item

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
          // PUT won: header survives, refreshed (updatedAt=now so sweep couldn't delete),
          // and carries exactly its item + counters — a complete, non-partial write.
          expect(hdr).toBeDefined();
          expect(hdr!.status).toBe('receiving');
          expect(hdr!.receivedCount).toBe(1);
          expect(hdr!.receivedBytes).toBeGreaterThan(0);
          expect(hdr!.updatedAt.getTime()).toBe(now.getTime());
          expect(itemRows).toHaveLength(1);
        } else if (!hdr) {
          // Cleanup won: header gone AND items cascade-deleted — PUT rejected, no orphan.
          expect(itemRows).toHaveLength(0);
        } else {
          // Lock-loss (SQLITE_BUSY): the whole PUT tx rolled back — NO partial item and
          // NO counter change under the surviving stale header.
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
      // Simulate a cleanup that deleted the header before finalize runs.
      await db.delete(importSubmissions).where(eq(importSubmissions.id, 1));
      await expect(service.finalize(1)).rejects.toMatchObject({ httpStatus: 404 });
      expect(nudge).not.toHaveBeenCalled();
    });

    it('cleanup racing a concurrent finalize: fulfilled finalize → processing+one nudge; cleanup winner → typed 404, no record, zero nudges (F38)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-07-20T12:00:00.000Z');
        vi.setSystemTime(now);
        await service.createSubmission(createBody); // id 1, receiving, digest matches the 2 items
        await service.putItems(1, { items: [{ ordinal: 0, item: items[0]! }, { ordinal: 1, item: items[1]! }] });
        // Age the header so it is sweep-eligible while still receiving with all ordinals.
        await db.update(importSubmissions).set({ updatedAt: new Date(now.getTime() - 49 * 60 * 60 * 1000) }).where(eq(importSubmissions.id, 1));

        const db2 = createDb(dbFile);
        const service2 = new ImportStagingService(db2, noopLog, vi.fn() as unknown as () => void);
        const results = await Promise.allSettled([service.finalize(1), service2.sweepStaleReceiving()]);
        db2.$client.close();

        const finalizeResult = results[0]!;
        const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, 1));

        if (finalizeResult.status === 'fulfilled') {
          // Finalize won: the permanent record flipped to processing with exactly one nudge.
          expect((finalizeResult.value as { status: string }).status).toBe('processing');
          expect(hdr!.status).toBe('processing');
          expect(nudge).toHaveBeenCalledTimes(1);
        } else if (!hdr) {
          // Cleanup won: the finalize rejection is the TYPED 404 (not a raw failure/stale
          // success), no record/items survive, and nothing was nudged.
          expect((finalizeResult.reason as { httpStatus?: number }).httpStatus).toBe(404);
          expect(nudge).not.toHaveBeenCalled();
          expect(await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, 1))).toHaveLength(0);
        } else {
          // Lock-loss (SQLITE_BUSY): no transition, no nudge; the header is still receiving
          // and finalize is retryable/idempotent.
          expect(hdr!.status).toBe('receiving');
          expect(nudge).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
