import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { importSubmissions, importSubmissionItems, books } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { ImportSubmissionReportService, reportItemProjection } from './import-submission-report.service.js';
import { ABANDONED_UPLOAD_GRACE_MS } from './import-staging.service.js';
import { REPORT_ITEM_COLUMNS } from './import-submission-dto.js';
import type { ItemDisposition, StagedImportItem, SubmissionSource, SubmissionStatus } from '../../core/import-staging/schemas.js';

let seq = 0;

interface SeedHeader {
  source?: SubmissionSource;
  mode?: 'copy' | 'move';
  status: SubmissionStatus;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  expectedCount?: number;
  receivedCount?: number;
  counts?: { accepted?: number; held?: number; skipped?: number; failed?: number };
}

describe('ImportSubmissionReportService (DB-backed, #1894)', () => {
  let dir: string;
  let db: Db;
  let service: ImportSubmissionReportService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'report-svc-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new ImportSubmissionReportService(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function seed(h: SeedHeader): Promise<number> {
    const c = h.counts ?? {};
    const [row] = await db.insert(importSubmissions).values({
      clientSubmissionId: `c-${seq++}-${Math.round(performance.now())}`,
      payloadDigest: 'a'.repeat(64),
      source: h.source ?? 'library',
      mode: h.mode ?? null,
      status: h.status,
      expectedCount: h.expectedCount ?? 1,
      receivedCount: h.receivedCount ?? 0,
      acceptedCount: c.accepted ?? 0,
      heldCount: c.held ?? 0,
      skippedCount: c.skipped ?? 0,
      failedCount: c.failed ?? 0,
      ...(h.createdAt ? { createdAt: h.createdAt } : {}),
      ...(h.updatedAt ? { updatedAt: h.updatedAt } : {}),
      ...(h.completedAt ? { completedAt: h.completedAt } : {}),
    }).returning();
    return row!.id;
  }

  async function seedBook(title: string): Promise<number> {
    const [row] = await db.insert(books).values({ publicId: generatePublicId('bk'), title, status: 'imported' }).returning();
    return row!.id;
  }

  async function seedItem(
    submissionId: number,
    ordinal: number,
    disposition: ItemDisposition,
    opts: { reason?: string; existingBookId?: number; existingTitle?: string; bookId?: number; itemPayload?: StagedImportItem } = {},
  ): Promise<void> {
    await db.insert(importSubmissionItems).values({
      submissionId, ordinal, disposition,
      path: `/p${ordinal}`, title: `T${ordinal}`,
      reason: opts.reason ?? null,
      existingBookId: opts.existingBookId ?? null,
      existingTitle: opts.existingTitle ?? null,
      bookId: opts.bookId ?? null,
      itemPayload: opts.itemPayload ?? null,
    });
  }

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('orders newest-first (createdAt DESC, id DESC) with a same-createdAt tie-break', async () => {
      const t = new Date('2026-07-01T00:00:00.000Z');
      const older = await seed({ status: 'complete', createdAt: new Date('2026-06-01T00:00:00.000Z'), completedAt: t });
      const a = await seed({ status: 'complete', createdAt: t, completedAt: t });
      const b = await seed({ status: 'complete', createdAt: t, completedAt: t }); // same createdAt, higher id
      const { data, total } = await service.list({ limit: 20, offset: 0 });
      expect(total).toBe(3);
      expect(data.map((d) => d.id)).toEqual([b, a, older]);
    });

    it('partitions by source and pages with total reflecting the full retained count', async () => {
      for (let i = 0; i < 3; i++) await seed({ source: 'library', status: 'complete' });
      for (let i = 0; i < 2; i++) await seed({ source: 'manual', status: 'complete' });
      const lib = await service.list({ source: 'library', limit: 20, offset: 0 });
      expect(lib.total).toBe(3);
      expect(lib.data.every((d) => d.source === 'library')).toBe(true);
      const page = await service.list({ limit: 2, offset: 0 });
      expect(page.total).toBe(5);
      expect(page.data).toHaveLength(2);
      const page2 = await service.list({ limit: 2, offset: 4 });
      expect(page2.data).toHaveLength(1);
    });

    it('rows are summary DTOs — no items, complete uses frozen aggregates, non-complete uses live counts', async () => {
      const complete = await seed({ status: 'complete', expectedCount: 4, counts: { accepted: 2, held: 1, skipped: 1, failed: 0 } });
      await seedItem(complete, 0, 'accepted');
      const processing = await seed({ status: 'processing', expectedCount: 3 });
      await seedItem(processing, 0, 'accepted');
      await seedItem(processing, 1, 'pending');
      const { data } = await service.list({ limit: 20, offset: 0 });
      const c = data.find((d) => d.id === complete)!;
      const p = data.find((d) => d.id === processing)!;
      expect('items' in c).toBe(false);
      expect(c.aggregates).toEqual({ accepted: 2, held: 1, skipped: 1, failed: 0 });
      expect(c.processedCount).toBe(4);
      expect(p.aggregates).toEqual({ accepted: 1, held: 0, skipped: 0, failed: 0 });
      expect(p.processedCount).toBe(1);
      expect(p.detailsPruned).toBe(false);
    });

    it('marks a pruned complete row detailsPruned, a retained one not (batch existence)', async () => {
      const pruned = await seed({ status: 'complete', expectedCount: 2, counts: { accepted: 2 } }); // no item rows
      const retained = await seed({ status: 'complete', expectedCount: 1, counts: { accepted: 1 } });
      await seedItem(retained, 0, 'accepted');
      const { data } = await service.list({ limit: 20, offset: 0 });
      expect(data.find((d) => d.id === pruned)!.detailsPruned).toBe(true);
      expect(data.find((d) => d.id === retained)!.detailsPruned).toBe(false);
    });

    it('uses a CONSTANT two-query item budget regardless of row count (N+1 guard, F9/F52/F84)', async () => {
      // Several complete AND several non-complete rows — a per-header loader would
      // scale the item-query count with the page size; the set-based loader must not.
      for (let i = 0; i < 4; i++) {
        const c = await seed({ status: 'complete', expectedCount: 2, counts: { accepted: 1, held: 1 } });
        await seedItem(c, 0, 'accepted');
        await seedItem(c, 1, 'held', { reason: 'recording-review-required' });
        const p = await seed({ status: 'processing', expectedCount: 2 });
        await seedItem(p, 0, 'accepted');
        await seedItem(p, 1, 'pending');
      }
      const spy = spyItemQueries(db);
      const { data } = await service.list({ limit: 20, offset: 0 });
      // Exactly two item-table statements: the grouped disposition count (non-complete)
      // + the DISTINCT existence probe (complete). Not one-per-header.
      expect(spy.count).toBe(2);
      expect(spy.statements.some((s) => /group by/i.test(s))).toBe(true); // grouped counts
      expect(spy.statements.some((s) => /distinct/i.test(s))).toBe(true); // existence probe
      // …and the assembled counts are still correct.
      const complete = data.find((d) => d.status === 'complete')!;
      expect(complete.aggregates).toEqual({ accepted: 1, held: 1, skipped: 0, failed: 0 });
      const processing = data.find((d) => d.status === 'processing')!;
      expect(processing.aggregates).toEqual({ accepted: 1, held: 0, skipped: 0, failed: 0 });
      spy.restore();
    });

    it('is set-based even with only complete rows — one DISTINCT existence probe, no per-header queries', async () => {
      for (let i = 0; i < 5; i++) {
        const c = await seed({ status: 'complete', expectedCount: 1, counts: { accepted: 1 } });
        await seedItem(c, 0, 'accepted');
      }
      const spy = spyItemQueries(db);
      await service.list({ limit: 20, offset: 0 });
      expect(spy.count).toBe(1); // only the batch existence probe (no non-complete rows)
      expect(spy.statements[0]).toMatch(/distinct/i);
      spy.restore();
    });
  });

  // ── attention ───────────────────────────────────────────────────────────────

  describe('attention', () => {
    it('returns the older attention run even when a healthy newest run exists (F48)', async () => {
      const attn = await seed({ status: 'complete', createdAt: new Date('2026-06-01T00:00:00.000Z'), completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { held: 2, failed: 1 } });
      await seed({ status: 'complete', createdAt: new Date('2026-06-20T00:00:00.000Z'), completedAt: new Date('2026-06-20T00:00:00.000Z'), counts: { accepted: 5 } }); // healthy, newer
      const { data, watch } = await service.attention({});
      expect(data?.id).toBe(attn);
      expect(data?.attention).toEqual({ kind: 'completed-attention', held: 2, failed: 1 });
      expect(watch).toBe(false); // all complete
    });

    it('watch is true for a processing row (no attention data yet)', async () => {
      expect(await service.attention({})).toEqual({ data: null, watch: false }); // empty scope
      await seed({ status: 'processing' });
      expect(await service.attention({})).toEqual({ data: null, watch: true });
    });

    it('a FRESH receiving row (within grace) → data:null but watch:true (F12)', async () => {
      const now = new Date('2026-07-21T00:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      // updatedAt 5 min ago (< 15 min grace) — actively arriving, not abandoned.
      await seed({ status: 'receiving', expectedCount: 3, receivedCount: 1, updatedAt: new Date(now.getTime() - 5 * 60 * 1000) });
      expect(await service.attention({})).toEqual({ data: null, watch: true });
    });

    it('a PAST-GRACE receiving row → abandoned with watch:true, including the fully-received case (F12/F67)', async () => {
      const now = new Date('2026-07-21T00:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      // Fully received (receivedCount === expectedCount) but never finalized, past grace.
      const id = await seed({ status: 'receiving', expectedCount: 3, receivedCount: 3, updatedAt: new Date(now.getTime() - ABANDONED_UPLOAD_GRACE_MS - 60_000) });
      const res = await service.attention({});
      expect(res.data?.id).toBe(id);
      expect(res.data?.attention).toEqual({ kind: 'abandoned' });
      expect(res.data?.receivedCount).toBe(3);
      expect(res.data?.expectedCount).toBe(3);
      expect(res.watch).toBe(true); // still receiving → keep polling for a later finalize
    });

    it('a healthy processing run does not mask an older attention run (data=attention, watch=true)', async () => {
      const attn = await seed({ status: 'complete', createdAt: new Date('2026-06-01T00:00:00.000Z'), completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { held: 1 } });
      await seed({ status: 'processing', createdAt: new Date('2026-06-20T00:00:00.000Z') });
      const { data, watch } = await service.attention({});
      expect(data?.id).toBe(attn);
      expect(watch).toBe(true);
    });

    it('grace boundary is strict < — exactly-at is null+watch, one tick older is abandoned (F61)', async () => {
      const now = new Date('2026-07-21T00:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const exactly = await seed({ status: 'receiving', expectedCount: 2, receivedCount: 1, updatedAt: new Date(now.getTime() - ABANDONED_UPLOAD_GRACE_MS) });
      let res = await service.attention({});
      expect(res).toEqual({ data: null, watch: true });

      await db.update(importSubmissions)
        .set({ updatedAt: new Date(now.getTime() - ABANDONED_UPLOAD_GRACE_MS - 1000) })
        .where(eq(importSubmissions.id, exactly));
      res = await service.attention({});
      expect(res.data?.attention).toEqual({ kind: 'abandoned' });
      expect(res.data?.receivedCount).toBe(1);
      expect(res.data?.expectedCount).toBe(2);
      expect(res.watch).toBe(true);
    });

    it('completed-attention survives pruning — frozen aggregates from the CTE (F75)', async () => {
      const id = await seed({ status: 'complete', expectedCount: 3, completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { accepted: 1, held: 1, failed: 1 } });
      await seedItem(id, 0, 'held', { reason: 'recording-review-required' });
      await db.delete(importSubmissionItems).where(eq(importSubmissionItems.submissionId, id)); // prune
      const { data } = await service.attention({});
      expect(data?.itemsIncluded).toBe(false);
      expect(data?.detailsPruned).toBe(true);
      expect(data?.aggregates).toEqual({ accepted: 1, held: 1, skipped: 0, failed: 1 });
      expect(data?.attention).toEqual({ kind: 'completed-attention', held: 1, failed: 1 });
    });

    it('attention tie-break selects the higher id on identical createdAt (F76)', async () => {
      const t = new Date('2026-06-01T00:00:00.000Z');
      const lo = await seed({ status: 'complete', createdAt: t, completedAt: t, counts: { held: 1 } });
      const hi = await seed({ status: 'complete', createdAt: t, completedAt: t, counts: { held: 1 } });
      expect(hi).toBeGreaterThan(lo);
      const { data } = await service.attention({});
      expect(data?.id).toBe(hi);
    });

    it('scopes by source', async () => {
      await seed({ source: 'library', status: 'complete', completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { held: 1 } });
      const manual = await seed({ source: 'manual', status: 'complete', completedAt: new Date('2026-06-02T00:00:00.000Z'), counts: { failed: 1 } });
      const m = await service.attention({ source: 'manual' });
      expect(m.data?.id).toBe(manual);
      expect(m.data?.attention).toEqual({ kind: 'completed-attention', held: 0, failed: 1 });
    });

    // ── one-atomic-snapshot coherence (F11/F68/F71) — CTE-appropriate proofs ──
    it('a processing→completed-attention commit is seen entirely before OR after the read (never a split state)', async () => {
      const id = await seed({ status: 'processing', expectedCount: 2, createdAt: new Date('2026-06-01T00:00:00.000Z') });
      // Read while still processing: no attention data, but watch true.
      expect(await service.attention({})).toEqual({ data: null, watch: true });
      // Commit the terminal transition wholly, then read: sees completed-attention, watch false.
      await db.update(importSubmissions)
        .set({ status: 'complete', heldCount: 1, completedAt: new Date('2026-06-01T00:00:00.000Z') })
        .where(eq(importSubmissions.id, id));
      const after = await service.attention({});
      expect(after.data?.id).toBe(id);
      expect(after.data?.attention).toEqual({ kind: 'completed-attention', held: 1, failed: 0 });
      expect(after.watch).toBe(false);
    });

    it('{data:null, watch:false} is UNREACHABLE while a durable attention row exists', async () => {
      await seed({ status: 'complete', completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { failed: 1 } });
      const res = await service.attention({});
      expect(res.data).not.toBeNull();
      expect(res).not.toEqual({ data: null, watch: false });
    });

    it('{data:null, watch:false} is UNREACHABLE while a non-terminal row exists', async () => {
      await seed({ status: 'processing' });
      const res = await service.attention({});
      expect(res.watch).toBe(true);
      expect(res).not.toEqual({ data: null, watch: false });
    });

    it('{data:null, watch:false} is reachable ONLY when neither attention nor non-terminal work exists', async () => {
      await seed({ status: 'complete', completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { accepted: 3 } }); // healthy
      expect(await service.attention({})).toEqual({ data: null, watch: false });
    });

    it('computes data + watch in exactly ONE executed statement carrying both arms (F32)', async () => {
      await seed({ status: 'complete', completedAt: new Date('2026-06-01T00:00:00.000Z'), counts: { held: 1 } });
      await seed({ status: 'processing' });
      const spy = spyStatements(db);
      await service.attention({});
      spy.restore();
      // A single statement referencing import_submissions — splitting `data` and
      // `watch` into two reads would make this 2. And that one statement must carry
      // BOTH the abandoned/completed predicate AND the non-terminal watch EXISTS.
      const submissionStmts = spy.statements.filter((s) => /import_submissions/i.test(s));
      expect(submissionStmts).toHaveLength(1);
      const cte = submissionStmts[0]!.toLowerCase();
      expect(cte).toMatch(/held_count|completed|abandon|receiving/); // attention predicate
      expect(cte).toMatch(/exists/); // the watch EXISTS(...) sub-select
    });

    it('crosses the grace with ONE captured cutoff — a past-grace receiving is abandoned while a boundary receiving keeps watch (F32/F61)', async () => {
      const now = new Date('2026-07-21T00:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      // Boundary row (exactly at grace → NOT abandoned) and a one-tick-past row
      // (abandoned) share one snapshot with one captured cutoff.
      await seed({ status: 'receiving', expectedCount: 2, receivedCount: 1, createdAt: new Date('2026-07-20T10:00:00.000Z'), updatedAt: new Date(now.getTime() - ABANDONED_UPLOAD_GRACE_MS) });
      const past = await seed({ status: 'receiving', expectedCount: 2, receivedCount: 1, createdAt: new Date('2026-07-20T11:00:00.000Z'), updatedAt: new Date(now.getTime() - ABANDONED_UPLOAD_GRACE_MS - 1000) });
      const res = await service.attention({});
      expect(res.data?.id).toBe(past); // only the strictly-past-grace row is abandoned
      expect(res.data?.attention).toEqual({ kind: 'abandoned' });
      expect(res.watch).toBe(true); // both receiving rows keep watch true (same snapshot)
    });

    it('attention header is byte-identical to the list summary header for the same submission (single canonical mapper, F39)', async () => {
      const id = await seed({
        source: 'manual', mode: 'copy', status: 'complete', expectedCount: 4,
        createdAt: new Date('2026-05-30T00:00:00.000Z'), completedAt: new Date('2026-06-01T00:00:00.000Z'),
        counts: { accepted: 1, held: 2, skipped: 0, failed: 1 },
      });
      await seedItem(id, 0, 'held', { reason: 'recording-review-required' }); // retained (not pruned)
      const listRow = (await service.list({ limit: 20, offset: 0 })).data.find((d) => d.id === id)!;
      const { attention: _attention, ...attnHeader } = (await service.attention({ source: 'manual' })).data!;
      expect(attnHeader).toEqual(listRow); // same canonical header — no drift between the two mappers
    });
  });

  // ── reportDetail (projection) ────────────────────────────────────────────────

  describe('reportDetail', () => {
    it('projection column set excludes itemPayload and has no message column (F62/F66)', () => {
      expect(Object.keys(reportItemProjection())).toEqual([...REPORT_ITEM_COLUMNS]);
      expect(Object.keys(reportItemProjection())).not.toContain('itemPayload');
      expect(Object.keys(reportItemProjection())).not.toContain('message');
    });

    it('the ACTUAL executed reportDetail SELECT never references item_payload (F10)', async () => {
      // A regression to `.select()` (all columns) would show item_payload in the SQL
      // even though the isolated projection helper stayed unchanged.
      const id = await seed({ status: 'complete', expectedCount: 3, completedAt: new Date(), counts: { accepted: 1, held: 1, failed: 1 } });
      await seedItem(id, 0, 'accepted');
      await seedItem(id, 1, 'held', { reason: 'recording-review-required' });
      await seedItem(id, 2, 'failed', { reason: 'boom' });
      const spy = spyItemQueries(db);
      const detail = await service.reportDetail(id);
      // The item-row SELECT (the one projecting path/title/disposition) must not read the payload.
      const selects = spy.statements.filter((s) => /\bfrom\b\s+"?import_submission_items"?/i.test(s) && /\bselect\b/i.test(s));
      expect(selects.length).toBeGreaterThan(0);
      for (const s of selects) expect(s).not.toMatch(/item_payload/i);
      expect(detail.itemsIncluded).toBe(true);
      spy.restore();
    });

    it('maps arms correctly — accepted without item, failed message from reason', async () => {
      const acceptedBook = await seedBook('Accepted Book');
      const heldBook = await seedBook('Held Book');
      const skippedBook = await seedBook('Skipped Book');
      const id = await seed({ status: 'complete', expectedCount: 4, completedAt: new Date(), counts: { accepted: 1, held: 1, skipped: 1, failed: 1 } });
      await seedItem(id, 0, 'accepted', { bookId: acceptedBook, itemPayload: { path: '/p0', title: 'T0', metadata: { title: 'T0', authors: [{ name: 'A' }] } } });
      await seedItem(id, 1, 'held', { reason: 'recording-review-required', existingBookId: heldBook });
      await seedItem(id, 2, 'skipped', { reason: 'already-in-library', existingBookId: skippedBook, existingTitle: 'Dune' });
      await seedItem(id, 3, 'failed', { reason: 'Disk full' });
      const detail = await service.reportDetail(id);
      expect(detail.itemsIncluded).toBe(true);
      if (!detail.itemsIncluded) throw new Error('expected items');
      const accepted = detail.items.find((i) => i.disposition === 'accepted')!;
      expect('item' in accepted).toBe(false);
      expect(accepted.disposition === 'accepted' && accepted.bookId).toBe(acceptedBook);
      const failed = detail.items.find((i) => i.disposition === 'failed')!;
      expect(failed.disposition === 'failed' && failed.message).toBe('Disk full');
      const skipped = detail.items.find((i) => i.disposition === 'skipped')!;
      expect(skipped.disposition === 'skipped' && skipped.existingTitle).toBe('Dune');
    });

    it('covers every remaining mapper branch — pending, already-importing, independent optional fields, failed reason=null (F26)', async () => {
      const idOnlyBook = await seedBook('Id Only Book');
      // A processing submission's detail still maps all its item rows.
      const id = await seed({ status: 'processing', expectedCount: 6 });
      await seedItem(id, 0, 'pending');
      await seedItem(id, 1, 'skipped', { reason: 'already-importing' }); // neither collision field
      await seedItem(id, 2, 'skipped', { reason: 'already-in-library', existingBookId: idOnlyBook }); // id-only
      await seedItem(id, 3, 'skipped', { reason: 'already-in-library', existingTitle: 'Ghost Title' }); // title-only (FK null)
      await seedItem(id, 4, 'skipped', { reason: 'already-in-library' }); // neither
      await seedItem(id, 5, 'failed'); // reason=null → fallback message
      const detail = await service.reportDetail(id);
      if (!detail.itemsIncluded) throw new Error('expected items');
      const at = (ord: number) => detail.items.find((i) => i.ordinal === ord)!;

      expect(at(0)).toEqual({ disposition: 'pending', ordinal: 0, path: '/p0', title: 'T0' });

      const importing = at(1);
      expect(importing.disposition).toBe('skipped');
      expect(importing.disposition === 'skipped' && importing.reason).toBe('already-importing');
      expect('existingBookId' in importing).toBe(false);
      expect('existingTitle' in importing).toBe(false);

      const idOnly = at(2);
      expect(idOnly.disposition === 'skipped' && idOnly.existingBookId).toBe(idOnlyBook);
      expect('existingTitle' in idOnly).toBe(false);

      const titleOnly = at(3);
      expect(titleOnly.disposition === 'skipped' && titleOnly.existingTitle).toBe('Ghost Title');
      expect('existingBookId' in titleOnly).toBe(false);

      const neither = at(4);
      expect(neither.disposition === 'skipped' && neither.reason).toBe('already-in-library');
      expect('existingBookId' in neither).toBe(false);
      expect('existingTitle' in neither).toBe(false);

      const failed = at(5);
      expect(failed.disposition === 'failed' && failed.message).toBe('Import failed — see server logs for details.');
    });

    it('a pruned record collapses to the summary arm', async () => {
      const id = await seed({ status: 'complete', expectedCount: 2, completedAt: new Date(), counts: { accepted: 2 } });
      const detail = await service.reportDetail(id);
      expect(detail.itemsIncluded).toBe(false);
      expect(detail.detailsPruned).toBe(true);
    });
  });
});

/** Spy on the libSQL client, capturing every executed SQL string touching the items table. */
function spyItemQueries(db: Db): { statements: string[]; get count(): number; restore: () => void } {
  const client = db.$client as unknown as { execute: (...a: unknown[]) => unknown };
  const original = client.execute.bind(client);
  const statements: string[] = [];
  client.execute = ((stmt: unknown, ...rest: unknown[]) => {
    const sql = typeof stmt === 'string' ? stmt : (stmt as { sql?: string })?.sql ?? '';
    if (/import_submission_items/.test(sql)) statements.push(sql);
    return original(stmt as never, ...(rest as never[]));
  }) as typeof client.execute;
  return {
    statements,
    get count() { return statements.length; },
    restore: () => { client.execute = original as typeof client.execute; },
  };
}

/** Spy capturing EVERY executed SQL string (used to prove a single-statement read). */
function spyStatements(db: Db): { statements: string[]; restore: () => void } {
  const client = db.$client as unknown as { execute: (...a: unknown[]) => unknown };
  const original = client.execute.bind(client);
  const statements: string[] = [];
  client.execute = ((stmt: unknown, ...rest: unknown[]) => {
    const sql = typeof stmt === 'string' ? stmt : (stmt as { sql?: string })?.sql ?? '';
    statements.push(sql);
    return original(stmt as never, ...(rest as never[]));
  }) as typeof client.execute;
  return { statements, restore: () => { client.execute = original as typeof client.execute; } };
}
