import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books } from '@db/schema.js';
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

// #1916 — the Add-Book search page derives ownership from this endpoint, so it
// must stay unpaginated and status-blind. `/api/books` caps at DEFAULT_LIMITS.books
// (120) and orders created-at-descending; if identifiers ever grew a limit or a
// status predicate, the search card would silently regress to the wrong affordance
// for any book outside the visible page.
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

    // Every seeded ASIN is present — including the ones that fall outside the
    // most-recent 120 rows that `/api/books` would have returned.
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
