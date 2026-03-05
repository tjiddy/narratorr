/**
 * Puppeteer script for LHCI.
 * Handles auth login and metadata API interception for search/author pages.
 * Called by LHCI before each URL audit via the puppeteerScript option.
 *
 * LHCI calls: module.exports(browser, { url, options })
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Canned responses matching actual API contracts:
// - MetadataSearchResults: { books: BookMetadata[], authors: AuthorMetadata[], series: [] }
// - AuthorMetadata: { asin, name, description, imageUrl, genres, relevance }
// - BookMetadata: { asin, title, authors, narrators, series, description, coverUrl, duration, genres }

const CANNED_SEARCH_RESPONSE = {
  books: [
    {
      asin: 'B000TESTBK',
      title: 'The Lighthouse Test Book',
      authors: [{ name: 'Test Author', asin: 'B000TESTAU' }],
      narrators: ['Test Narrator'],
      series: [{ name: 'Lighthouse Series', position: 1 }],
      description: 'A book for Lighthouse testing.',
      coverUrl: 'https://via.placeholder.com/300x300',
      duration: 36000,
      genres: ['Fiction', 'Testing'],
      providerId: 'audnexus:B000TESTBK',
      relevance: 100,
    },
    {
      asin: 'B000TEST02',
      title: 'Another Test Audiobook',
      authors: [{ name: 'Second Author', asin: 'B000TESTAU' }],
      narrators: ['Another Narrator'],
      description: 'Another test book for search results.',
      coverUrl: 'https://via.placeholder.com/300x300',
      duration: 28800,
      genres: ['Fiction'],
      providerId: 'audnexus:B000TEST02',
      relevance: 90,
    },
  ],
  authors: [
    {
      asin: 'B000TESTAU',
      name: 'Test Author',
      description: 'An author for Lighthouse testing.',
      imageUrl: 'https://via.placeholder.com/300x300',
      genres: ['Fiction'],
      relevance: 100,
    },
  ],
  series: [],
};

const CANNED_AUTHOR = {
  asin: 'B000TESTAU',
  name: 'Test Author',
  description: 'An author profile for Lighthouse testing.',
  imageUrl: 'https://via.placeholder.com/300x300',
  genres: ['Fiction'],
};

const CANNED_AUTHOR_BOOKS = [
  {
    asin: 'B000TESTBK',
    title: 'The Lighthouse Test Book',
    authors: [{ name: 'Test Author', asin: 'B000TESTAU' }],
    narrators: ['Test Narrator'],
    series: [{ name: 'Lighthouse Series', position: 1 }],
    description: 'A book for Lighthouse testing.',
    coverUrl: 'https://via.placeholder.com/300x300',
    duration: 36000,
    genres: ['Fiction', 'Testing'],
    providerId: 'audnexus:B000TESTBK',
  },
];

/**
 * @param {import('puppeteer').Browser} browser
 * @param {{ url: string, options: Record<string, unknown> }} context
 */
export default async function (browser, context) {
  const page = await browser.newPage();
  const url = new URL(context.url);
  const pathname = url.pathname;

  // Read session cookie saved by the orchestrator
  const cookiePath = join(process.cwd(), 'lighthouse-reports', 'session-cookie.txt');
  let sessionCookie = '';
  if (existsSync(cookiePath)) {
    sessionCookie = readFileSync(cookiePath, 'utf-8').trim();
  }

  // Set auth cookie for protected pages (everything except /login)
  if (sessionCookie && pathname !== '/login') {
    await page.setCookie({
      name: 'narratorr_session',
      value: sessionCookie,
      domain: url.hostname,
      path: '/',
    });
  }

  // Set up metadata API interception for search and author pages
  const needsInterception = pathname === '/search' || pathname.startsWith('/authors/');

  if (needsInterception) {
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      const reqUrl = request.url();

      if (reqUrl.includes('/api/metadata/search')) {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CANNED_SEARCH_RESPONSE),
        });
      } else if (reqUrl.match(/\/api\/metadata\/authors\/[^/]+\/books/)) {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CANNED_AUTHOR_BOOKS),
        });
      } else if (reqUrl.match(/\/api\/metadata\/authors\/[^/]+$/)) {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(CANNED_AUTHOR),
        });
      } else {
        request.continue();
      }
    });
  }

  // Navigate to the page
  await page.goto(context.url, { waitUntil: 'networkidle0' });

  // For search page, type query then submit the form (search triggers on form submit)
  if (pathname === '/search') {
    const searchInput = await page.$('input[type="text"]');
    if (searchInput) {
      await searchInput.type('test');
      // Submit the form — search triggers on form submit, not on typing
      await page.keyboard.press('Enter');
      // Wait for API response + React re-render
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await page.close();
}
