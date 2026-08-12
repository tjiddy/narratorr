import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

/** Fail any network call; discovery must remain filesystem-only. */
const mswServer = setupServer();

describe('Library scan → Discovery flow E2E', () => {
  let e2e: E2EApp;
  let scanRoot: string;

  const FILE_SIZE_SMALL = 1024;
  const FILE_SIZE_LARGE = 2048;

  /** Temp directory covers Author/Title, Author/Series/Title, multi-file, CD1/CD2, dedup-test, empty-dir, and text-only. */
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    scanRoot = await mkdtemp(join(tmpdir(), 'narratorr-scan-e2e-'));

    const createFile = async (filePath: string, size: number) => {
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, Buffer.alloc(size));
    };

    await createFile(
      join(scanRoot, 'Brandon Sanderson', 'The Way of Kings', 'book.m4b'),
      FILE_SIZE_SMALL,
    );

    await createFile(
      join(scanRoot, 'Brandon Sanderson', 'The Stormlight Archive', 'Words of Radiance', 'chapter1.mp3'),
      FILE_SIZE_LARGE,
    );

    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'part1.m4b'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'part2.m4b'),
      FILE_SIZE_LARGE,
    );
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'cover.jpg'),
      512,
    );

    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Long Book', 'CD1', 'track.mp3'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Long Book', 'CD2', 'track.mp3'),
      FILE_SIZE_LARGE,
    );

    await createFile(
      join(scanRoot, 'dedup-test', 'Brandon Sanderson', 'The Way of Kings', 'book.m4b'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'dedup-test', 'Patrick Rothfuss', 'The Name of the Wind', 'book.m4b'),
      FILE_SIZE_SMALL,
    );

    await mkdir(join(scanRoot, 'empty-dir'), { recursive: true });

    await createFile(join(scanRoot, 'text-only', 'notes.txt'), 256);
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(scanRoot, { recursive: true, force: true });
  });

  it('discovers books from Author/Title folder structure with correct parsed fields', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: scanRoot },
    });

    expect(res.statusCode).toBe(200);

    const result = res.json();
    expect(result.totalFolders).toBe(6);
    expect(result.discoveries).toHaveLength(6);

    const wayOfKings = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'The Way of Kings',
    );
    expect(wayOfKings).toBeDefined();
    expect(wayOfKings.parsedAuthor).toBe('Brandon Sanderson');
    expect(wayOfKings.parsedSeries).toBeNull();
    expect(wayOfKings.path).toBe(join(scanRoot, 'Brandon Sanderson', 'The Way of Kings'));
  });

  it('parses series from Author/Series/Title folder structure', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: scanRoot },
    });

    const result = res.json();
    const wordsOfRadiance = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'Words of Radiance',
    );
    expect(wordsOfRadiance).toBeDefined();
    expect(wordsOfRadiance.parsedAuthor).toBe('Brandon Sanderson');
    expect(wordsOfRadiance.parsedSeries).toBe('The Stormlight Archive');
  });

  it('reports correct fileCount and totalSize for multi-file book', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: scanRoot },
    });

    const result = res.json();
    const guards = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'Guards! Guards!',
    );
    expect(guards).toBeDefined();
    expect(guards.fileCount).toBe(2);
    expect(guards.totalSize).toBe(FILE_SIZE_SMALL + FILE_SIZE_LARGE);
  });

  it('merges disc folders (CD1/CD2) into a single discovery', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: scanRoot },
    });

    const result = res.json();

    const longBook = result.discoveries.find((d: { path: string }) =>
      d.path === join(scanRoot, 'Terry Pratchett', 'Long Book'),
    );
    expect(longBook).toBeDefined();
    expect(longBook.fileCount).toBe(2);
    expect(longBook.totalSize).toBe(FILE_SIZE_SMALL + FILE_SIZE_LARGE);

    const cd1 = result.discoveries.find((d: { path: string }) =>
      d.path.includes('CD1'),
    );
    expect(cd1).toBeUndefined();
  });

  it('surfaces a title+author match as a review-hint candidate (no decisive ASIN, #1711 F6)', async () => {
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      },
    });
    expect(bookRes.statusCode).toBe(201);

    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: join(scanRoot, 'dedup-test') },
    });

    expect(res.statusCode).toBe(200);
    const result = res.json();

    expect(result.totalFolders).toBe(2);
    expect(result.discoveries).toHaveLength(2);

    // Without a decisive ASIN, title+author becomes a review hint rather than a hard duplicate (#1711 F6).
    const wayOfKings = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'The Way of Kings',
    );
    expect(wayOfKings).toBeDefined();
    expect(wayOfKings.isDuplicate).toBe(false);
    expect(wayOfKings.reviewReason).toBeDefined();

    const nameOfTheWind = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'The Name of the Wind',
    );
    expect(nameOfTheWind).toBeDefined();
    expect(nameOfTheWind.isDuplicate).toBe(false);
  });

  it('returns zero discoveries for empty directory', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: join(scanRoot, 'empty-dir') },
    });

    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.totalFolders).toBe(0);
    expect(result.discoveries).toHaveLength(0);
  });

  it('returns zero discoveries for directory with only non-audio files', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: join(scanRoot, 'text-only') },
    });

    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.totalFolders).toBe(0);
    expect(result.discoveries).toHaveLength(0);
  });

  it('uses normalized paths in discovery results (cross-platform)', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: scanRoot },
    });

    const result = res.json();

    for (const discovery of result.discoveries) {
      const expectedBase = join(scanRoot, '');
      expect(discovery.path.startsWith(expectedBase.slice(0, -1))).toBe(true);
    }

    const guards = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'Guards! Guards!',
    );
    if (guards) {
      expect(guards.path).toBe(
        join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!'),
      );
    }
  });
});
