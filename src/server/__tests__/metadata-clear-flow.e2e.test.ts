import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { runEnrichment } from '../jobs/enrichment.js';
import type { MetadataService } from '../services/metadata.service.js';

describe('Provider-only metadata clear — server E2E (#2069)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    e2e = await createE2EApp();
  });

  afterEach(async () => {
    await e2e.cleanup();
  });

  async function seedEnrichedProviderOnlyBook(): Promise<number> {
    const [row] = await e2e.db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'),
        title: 'Tress of the Emerald Sea',
        status: 'imported',
        // Scheduled enrichment does not revisit already-enriched rows.
        enrichmentStatus: 'enriched',
        seriesName: null,
        seriesPosition: null,
        asin: 'B0BTRESS01',
      })
      .returning();
    return row!.id;
  }

  async function readRow(bookId: number) {
    const [row] = await e2e.db.select().from(books).where(eq(books.id, bookId));
    return row!;
  }

  async function runEnrichmentPass(): Promise<void> {
    const metadataService = {
      resolveBook: vi.fn().mockResolvedValue({
        title: 'Tress of the Emerald Sea',
        authors: [{ name: 'Brandon Sanderson' }],
        seriesPrimary: { name: 'Secret Projects', position: 1 },
        publisher: 'Dragonsteel',
      }),
    } as unknown as MetadataService;
    await runEnrichment(e2e.db, metadataService, e2e.services.book, e2e.app.log);
  }

  it('PUT { seriesName: null } persists the tombstone and echoes the parsed set', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();

    const res = await e2e.app.inject({
      method: 'PUT',
      url: `/api/books/${bookId}`,
      payload: { seriesName: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().userClearedFields).toEqual(['seriesName']);
    const row = await readRow(bookId);
    expect(row.userClearedFields).toBe('["seriesName"]');
    expect(row.seriesName).toBeNull();
  });

  it('GET /api/books/:id returns the parsed array and never the raw string', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });

    const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().userClearedFields).toEqual(['seriesName']);
    expect(res.payload).not.toContain('"[\\"seriesName\\"]"');
  });

  it('the series card resolves to null once the clear is persisted', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });

    const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/series` });

    expect(res.statusCode).toBe(200);
    expect(res.json().series).toBeNull();
  });

  it('AC20: a full enrichment cycle after the clear does NOT resurrect the provider series', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });
    // A real re-pick or refresh makes the row eligible for enrichment.
    await e2e.db.update(books).set({ enrichmentStatus: 'pending' }).where(eq(books.id, bookId));

    await runEnrichmentPass();

    const row = await readRow(bookId);
    expect(row.seriesName).toBeNull();
    expect(row.seriesPosition).toBeNull();
    expect(row.userClearedFields).toBe('["seriesName"]');
    expect(row.enrichmentStatus).toBe('enriched');
    expect(row.publisher).toBe('Dragonsteel');
  });

  it('AC21 control: an untouched book DOES get its series filled by the same pass', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.db.update(books).set({ enrichmentStatus: 'pending' }).where(eq(books.id, bookId));

    await runEnrichmentPass();

    const row = await readRow(bookId);
    expect(row.seriesName).toBe('Secret Projects');
    expect(row.seriesPosition).toBe(1);
  });

  it('AC22: setting a new series removes the tombstone and enrichment treats it normally again', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });

    const res = await e2e.app.inject({
      method: 'PUT',
      url: `/api/books/${bookId}`,
      payload: { seriesName: 'Cosmere', seriesPosition: 3 },
    });

    expect(res.json().userClearedFields).toEqual([]);
    const row = await readRow(bookId);
    expect(row.userClearedFields).toBeNull();
    expect(row.seriesName).toBe('Cosmere');
  });

  // With no response schema, a seeded tombstone proves BookListService strips the raw column.
  it('GET /api/books never serializes the raw tombstone column', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });
    expect((await readRow(bookId)).userClearedFields).toBe('["seriesName"]');

    const res = await e2e.app.inject({ method: 'GET', url: '/api/books' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('userClearedFields');
    const [listed] = res.json().data as Record<string, unknown>[];
    expect(listed).toBeDefined();
    expect('userClearedFields' in listed!).toBe(false);
    expect(listed!.title).toBe('Tress of the Emerald Sea');
  });

  describe('clearing the position alone (#2152)', () => {
    async function seedNumberedFranchiseBook(): Promise<number> {
      const [row] = await e2e.db
        .insert(books)
        .values({
          publicId: generatePublicId('bk'),
          title: 'Hunters of Dune',
          status: 'imported',
          enrichmentStatus: 'enriched',
          seriesName: 'Dune',
          seriesPosition: 7,
          asin: 'B0BHUNTERS',
        })
        .returning();
      return row!.id;
    }

    it('PUT { seriesPosition: null } persists the tombstone and echoes the parsed set', async () => {
      const bookId = await seedNumberedFranchiseBook();

      const res = await e2e.app.inject({
        method: 'PUT',
        url: `/api/books/${bookId}`,
        payload: { seriesPosition: null },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().userClearedFields).toEqual(['seriesPosition']);
      const row = await readRow(bookId);
      expect(row.userClearedFields).toBe('["seriesPosition"]');
      expect(row.seriesPosition).toBeNull();
      expect(row.seriesName).toBe('Dune');
    });

    it('GET /api/books/:id echoes seriesPosition inside the parsed array, never the raw column', async () => {
      const bookId = await seedNumberedFranchiseBook();
      await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesPosition: null } });

      const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });

      expect(res.statusCode).toBe(200);
      expect(res.json().userClearedFields).toEqual(['seriesPosition']);
      expect(res.payload).not.toContain('"[\\"seriesPosition\\"]"');
    });

    it('a full enrichment cycle after the clear does NOT resurrect the position', async () => {
      const bookId = await seedNumberedFranchiseBook();
      await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesPosition: null } });
      // fillSeriesFields only runs without a stored name; this orphaned shape reaches suppression.
      await e2e.db.update(books).set({ enrichmentStatus: 'pending', seriesName: null }).where(eq(books.id, bookId));

      await runEnrichmentPass();

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Secret Projects');
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBe('["seriesPosition"]');
      expect(row.enrichmentStatus).toBe('enriched');
      expect(row.publisher).toBe('Dragonsteel');
    });

    it('control: the same book WITHOUT the tombstone gets the provider position from the same pass', async () => {
      const bookId = await seedNumberedFranchiseBook();
      await e2e.db.update(books).set({ enrichmentStatus: 'pending', seriesName: null }).where(eq(books.id, bookId));

      await runEnrichmentPass();

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Secret Projects');
      expect(row.seriesPosition).toBe(1);
    });

    it('GET /api/books/:id/series shows that member with position null', async () => {
      const bookId = await seedNumberedFranchiseBook();
      await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesPosition: null } });

      const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/series` });

      expect(res.statusCode).toBe(200);
      const member = res.json().series.members.find((m: { libraryBookId: number }) => m.libraryBookId === bookId);
      expect(member).toBeDefined();
      expect(member.position).toBeNull();
    });

    it('re-assertion: typing a number back clears the tombstone and stores it', async () => {
      const bookId = await seedNumberedFranchiseBook();
      await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesPosition: null } });

      const res = await e2e.app.inject({
        method: 'PUT',
        url: `/api/books/${bookId}`,
        payload: { seriesPosition: 12 },
      });

      expect(res.json().userClearedFields).toEqual([]);
      const row = await readRow(bookId);
      expect(row.seriesPosition).toBe(12);
      expect(row.userClearedFields).toBeNull();
    });
  });
});
