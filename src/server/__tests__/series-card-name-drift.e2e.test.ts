import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, bookAuthors, authors } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * #2175 end to end, through the real Fastify app, the real services and a real
 * migrated DB: two books of ONE series stored with normalized-equal but
 * byte-different `series_name` values ('The Band' vs 'the band').
 *
 * The service-level cases live in `series-card.service.test.ts` /
 * `series-card.integration.test.ts`; what this suite adds is the part the
 * operator actually sees — the JSON `/api/books/:id/series` responds with. The
 * defect was invisible from the drifted book's own card, so a fixture that
 * exercises only one of the two ids cannot see it.
 */
describe('Series card — normalized series-name drift, E2E (#2175)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    e2e = await createE2EApp();
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: 'TEST_KEY' } });
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  async function seedBook(title: string, seriesName: string, position: number): Promise<number> {
    const [book] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'),
      title,
      seriesName,
      seriesPosition: position,
    }).returning();
    const slug = 'nicholas-eames';
    const existing = await e2e.db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id
      ?? (await e2e.db.insert(authors).values({ publicId: generatePublicId('au'), name: 'Nicholas Eames', slug }).returning())[0]!.id;
    await e2e.db.insert(bookAuthors).values({ bookId: book!.id, authorId, position: 0 });
    return book!.id;
  }

  function mockHardcover(): void {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      data: {
        series: [{
          id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
          book_series: [
            { position: 1, book: { id: 7711, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
            { position: 2, book: { id: 7712, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 90 } },
          ],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof globalThis.fetch;
  }

  it('GET /api/books/:id/series reports both books as in-library from EITHER card', async () => {
    const kings = await seedBook('Kings of the Wyld', 'The Band', 1);
    const bloody = await seedBook('Bloody Rose', 'the band', 2);
    mockHardcover();

    for (const bookId of [kings, bloody]) {
      const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}/series` });

      expect(res.statusCode).toBe(200);
      const members = res.json().series.members as { hardcoverBookId: number; inLibrary: boolean; libraryBookId: number | null }[];
      expect(members.map((m) => [m.hardcoverBookId, m.inLibrary, m.libraryBookId]))
        .toEqual([[7711, true, kings], [7712, true, bloody]]);
    }
  });

  it('POST /api/books/:id/series/refresh on the non-drifted book resolves the drifted sibling', async () => {
    const kings = await seedBook('Kings of the Wyld', 'The Band', 1);
    const bloody = await seedBook('Bloody Rose', 'the band', 2);
    mockHardcover();

    const res = await e2e.app.inject({ method: 'POST', url: `/api/books/${kings}/series/refresh` });

    expect(res.statusCode).toBe(200);
    const members = res.json().series.members as { inLibrary: boolean; libraryBookId: number | null }[];
    expect(members.map((m) => m.libraryBookId)).toEqual([kings, bloody]);
    expect(members.every((m) => m.inLibrary)).toBe(true);
    // A render/refresh never canonicalizes the stored spelling (#2175 AC10).
    expect((await e2e.db.select().from(books).where(eq(books.id, bloody)))[0]!.seriesName).toBe('the band');
  });

  it('POST /api/books/:id/series/bind canonicalizes the drifted sibling too', async () => {
    const kings = await seedBook('Kings of the Wyld', 'The Band', 1);
    const bloody = await seedBook('Bloody Rose', 'the band', 9);
    mockHardcover();

    const res = await e2e.app.inject({
      method: 'POST',
      url: `/api/books/${kings}/series/bind`,
      payload: { hardcoverSeriesId: 5523 },
    });

    expect(res.statusCode).toBe(200);
    const members = res.json().series.members as { libraryBookId: number | null }[];
    expect(members.map((m) => m.libraryBookId)).toEqual([kings, bloody]);
    // The bind IS the one path that rewrites names, and it now reaches the
    // drifted sibling — both rows carry the canonical spelling and position.
    const rows = await e2e.db.select().from(books);
    expect(rows.find((r) => r.id === bloody)!.seriesName).toBe('The Band');
    expect(rows.find((r) => r.id === bloody)!.seriesPosition).toBe(2);
  });
});
