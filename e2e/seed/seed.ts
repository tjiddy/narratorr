/**
 * Seeds the database with test data for Lighthouse audits.
 * Creates a library path setting and a test book so data-dependent pages render content.
 * Standalone module — reusable by future Playwright setup.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface SeedResult {
  bookId: number;
}

export async function seedData(baseUrl: string, sessionCookie: string): Promise<SeedResult> {
  const headers = {
    'Content-Type': 'application/json',
    Cookie: `narratorr_session=${sessionCookie}`,
  };

  // 1. Set library path (required for book pages to render properly)
  const settingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      library: { path: '/tmp/lighthouse-library' },
    }),
  });
  if (!settingsRes.ok) {
    throw new Error(`Failed to update library settings: ${settingsRes.status}`);
  }

  // 2. Create a test book
  const bookRes = await fetch(`${baseUrl}/api/books`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'The Lighthouse Test Book',
      authorName: 'Test Author',
      authorAsin: 'B000TESTAU',
      narrator: 'Test Narrator',
      description: 'A book created for Lighthouse audit testing.',
      asin: 'B000TESTBK',
      seriesName: 'Lighthouse Series',
      seriesPosition: 1,
      duration: 36000,
      publishedDate: '2024-01-01',
      genres: ['Fiction', 'Testing'],
    }),
  });

  if (!bookRes.ok && bookRes.status !== 409) {
    throw new Error(`Failed to create test book: ${bookRes.status}`);
  }

  const book = await bookRes.json();
  const bookId = book.id;

  return { bookId };
}

/**
 * Writes seed results to a file so lighthouserc.js can read dynamic IDs.
 */
export function writeSeedResults(outputDir: string, results: SeedResult): void {
  writeFileSync(join(outputDir, 'seed-results.json'), JSON.stringify(results, null, 2));
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const baseUrl = process.argv[2] || 'http://localhost:3199';
  const sessionCookie = process.argv[3];
  if (!sessionCookie) {
    console.error('Usage: seed.ts <baseUrl> <sessionCookie>');
    process.exit(1);
  }
  seedData(baseUrl, sessionCookie)
    .then((results) => {
      console.log('Seed complete:', results);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
