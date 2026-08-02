import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { runEnrichment } from '../jobs/enrichment.js';
import type { MetadataService } from '../services/metadata.service.js';

/**
 * The SERVER half of the #2069 provider-only clear workflow (AC20/AC22/AC25), end
 * to end through the real Fastify app, the real services, and a real migrated DB.
 *
 * The fixture is the exact state the issue names as the common case and the reason
 * the feature exists: a post-import book sitting at `enrichmentStatus: 'enriched'`
 * with `series_name = NULL` forever, whose series the operator only ever sees as a
 * provider fallback. `applyEnrichmentData` writes `enriched` while writing no series
 * field, and the scheduled selector only picks pending/skipped/retryable-failed — so
 * nothing ever revisits the row.
 *
 * The client half — modal pre-fill, the payload this suite consumes, cache
 * invalidation and the refetched header — is
 * `src/client/pages/book/metadata-clear-flow.test.tsx`. The two meet at the PUT
 * payload, which both sides assert on literally (`{ seriesName: null }`), so a
 * change on either side of that seam breaks a test rather than silently diverging.
 * They cannot be one test: client suites run in jsdom and server suites in node.
 */
describe('Provider-only metadata clear — server E2E (#2069)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    e2e = await createE2EApp();
  });

  afterEach(async () => {
    await e2e.cleanup();
  });

  /** A book in the exact "enriched, no stored series, provider-only display" state. */
  async function seedEnrichedProviderOnlyBook(): Promise<number> {
    const [row] = await e2e.db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'),
        title: 'Tress of the Emerald Sea',
        status: 'imported',
        // The state that makes the clear inexpressible without AC25: already
        // `enriched`, so no future pass revisits it, and no stored series.
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

  /** One scheduled enrichment pass whose provider result carries the series. */
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

    // The EXACT payload the modal emits for a provider-only clear — see the client
    // half's assertion on `onSave`.
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
    // The stored form must not appear anywhere in the serialized body.
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
    // The clear resets nothing about enrichment, so make the row a candidate the way
    // a real re-pick/refresh would.
    await e2e.db.update(books).set({ enrichmentStatus: 'pending' }).where(eq(books.id, bookId));

    await runEnrichmentPass();

    const row = await readRow(bookId);
    expect(row.seriesName).toBeNull();
    expect(row.seriesPosition).toBeNull();
    expect(row.userClearedFields).toBe('["seriesName"]');
    // The pass still ran and still filled everything untombstoned.
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

  // #2069 AC16 / F4 — the list endpoint's raw-column projection, at the route.
  // `GET /api/books` declares no response schema, so nothing downstream strips
  // extra keys; `BookListService.getAll` spreads whole rows and casts, and the cast
  // is erased at runtime. Only a seeded row proves the strip happened.
  it('GET /api/books never serializes the raw tombstone column', async () => {
    const bookId = await seedEnrichedProviderOnlyBook();
    await e2e.app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { seriesName: null } });
    // Confirm the row really does carry a stored value, so absence below is a strip
    // and not an empty column.
    expect((await readRow(bookId)).userClearedFields).toBe('["seriesName"]');

    const res = await e2e.app.inject({ method: 'GET', url: '/api/books' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('userClearedFields');
    const [listed] = res.json().data as Record<string, unknown>[];
    expect(listed).toBeDefined();
    expect('userClearedFields' in listed!).toBe(false);
    expect(listed!.title).toBe('Tress of the Emerald Sea');
  });
});
