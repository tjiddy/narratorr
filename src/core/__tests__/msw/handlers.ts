import { http, HttpResponse } from 'msw';
import authorSearchFixture from '../fixtures/audnexus-author-search.json';
import authorFixture from '../fixtures/audnexus-author.json';
import bookFixture from '../fixtures/audnexus-book.json';
import audibleSearch from '../fixtures/audible-search.json';

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

export const audibleHandlers = [
  http.get('https://api.audible.com/1.0/catalog/products', () => {
    return HttpResponse.json(audibleSearch);
  }),

  http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
    const product = audibleSearch.products[0];
    return HttpResponse.json({ product });
  }),
];

export const handlers = [...audnexusHandlers, ...audibleHandlers];
