import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { inArray } from 'drizzle-orm';
import { authors, books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { BOOK_STATUSES } from '@shared/schemas/book.js';
import { DEFAULT_LIMITS } from '@shared/schemas/common.js';

describe('Books E2E', () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('GET /api/books returns empty array initially', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
  });

  it('POST /api/books creates a book and returns 201', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer'],
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    const book = res.json();
    expect(book.id).toBeDefined();
    expect(book.title).toBe('The Way of Kings');
    expect(book.authors[0]?.name).toBe('Brandon Sanderson');
    expect(book.narrators[0]?.name).toBe('Michael Kramer');
    expect(book.status).toBe('wanted');
  });

  it('GET /api/books returns the created book', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    expect(res.statusCode).toBe(200);
    const { data: books, total } = res.json();
    expect(books).toHaveLength(1);
    expect(total).toBe(1);
    expect(books[0].title).toBe('The Way of Kings');
  });

  it('GET /api/books/:id returns a single book', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    const bookId = listRes.json().data[0].id;

    const res = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('The Way of Kings');
  });

  it('GET /api/books/:id returns 404 for non-existent book', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/books/99999' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/books/:id updates a book', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    const bookId = listRes.json().data[0].id;

    const res = await e2e.app.inject({
      method: 'PUT',
      url: `/api/books/${bookId}`,
      payload: { narrators: ['Kate Reading'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().narrators[0]?.name).toBe('Kate Reading');
  });

  it('POST /api/books rejects duplicates with 409', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it('POST /api/books without title returns 400', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { authors: [{ name: 'Someone' }] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/books/:id removes a book', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    const bookId = listRes.json().data[0].id;

    const delRes = await e2e.app.inject({ method: 'DELETE', url: `/api/books/${bookId}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ success: true });

    const getRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('DELETE /api/books/:id returns 404 for non-existent book', async () => {
    const res = await e2e.app.inject({ method: 'DELETE', url: '/api/books/99999' });
    expect(res.statusCode).toBe(404);
  });
});

// Its own app/DB: the suite above asserts absolute list state, so a second book cannot live there.
describe('POST /api/books — a full-cast edition of an owned book is added, not refused (#2206)', () => {
  let e2e: E2EApp;

  // `duration` is MINUTES; the prod specimen is a 13h17m solo edition and a 10h33m full-cast one.
  const SOLO = {
    title: 'The Golden Compass',
    authors: [{ name: 'Philip Pullman' }],
    narrators: ['Ruth Wilson'],
    asin: 'B0D9C9BMTW',
    duration: 797,
  };
  const FULL_CAST = {
    title: 'The Golden Compass',
    authors: [{ name: 'Philip Pullman' }],
    narrators: ['Philip Pullman', 'Rupert Degas', 'Sean Barrett', 'Full Cast'],
    asin: 'B0FULLCAST',
    duration: 633,
  };

  const post = (payload: unknown) => e2e.app.inject({ method: 'POST', url: '/api/books', payload });

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('seeds the solo-narrator incumbent into an empty library', async () => {
    const res = await post(SOLO);
    expect(res.statusCode).toBe(201);
    expect(res.json().narrators.map((n: { name: string }) => n.name)).toEqual(['Ruth Wilson']);
  });

  it('accepts the full-cast edition with 201 and keeps both rows', async () => {
    const res = await post(FULL_CAST);

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.asin).toBe('B0FULLCAST');
    expect(created.narrators.map((n: { name: string }) => n.name)).toContain('Rupert Degas');

    const list = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    expect(list.json().total).toBe(2);
    expect((list.json().data as { asin: string }[]).map((b) => b.asin).sort()).toEqual(['B0D9C9BMTW', 'B0FULLCAST']);
  });

  // Asserts the delta, not the absolute count: the row total here is inherited from the case above,
  // so an absolute assertion would make this control fail for a reason that is not its own.
  it('still refuses a re-post of the incumbent recording with 409, creating no row', async () => {
    const totalOf = async (): Promise<number> =>
      (await e2e.app.inject({ method: 'GET', url: '/api/books' })).json().total;
    const before = await totalOf();

    const res = await post({ ...SOLO, asin: undefined });

    expect(res.statusCode).toBe(409);
    expect(res.json().asin).toBe('B0D9C9BMTW');
    expect(await totalOf()).toBe(before);
  });
});

// Its own app/DB: the abridged veto needs an incumbent whose production_type is not `unknown`.
describe('POST /api/books — an abridged edition of an unabridged incumbent reviews, and can be overridden (#2199)', () => {
  let e2e: E2EApp;

  // No duration on either side, so the resolver falls through to the production-form veto.
  const UNABRIDGED = {
    title: 'Piranesi',
    authors: [{ name: 'Susanna Clarke' }],
    narrators: ['Chiwetel Ejiofor'],
    asin: 'B0UNABRIDG',
    formatType: 'Unabridged',
  };
  const ABRIDGED = { ...UNABRIDGED, asin: 'B0ABRIDGED', formatType: 'abridged  ' };

  const post = (payload: unknown) => e2e.app.inject({ method: 'POST', url: '/api/books', payload });

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('persists the normalized production type on the seeded incumbent', async () => {
    const res = await post(UNABRIDGED);

    expect(res.statusCode).toBe(201);
    expect(res.json().productionType).toBe('unabridged');
  });

  it('holds the abridged edition as an undecided review naming the incumbent', async () => {
    const res = await post(ABRIDGED);
    const body = res.json();

    expect(res.statusCode).toBe(409);
    expect(body.conflict).toBe('review');
    expect(body.recordingReviewReason).toBe('production-type-mismatch');
    expect(body.title).toBe('Piranesi');
    expect(body.asin).toBe('B0UNABRIDG');
  });

  it('creates the abridged edition when the operator overrides the review, and the row is durable', async () => {
    const res = await post({ ...ABRIDGED, overrideRecordingReview: true });

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.productionType).toBe('abridged');

    const reread = await e2e.app.inject({ method: 'GET', url: `/api/books/${created.id}` });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().asin).toBe('B0ABRIDGED');
    expect(reread.json().productionType).toBe('abridged');
  });
});

// Its own app/DB: the route suite can only assert the payload handed to `BookService.create`, and a
// payload can look right while the persisted row is lossy. This is the stronger observable for the
// #2243 wire→create partition — every field read back out of a migrated database.
describe('POST /api/books — every wire persistence field survives to the row (#2243)', () => {
  let e2e: E2EApp;

  const FULL = {
    title: 'Leviathan Wakes',
    authors: [
      { name: 'James S. A. Corey', asin: 'B00AUTHOR1' },
      { name: 'Ty Franck', asin: 'B00AUTHOR2' },
    ],
    narrators: ['Jefferson Mays', 'Kevin R. Free'],
    subtitle: 'Book One of the Expanse',
    description: 'Humanity has colonised the solar system.',
    publisher: 'Orbit',
    coverUrl: 'https://example.com/leviathan.jpg',
    asin: 'B0LEVIATHN',
    isbn: '978-1-84149-989-9',
    seriesName: 'The Expanse',
    seriesPosition: 1,
    duration: 1240,
    publishedDate: '2011-06-02',
    genres: ['Science Fiction'],
    formatType: 'Unabridged',
  };

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  // Distinct identity from FULL on every axis the resolver keys on, so this case's POST is admitted
  // whatever else the suite has written, and its authors can never be another case's rows.
  const CO_AUTHORED = {
    title: 'Nemesis Games',
    authors: [
      { name: 'Daniel Abraham', asin: 'B00AUTHOR3' },
      { name: 'Walter Jon Williams', asin: 'B00AUTHOR4' },
    ],
    asin: 'B0NEMESIS1',
  };

  it('persists every column and both relations, then reads them back', async () => {
    const res = await e2e.app.inject({ method: 'POST', url: '/api/books', payload: { ...FULL, searchImmediately: false } });
    expect(res.statusCode).toBe(201);

    const reread = await e2e.app.inject({ method: 'GET', url: `/api/books/${res.json().id}` });
    expect(reread.statusCode).toBe(200);
    const row = reread.json();

    expect(row).toMatchObject({
      title: 'Leviathan Wakes',
      subtitle: 'Book One of the Expanse',
      description: 'Humanity has colonised the solar system.',
      publisher: 'Orbit',
      coverUrl: 'https://example.com/leviathan.jpg',
      asin: 'B0LEVIATHN',
      isbn: '978-1-84149-989-9',
      seriesName: 'The Expanse',
      seriesPosition: 1,
      duration: 1240,
      publishedDate: '2011-06-02',
      genres: ['Science Fiction'],
      // formatType is translated, never stored; the row carries its normalization.
      productionType: 'unabridged',
      status: 'wanted',
    });
    expect(row.authors.map((a: { name: string }) => a.name)).toEqual(['James S. A. Corey', 'Ty Franck']);
    expect(row.narrators.map((n: { name: string }) => n.name)).toEqual(['Jefferson Mays', 'Kevin R. Free']);
    // Shape guard only, and deliberately here rather than in a case of its own: `buildNewBookValues`
    // never wrote this field, so no persisted observable could red against the pre-#2243 code. AC11's
    // real counterfactual is the create payload (books.test.ts 'sends neither transient flag').
    expect(row).not.toHaveProperty('searchImmediately');
  });

  // Each author's own ASIN reaches `findOrCreateAuthor` through `syncAuthors`, and is invisible in
  // the book payload — the authors table is the only place it can be observed. Arranges and measures
  // its own POST: reading a row another case created makes a focused run fail with no regression.
  it('writes each author row with its own ASIN', async () => {
    const names = CO_AUTHORED.authors.map((a) => a.name);
    expect(await e2e.db.select({ name: authors.name }).from(authors).where(inArray(authors.name, names))).toEqual([]);

    const res = await e2e.app.inject({ method: 'POST', url: '/api/books', payload: CO_AUTHORED });
    expect(res.statusCode).toBe(201);

    const rows = await e2e.db
      .select({ name: authors.name, asin: authors.asin })
      .from(authors)
      .where(inArray(authors.name, names));

    expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Daniel Abraham', asin: 'B00AUTHOR3' },
      { name: 'Walter Jon Williams', asin: 'B00AUTHOR4' },
    ]);
  });
});

// Add-book ownership depends on this endpoint staying status-blind and unpaginated.
describe('GET /api/books/identifiers — unpaginated and status-blind (#1916)', () => {
  let e2e: E2EApp;
  const SEEDED = 131;

  beforeAll(async () => {
    e2e = await createE2EApp();
    const statuses = BOOK_STATUSES;
    await e2e.db.insert(books).values(
      Array.from({ length: SEEDED }, (_, i) => ({
        publicId: generatePublicId('bk'),
        title: `Seeded Book ${i}`,
        asin: `B${String(i).padStart(9, '0')}`,
        status: statuses[i % statuses.length]!,
      })),
    );
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('returns every seeded book across all statuses, well past the 120-row /api/books cap', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/books/identifiers' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: number; asin: string | null; title: string }[];
    expect(body).toHaveLength(SEEDED);
    expect(body.every((row) => typeof row.id === 'number')).toBe(true);

    const returnedAsins = new Set(body.map((row) => row.asin));
    for (let i = 0; i < SEEDED; i++) {
      expect(returnedAsins.has(`B${String(i).padStart(9, '0')}`)).toBe(true);
    }
    expect(BOOK_STATUSES.length).toBeGreaterThan(1);
  });

  it('returns strictly more rows than the default /api/books page', async () => {
    const capped = await e2e.app.inject({ method: 'GET', url: '/api/books' });
    const identifiers = await e2e.app.inject({ method: 'GET', url: '/api/books/identifiers' });

    const cappedRows = capped.json().data as unknown[];
    expect(cappedRows).toHaveLength(DEFAULT_LIMITS.books);
    expect((identifiers.json() as unknown[]).length).toBeGreaterThan(cappedRows.length);
  });
});
