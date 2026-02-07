import { http, HttpResponse } from 'msw';
import authorSearchFixture from '../fixtures/audnexus-author-search.json';
import authorFixture from '../fixtures/audnexus-author.json';
import bookFixture from '../fixtures/audnexus-book.json';

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

export const handlers = [...audnexusHandlers];
