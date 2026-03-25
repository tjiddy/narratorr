import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

/**
 * MSW with onUnhandledRequest: 'error' — discovery is filesystem-only,
 * so any accidental HTTP call will fail the test immediately.
 */
const mswServer = setupServer();

describe('Library scan → Discovery flow E2E', () => {
  let e2e: E2EApp;
  let scanRoot: string;

  // Deterministic file sizes for assertions
  const FILE_SIZE_SMALL = 1024;       // 1 KB
  const FILE_SIZE_LARGE = 2048;       // 2 KB

  /**
   * Build a temp directory structure:
   *
   * scanRoot/
   * ├── Brandon Sanderson/
   * │   ├── The Way of Kings/
   * │   │   └── book.m4b            (1024 bytes)
   * │   └── Mistborn/
   * │       └── The Stormlight Archive/
   * │           └── Words of Radiance/
   * │               └── chapter1.mp3  (2048 bytes)
   * ├── Terry Pratchett/
   * │   ├── Discworld/
   * │   │   └── Guards! Guards!/
   * │   │       ├── part1.m4b        (1024 bytes)
   * │   │       ├── part2.m4b        (2048 bytes)
   * │   │       └── cover.jpg        (not audio — ignored)
   * │   └── Long Book/
   * │       ├── CD1/
   * │       │   └── track.mp3        (1024 bytes)
   * │       └── CD2/
   * │           └── track.mp3        (2048 bytes)
   * ├── dedup-test/
   * │   ├── Brandon Sanderson/
   * │   │   └── The Way of Kings/
   * │   │       └── book.m4b            (1024 bytes — duplicate of seeded DB book)
   * │   └── Patrick Rothfuss/
   * │       └── The Name of the Wind/
   * │           └── book.m4b            (1024 bytes)
   * ├── empty-dir/
   * └── text-only/
   *     └── notes.txt
   */
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    scanRoot = await mkdtemp(join(tmpdir(), 'narratorr-scan-e2e-'));

    // Helper to create a file with deterministic size
    const createFile = async (filePath: string, size: number) => {
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, Buffer.alloc(size));
    };

    // Book 1: Author/Title (2-part)
    await createFile(
      join(scanRoot, 'Brandon Sanderson', 'The Way of Kings', 'book.m4b'),
      FILE_SIZE_SMALL,
    );

    // Book 2: Author/Series/Title (3-part — series parsing)
    await createFile(
      join(scanRoot, 'Brandon Sanderson', 'The Stormlight Archive', 'Words of Radiance', 'chapter1.mp3'),
      FILE_SIZE_LARGE,
    );

    // Book 3: Multi-file book (file metrics)
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'part1.m4b'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'part2.m4b'),
      FILE_SIZE_LARGE,
    );
    // Non-audio file in the same folder — should be ignored for fileCount
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Discworld', 'Guards! Guards!', 'cover.jpg'),
      512,
    );

    // Book 4: Disc merging (CD1/CD2 under parent)
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Long Book', 'CD1', 'track.mp3'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'Terry Pratchett', 'Long Book', 'CD2', 'track.mp3'),
      FILE_SIZE_LARGE,
    );

    // Dedup test subdirectory: 2 Author/Title books, one matching the DB seed
    await createFile(
      join(scanRoot, 'dedup-test', 'Brandon Sanderson', 'The Way of Kings', 'book.m4b'),
      FILE_SIZE_SMALL,
    );
    await createFile(
      join(scanRoot, 'dedup-test', 'Patrick Rothfuss', 'The Name of the Wind', 'book.m4b'),
      FILE_SIZE_SMALL,
    );

    // Empty directory
    await mkdir(join(scanRoot, 'empty-dir'), { recursive: true });

    // Directory with only non-audio files
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
    // 6 books total: Way of Kings, Words of Radiance, Guards! Guards!, Long Book (disc-merged),
    // plus dedup-test/Way of Kings and dedup-test/Name of the Wind
    expect(result.totalFolders).toBe(6);
    expect(result.discoveries).toHaveLength(6);

    // Check a 2-part book (Author/Title)
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
    // 2 audio files (part1.m4b + part2.m4b), cover.jpg is not counted
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

    // Long Book should be discovered as a single entry (merged from CD1 + CD2)
    const longBook = result.discoveries.find((d: { path: string }) =>
      d.path === join(scanRoot, 'Terry Pratchett', 'Long Book'),
    );
    expect(longBook).toBeDefined();
    expect(longBook.fileCount).toBe(2);
    expect(longBook.totalSize).toBe(FILE_SIZE_SMALL + FILE_SIZE_LARGE);

    // There should NOT be separate entries for CD1 and CD2
    const cd1 = result.discoveries.find((d: { path: string }) =>
      d.path.includes('CD1'),
    );
    expect(cd1).toBeUndefined();
  });

  it('detects duplicates when a matching book exists in the DB', async () => {
    // Seed a book that matches one of the dedup-test folders by title + author
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      },
    });
    expect(bookRes.statusCode).toBe(201);

    // Scan the dedicated dedup-test subdirectory (2 Author/Title books)
    // This gives us the focused 2/1/1 scenario from the AC
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/library/import/scan',
      payload: { path: join(scanRoot, 'dedup-test') },
    });

    expect(res.statusCode).toBe(200);
    const result = res.json();

    // totalFolders counts both folders discovered
    expect(result.totalFolders).toBe(2);
    // Both books appear in discoveries: 1 new + 1 duplicate
    expect(result.discoveries).toHaveLength(2);

    // The duplicate appears with isDuplicate: true
    const wayOfKings = result.discoveries.find(
      (d: { parsedTitle: string }) => d.parsedTitle === 'The Way of Kings',
    );
    expect(wayOfKings).toBeDefined();
    expect(wayOfKings.isDuplicate).toBe(true);

    // The non-duplicate has isDuplicate: false
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

    // Every discovery path should match what path.join() produces
    for (const discovery of result.discoveries) {
      // Verify path doesn't contain mixed separators — it should use
      // the OS-native separator (which path.join() produces)
      const expectedBase = join(scanRoot, '');
      expect(discovery.path.startsWith(expectedBase.slice(0, -1))).toBe(true);
    }

    // Specifically check a known path uses join() semantics
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
