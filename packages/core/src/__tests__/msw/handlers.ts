import { http, HttpResponse } from 'msw';
import authorSearchFixture from '../fixtures/audnexus-author-search.json';
import authorFixture from '../fixtures/audnexus-author.json';
import bookFixture from '../fixtures/audnexus-book.json';
import hardcoverBookSearch from '../fixtures/hardcover-book-search.json';
import hardcoverAuthorSearch from '../fixtures/hardcover-author-search.json';
import hardcoverSeriesSearch from '../fixtures/hardcover-series-search.json';
import hardcoverBookDetail from '../fixtures/hardcover-book-detail.json';
import hardcoverAuthorDetail from '../fixtures/hardcover-author-detail.json';
import hardcoverSeriesDetail from '../fixtures/hardcover-series-detail.json';

export const audnexusHandlers = [
  http.get('https://api.audnex.us/authors', ({ request }) => {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');
    if (!name) return HttpResponse.json([]);
    return HttpResponse.json(authorSearchFixture);
  }),

  http.get('https://api.audnex.us/authors/:asin', () => {
    return HttpResponse.json(authorFixture);
  }),

  http.get('https://api.audnex.us/books/:asin', () => {
    return HttpResponse.json(bookFixture);
  }),
];

export const hardcoverHandlers = [
  http.post('https://api.hardcover.app/v1/graphql', async ({ request }) => {
    const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
    const query = body.query ?? '';

    // Search queries
    if (query.includes('search(')) {
      const queryType = (body.variables?.type as string) ?? 'Book';
      switch (queryType) {
        case 'Book':
          return HttpResponse.json(hardcoverBookSearch);
        case 'Author':
          return HttpResponse.json(hardcoverAuthorSearch);
        case 'Series':
          return HttpResponse.json(hardcoverSeriesSearch);
        default:
          return HttpResponse.json(hardcoverBookSearch);
      }
    }

    // Detail queries
    if (query.includes('books(')) {
      return HttpResponse.json(hardcoverBookDetail);
    }
    if (query.includes('authors(')) {
      return HttpResponse.json(hardcoverAuthorDetail);
    }
    if (query.includes('series(')) {
      return HttpResponse.json(hardcoverSeriesDetail);
    }

    return HttpResponse.json({ data: null });
  }),
];

export const handlers = [...audnexusHandlers, ...hardcoverHandlers];
