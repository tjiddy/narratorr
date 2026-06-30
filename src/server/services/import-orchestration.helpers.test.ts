import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { confirmImport, copyToLibrary, type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { ContentFailureError } from '../utils/import-helpers.js';
import { MarkerPathConflictError } from '../utils/import-staging.js';
import { mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportConfirmItem } from './library-scan.service.js';

// copyToLibrary returns the target POSIX-normalized (paths are stored in the DB and consumed
// inside Docker/Linux). The test `target` is a real tmpdir path — native-separator, so it carries
// backslashes on Windows. Normalize the expected before comparing so the return-value assertions
// hold on a Windows dev machine, not just on Linux CI.
const toPosix = (p: string): string => p.split('\\').join('/');

vi.mock('./enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('./enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('./library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

// Controllable wrappers around node:fs/promises `rm`/`cp`. Both default to the
// real implementation (passthrough); individual tests in the staged-swap cleanup
// suite override them to simulate a vanished/permission-denied source removal or
// an undersized copy. Restored to passthrough in that suite's beforeEach.
type AnyFsFn = (...args: unknown[]) => Promise<unknown>;
const fsMocks = vi.hoisted(() => {
  const noop: AnyFsFn = () => Promise.resolve();
  return { rm: vi.fn(), cp: vi.fn(), readdir: vi.fn(), real: { rm: noop, cp: noop, readdir: noop } };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsMocks.real.rm = actual.rm as unknown as AnyFsFn;
  fsMocks.real.cp = actual.cp as unknown as AnyFsFn;
  fsMocks.real.readdir = actual.readdir as unknown as AnyFsFn;
  fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
  fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));
  fsMocks.readdir.mockImplementation((...args: unknown[]) => fsMocks.real.readdir(...args));
  return { ...actual, rm: fsMocks.rm, cp: fsMocks.cp, readdir: fsMocks.readdir };
});

function createMockLogger(): FastifyBaseLogger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('confirmImport — import_jobs creation (#635)', () => {
  let deps: ImportPipelineDeps;
  let mockBookService: { findDuplicate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  let mockBookImportService: { enqueue: ReturnType<typeof vi.fn> };
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let insertValues: ReturnType<typeof vi.fn>;
  let nudgeWorker: () => void;

  beforeEach(() => {
    insertValues = vi.fn().mockResolvedValue(undefined);
    const chainMethods = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockReturnThis(),
    };
    const db = {
      select: vi.fn().mockReturnValue(chainMethods),
      update: vi.fn().mockReturnValue(chainMethods),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      delete: vi.fn().mockReturnValue(chainMethods),
      transaction: vi.fn(),
    };

    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null }),
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({
        id: 1, title: data.title, status: 'importing',
      })),
    };
    let nextJobId = 100;
    mockBookImportService = {
      enqueue: vi.fn().mockImplementation(async () => ({ jobId: nextJobId++ })),
    };
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    nudgeWorker = vi.fn() as unknown as () => void;

    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library' } });

    deps = {
      db: inject<Db>(db),
      log,
      bookService: inject<BookService>(mockBookService),
      bookImportService: inject<BookImportService>(mockBookImportService),
      settingsService: inject<SettingsService>(mockSettingsService),
      eventHistory: inject<EventHistoryService>(mockEventHistory),
      enrichmentDeps: {
        db: inject<Db>(db),
        log,
        settingsService: inject<SettingsService>(mockSettingsService),
        bookService: inject<BookService>(mockBookService),
        metadataService: { searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() } as never,
      } satisfies EnrichmentDeps,
      broadcaster: { emit: vi.fn() } as unknown as EventBroadcasterService,
    };
  });

  it('creates book placeholder AND import_jobs row for each accepted item', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    const result = await confirmImport(
      [{ path: '/audiobooks/Author/Title', title: 'Test', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 1, heldReview: [] });
    expect(mockBookService.create).toHaveBeenCalledTimes(1);
    expect(mockBookImportService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      type: 'manual',
    }));

    // Verify metadata contains mode
    const enqueueCall = mockBookImportService.enqueue.mock.calls[0]![0];
    const metadata = JSON.parse(enqueueCall.metadata);
    expect(metadata.mode).toBe('copy');
    expect(metadata.title).toBe('Test');
    expect(metadata.authorName).toBe('Author');
  });

  it('pointer mode: metadata JSON omits mode key', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 10, title: 'Pointer', status: 'importing' });

    await confirmImport(
      [{ path: '/audiobooks/X', title: 'Pointer' }],
      deps,
      undefined, // pointer mode
      nudgeWorker,
    );

    const enqueueCall = mockBookImportService.enqueue.mock.calls[0]![0];
    const metadata = JSON.parse(enqueueCall.metadata);
    expect(metadata.mode).toBeUndefined();
  });

  it('nudges worker after creating import_jobs rows', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 1, title: 'A', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'A' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(nudgeWorker).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when no items accepted', async () => {
    mockBookService.findDuplicate.mockResolvedValueOnce({ verdict: 'same-recording', book: { id: 1, title: 'Dup' } });

    await confirmImport(
      [{ path: '/a/b', title: 'Dup', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(nudgeWorker).not.toHaveBeenCalled();
  });

  it('does not nudge when nudgeWorker is undefined', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 1, title: 'A', status: 'importing' });

    // No nudgeWorker passed — should not throw
    await confirmImport(
      [{ path: '/a', title: 'A' }],
      deps,
      'copy',
    );

    // Just verify it didn't throw
    expect(mockBookImportService.enqueue).toHaveBeenCalled();
  });

  it('skips duplicates without creating import_jobs row', async () => {
    mockBookService.findDuplicate.mockResolvedValueOnce({ verdict: 'same-recording', book: { id: 99, title: 'Dup' } });

    const result = await confirmImport(
      [{ path: '/a/b', title: 'Dup', authorName: 'Author' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 0, heldReview: [] });
    expect(mockBookImportService.enqueue).not.toHaveBeenCalled();
  });

  it('forwards the matched ASIN to findDuplicate, falling back to metadata.asin (#1662)', async () => {
    mockBookService.findDuplicate.mockResolvedValue({ verdict: 'different-recording', book: null });

    await confirmImport(
      [
        { path: '/a/b', title: 'With Asin', authorName: 'Author', asin: 'B0TOPLEVEL' },
        { path: '/a/c', title: 'Meta Asin', authorName: 'Author', metadata: { title: 'Meta Asin', authors: [], asin: 'B0METADATA' } },
      ],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockBookService.findDuplicate).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'With Asin', authors: [{ name: 'Author' }], asin: 'B0TOPLEVEL' }));
    expect(mockBookService.findDuplicate).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'Meta Asin', authors: [{ name: 'Author' }], asin: 'B0METADATA' }));
  });

  it('forceImport item bypasses the dedup check entirely and still imports (#1662)', async () => {
    mockBookService.findDuplicate.mockResolvedValue({ verdict: 'same-recording', book: { id: 5, title: 'Owned' } });
    mockBookService.create.mockResolvedValueOnce({ id: 7, title: 'Owned', status: 'importing' });

    const result = await confirmImport(
      [{ path: '/a/b', title: 'Owned', authorName: 'Author', asin: 'B0OWNED', forceImport: true }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockBookService.findDuplicate).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: 1, heldReview: [] });
  });

  it('logs serialized error shape when bookService.create throws (#621)', async () => {
    mockBookService.create.mockRejectedValueOnce(new TypeError('DB constraint violated'));

    await confirmImport(
      [{ path: '/fail', title: 'FailBook' }],
      deps,
      undefined,
      nudgeWorker,
    );

    expect(deps.log.error).toHaveBeenCalledWith(
      {
        error: expect.objectContaining({
          message: 'DB constraint violated',
          type: 'TypeError',
          stack: expect.any(String),
        }),
        title: 'FailBook',
      },
      'Failed to create placeholder for import',
    );
  });

  it('creates multiple import_jobs rows for multiple items', async () => {
    mockBookService.create
      .mockResolvedValueOnce({ id: 1, title: 'Book1', status: 'importing' })
      .mockResolvedValueOnce({ id: 2, title: 'Book2', status: 'importing' });

    const result = await confirmImport(
      [
        { path: '/a', title: 'Book1' },
        { path: '/b', title: 'Book2' },
      ],
      deps,
      'move',
      nudgeWorker,
    );

    expect(result).toEqual({ accepted: 2, heldReview: [] });
    expect(mockBookImportService.enqueue).toHaveBeenCalledTimes(2);
    expect(nudgeWorker).toHaveBeenCalledTimes(1); // Nudge once, not per item
  });

  it('skips item from accepted when enqueue returns active-job-exists conflict', async () => {
    mockBookService.create
      .mockResolvedValueOnce({ id: 50, title: 'BookA', status: 'importing' })
      .mockResolvedValueOnce({ id: 51, title: 'BookB', status: 'importing' });
    mockBookImportService.enqueue
      .mockResolvedValueOnce({ jobId: 200 })
      .mockResolvedValueOnce({ error: 'active-job-exists', status: 409 });

    const result = await confirmImport(
      [
        { path: '/a', title: 'BookA' },
        { path: '/b', title: 'BookB' },
      ],
      deps,
      'copy',
      nudgeWorker,
    );

    // Only the non-conflict item is counted
    expect(result).toEqual({ accepted: 1, heldReview: [] });
    expect(mockBookImportService.enqueue).toHaveBeenCalledTimes(2);
    // Conflict surfaced as warn log including the title
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 51, title: 'BookB' }),
      expect.stringContaining('active job already exists'),
    );
    // Nudge still fires once because at least one item was accepted
    expect(nudgeWorker).toHaveBeenCalledTimes(1);
  });

  it('records book_added event for each accepted item', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'Test' }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      eventType: 'book_added',
      source: 'manual',
    }));
  });

  it('forwards narrators and seriesPosition through to bookService.create payload (#1028)', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{
        path: '/a',
        title: 'Test',
        authorName: 'Author',
        narrators: ['Jim Dale'],
        seriesPosition: 27,
        seriesName: 'Discworld',
      }],
      deps,
      'copy',
      nudgeWorker,
    );

    expect(mockBookService.create).toHaveBeenCalledWith(expect.objectContaining({
      narrators: ['Jim Dale'],
      seriesPosition: 27,
      seriesName: 'Discworld',
    }));
  });

  it('forwards seriesPosition: 0 through to bookService.create (regression guard) (#1028)', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{ path: '/a', title: 'Test', seriesName: 'Series', seriesPosition: 0 }],
      deps,
      'copy',
      nudgeWorker,
    );

    const callArgs = mockBookService.create.mock.calls[0]![0] as { seriesPosition: number | undefined };
    expect(callArgs.seriesPosition).toBe(0);
  });
});

describe('copyToLibrary — token precedence (#1028)', () => {
  // The same-path short-circuit lets us read the rendered targetPath without performing fs ops.
  function buildDeps(folderFormat: string): ImportPipelineDeps {
    const log = createMockLogger();
    return {
      db: inject<Db>({}),
      log,
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: '/library', folderFormat },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  it('meta.series[0] wins over item series fields (#1071 provider-truth precedence)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Item tags say `Mistborn #5`; provider match says `Wax and Wayne #1` — provider wins.
    const targetPath = '/library/Author/Wax and Wayne #1/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Mistborn', seriesPosition: 5 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('item.narrators wins over meta.narrators in {narrator} token', async () => {
    const deps = buildDeps('{narrator}/{title}');
    const targetPath = '/library/Jim Dale/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', narrators: ['Jim Dale'] },
      { title: 'Title', authors: [{ name: 'Author' }], narrators: ['Stephen Fry'] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('meta.series[0].position: 0 wins over item (#1071 falsy regression guard)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Provider says position 0 (prequel); item tags say 5; provider wins, position 0 preserved.
    const targetPath = '/library/Author/Prequels #0/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Prequels', seriesPosition: 5 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Prequels', position: 0 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('falls back to meta.series[0].position when item.seriesPosition is undefined', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    const targetPath = '/library/Author/Discworld #99/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Discworld' },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Discworld', position: 99 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('falls back to meta.narrators when item.narrators is empty', async () => {
    const deps = buildDeps('{narrator}/{title}');
    const targetPath = '/library/Stephen Fry/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author' },
      { title: 'Title', authors: [{ name: 'Author' }], narrators: ['Stephen Fry'] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  // #1097 F1 — copyToLibrary uses canonical seriesPrimary over series[0] for {series} / {seriesPosition} tokens
  it('uses meta.seriesPrimary for {series}/{seriesPosition} tokens when seriesPrimary differs from series[0] (#1097)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Pre-#1097 behavior would have used series[0] (Cosmere #5) and filed the book in the wrong folder.
    const targetPath = '/library/Author/The Stormlight Archive #2/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author' },
      {
        title: 'Title',
        authors: [{ name: 'Author' }],
        seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
        series: [
          { name: 'The Cosmere', position: 5 },
          { name: 'The Stormlight Archive', position: 2 },
        ],
      },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });
});

describe('copyToLibrary — populated-target staged swap (#1287)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  // Same-recording owner (#1711): the occupied target belongs to a book that is the
  // SAME recording as the candidate (shared ASIN), so the collision fence permits the
  // staged swap. Without an owner the fence would disambiguate/hold instead of replace.
  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1287-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('routes a populated target through the staged swap — replaces audio, no Frankenbook', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'b.mp3'), Buffer.alloc(300, 2));

    const result = await copyToLibrary(item(), null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    const files = (await readdir(target)).sort();
    // Old edition's audio gone; new audio present; non-audio cover preserved.
    expect(files).toEqual(['a.mp3', 'b.mp3', 'cover.jpg']);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('keeps the direct-copy fast path for an empty target — no staging siblings (AC3)', async () => {
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));

    await copyToLibrary(item(), null, 'copy', buildDeps());

    expect(await readdir(target)).toContain('a.mp3');
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('move mode over a populated target removes the source only after the verified swap', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await copyToLibrary(item(), null, 'move', buildDeps());

    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(source)).toBe(false);
  });

  it('AC5: routes a reconstructed disc group through the staged swap when the target is populated (F1)', async () => {
    // End-to-end through copyToLibrary: reconstructDiscGroup() resolves the coalesced
    // member set from disk, and the populated target must route through the staged swap —
    // not the direct merge-copy that would coexist the old .m4b with the new discs.
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    // Populated target: a stale single-file edition plus user cover art.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));

    // item.path is the lowest-disc member; reconstructDiscGroup expands it to both members.
    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    const result = await copyToLibrary(discItem, null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    const files = (await readdir(target)).sort();
    // Old edition's audio gone; both discs flattened (sequentially renamed) into the top level;
    // non-audio cover preserved. A regression to the direct merge-copy path would leave old.m4b.
    expect(files.filter((f) => f.endsWith('.m4b'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(files).toContain('cover.jpg');
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });
});

describe('copyToLibrary — interrupted-commit recovery before direct-copy (#1337)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
  const markerPath = (): string => `${target}.import-commit-pending`;
  const bakPath = (): string => `${target}.import-bak`;
  const tmpPath = (): string => `${target}.import-tmp`;

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  // Reproduce the post-kill state of a commit killed after the backup-out renames
  // but before the first move-in (#1290 window): an audio-EMPTY target, a populated
  // `.import-bak` holding the stranded originals, and the commit-pending marker armed.
  async function armInterruptedCommit(originals: Record<string, Buffer>): Promise<void> {
    await mkdir(target, { recursive: true }); // target exists but holds no audio
    await mkdir(bakPath(), { recursive: true });
    for (const [name, buf] of Object.entries(originals)) {
      await writeFile(join(bakPath(), name), buf);
    }
    await writeFile(markerPath(), '');
  }

  beforeEach(async () => {
    // Defensive passthrough reset — the #1291 suite mutates these module-level
    // fs wrappers and only restores them in its own beforeEach.
    fsMocks.rm.mockReset();
    fsMocks.cp.mockReset();
    fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
    fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));

    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1337-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsMocks.real.rm(baseDir, { recursive: true, force: true });
  });

  it('single-file: recovers the stranded originals before the manual import, then consumes the marker + backup', async () => {
    await armInterruptedCommit({ 'old.m4b': Buffer.alloc(500, 1) });
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'b.mp3'), Buffer.alloc(300, 2));

    const result = await copyToLibrary(item(), null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    // Recovery restored old.m4b → target was populated → the staged swap replaced
    // it with the manual import's audio. The stale edition is gone (no Frankenbook).
    expect((await readdir(target)).sort()).toEqual(['a.mp3', 'b.mp3']);
    // The armed marker + backup were CONSUMED by recovery, not orphaned (the bug):
    // an orphaned marker would fire bogus recovery on a later import.
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);
    expect(await pathExists(tmpPath())).toBe(false);
  });

  it('disc-group: recovers before the staged flatten, consuming the marker + backup', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    await armInterruptedCommit({ 'old.m4b': Buffer.alloc(500, 1) });

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    const result = await copyToLibrary(discItem, null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    const files = (await readdir(target)).sort();
    // Old single-file edition replaced; both discs flattened into the top level.
    expect(files.filter((f) => f.endsWith('.m4b'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);
    expect(await pathExists(tmpPath())).toBe(false);
  });

  it('a later import performs no bogus recovery — the marker was consumed (AC3)', async () => {
    await armInterruptedCommit({ 'old.m4b': Buffer.alloc(500, 1) });
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));
    await copyToLibrary(item(), null, 'copy', buildDeps());
    expect(await pathExists(markerPath())).toBe(false);

    // A second import to the now-populated, marker-less target routes through the
    // ordinary staged swap (no recovery). Its audio replaces the first import's, and
    // the long-gone stale original is NOT resurrected over the manually-imported files.
    const source2 = join(baseDir, 'downloads', 'release2');
    await mkdir(source2, { recursive: true });
    await writeFile(join(source2, 'c.mp3'), Buffer.alloc(400, 3));
    await copyToLibrary({ path: source2, title: 'Title', authorName: 'Author', asin: 'B0SAME' }, null, 'copy', buildDeps());

    const files = (await readdir(target)).sort();
    expect(files).toEqual(['c.mp3']);
    expect(files).not.toContain('old.m4b');
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);
  });

  it('marker-absent empty target keeps the direct-copy fast path — no recovery, no staging siblings (AC4)', async () => {
    // No marker, no `.import-bak`, empty target — the new pre-gate recovery is a no-op.
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));

    await copyToLibrary(item(), null, 'copy', buildDeps());

    expect(await readdir(target)).toContain('a.mp3');
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);
    expect(await pathExists(tmpPath())).toBe(false);
  });

  it('marker-absent stale .import-bak is strict-cleared, never restored, and the direct copy still runs (F1)', async () => {
    // A disposable post-success leftover backup with NO marker must not trigger
    // recovery: prepareImportSiblings strict-clears it and the fast path proceeds,
    // so its contents are never restored over the manual import.
    await mkdir(bakPath(), { recursive: true });
    await writeFile(join(bakPath(), 'stale.m4b'), Buffer.alloc(500, 9));
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));

    await copyToLibrary(item(), null, 'copy', buildDeps());

    const files = await readdir(target);
    expect(files).toContain('a.mp3');
    expect(files).not.toContain('stale.m4b');
    expect(await pathExists(bakPath())).toBe(false);
    expect(await pathExists(tmpPath())).toBe(false);
  });

  it('move mode: source removed after the recovered swap, and a later import does not resurrect the originals (AC5)', async () => {
    await armInterruptedCommit({ 'old.m4b': Buffer.alloc(500, 1) });
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await copyToLibrary(item(), null, 'move', buildDeps());

    // Recovery restored old.m4b → staged swap replaced it with new.mp3 → source removed.
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(source)).toBe(false);
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);

    // Later import to the same target: no marker, so no stale restore.
    const source2 = join(baseDir, 'downloads', 'release2');
    await mkdir(source2, { recursive: true });
    await writeFile(join(source2, 'final.mp3'), Buffer.alloc(600, 3));
    await copyToLibrary({ path: source2, title: 'Title', authorName: 'Author', asin: 'B0SAME' }, null, 'copy', buildDeps());

    const files = (await readdir(target)).sort();
    expect(files).toEqual(['final.mp3']);
    expect(files).not.toContain('old.m4b');
  });

  it('#1341: a DIRECTORY at the marker path aborts before recovery strict-clears an adjacent .import-bak', async () => {
    // A metadata-derived folder collides with the marker path: a DIRECTORY squats at
    // `${target}.import-commit-pending`. recoverInterruptedCommit's preflight must abort
    // (MarkerPathConflictError) BEFORE prepareImportSiblings reads the directory as
    // marker-absent and strict-clears the adjacent real `.import-bak`.
    const bakBytes = Buffer.from('REAL-BOOK-IN-BAK');
    const targetBytes = Buffer.from('TARGET-AUDIO');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.mp3'), targetBytes); // populated target
    await mkdir(markerPath(), { recursive: true });             // directory at the marker path
    await mkdir(bakPath(), { recursive: true });
    await writeFile(join(bakPath(), 'realbook.mp3'), bakBytes); // adjacent real book's audio
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(300, 2));

    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).rejects.toBeInstanceOf(MarkerPathConflictError);

    // The adjacent pre-existing `.import-bak` audio survives intact — not strict-cleared.
    expect(await readFile(join(bakPath(), 'realbook.mp3'))).toEqual(bakBytes);
    // Existing target audio is byte-unchanged, no `.import-tmp` was staged, and (copy mode)
    // the source is untouched — the abort happened before any destructive work.
    expect(await readFile(join(target, 'existing.mp3'))).toEqual(targetBytes);
    expect(await pathExists(tmpPath())).toBe(false);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(true);
  });
});

describe('copyToLibrary — post-swap source cleanup resilience (#1291)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
  const enoent = (): NodeJS.ErrnoException => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const eacces = (): NodeJS.ErrnoException => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  beforeEach(async () => {
    // Restore all wrappers to passthrough so each test starts from real fs behavior.
    fsMocks.rm.mockReset();
    fsMocks.cp.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
    fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));
    fsMocks.readdir.mockImplementation((...args: unknown[]) => fsMocks.real.readdir(...args));

    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1291-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsMocks.real.rm(baseDir, { recursive: true, force: true });
  });

  it('preserves a bundled foreign file in the source after a populated-target move (#1589)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'bundled.epub'), Buffer.from('EBOOK'));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    // New audio committed.
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    // Source audio removed, bundled e-book preserved, source folder retained.
    expect(await pathExists(join(source, 'new.mp3'))).toBe(false);
    expect(await pathExists(join(source, 'bundled.epub'))).toBe(true);
    expect(await pathExists(source)).toBe(true);
  });

  it('a vanished source is a no-op and the committed move still succeeds (#1589)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    // The managed-file cleanup tolerates a vanished source (stat ENOENT → no-op),
    // so an already-committed import never fails on cleanup.
    fsMocks.rm.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p).startsWith(source)) throw enoent();
      return fsMocks.real.rm(p, opts);
    });

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
  });

  it('preserves a bundled foreign file in a disc-member source on a multi-disc move (#1589)', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc1, 'liner-notes.pdf'), Buffer.from('PDF'));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    // Populated target routes the disc group through the staged swap.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    const files = (await readdir(target)).sort();
    // Both discs flattened into the target; old single-file edition replaced.
    expect(files.filter((f) => f.endsWith('.m4b'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    // Disc-1 audio removed but its bundled PDF preserved (folder retained); disc-2 fully removed.
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(false);
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
    expect(await pathExists(disc2)).toBe(false);
  });

  it('records a locked managed source file without failing the committed move (#1589)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    // A per-file EPERM during managed-file cleanup is now recorded + logged, NOT thrown —
    // a locked source file must not fail an already-committed import.
    fsMocks.rm.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p).endsWith('new.mp3')) throw eperm();
      return fsMocks.real.rm(p, opts);
    });

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    // Committed audio intact; the locked source file remains (rm rejected), source retained.
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(true);
  });

  it('a non-ENOENT cleanup error (readdir EACCES) does not fail the committed single-source move (#1591)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    // After the swap commits new audio (target now holds new.mp3), the source-cleanup readdir
    // rejects EACCES (a non-ENOENT error the helper does NOT swallow). The call-site try/catch
    // (#1591) must keep the already-committed import successful; pre-swap readdirs pass through.
    fsMocks.readdir.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p) === source && existsSync(join(target, 'new.mp3'))) throw eacces();
      return fsMocks.real.readdir(p, opts);
    });

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
  });

  it('a non-ENOENT cleanup error (readdir EACCES) does not fail the committed multi-disc move (#1591)', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

    // Post-commit, the disc-1 source cleanup readdir rejects EACCES. Per-member try/catch (#1591)
    // keeps the committed import successful and does not skip the remaining disc. The flatten renames
    // members to sequential stems, so we can't key the post-swap window on a member filename in the
    // target; instead key on the staged swap having replaced the target's `old.m4b` audio. Pre-swap
    // reads of disc1 (size probe + copyDiscGroup staging) still see `old.m4b` and pass through.
    fsMocks.readdir.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p) === disc1 && !existsSync(join(target, 'old.m4b'))) throw eacces();
      return fsMocks.real.readdir(p, opts);
    });

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    expect((await readdir(target)).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    // F1: prove per-member continuation — disc-1 cleanup threw (its readdir EACCES'd, so d1.mp3
    // survives), but the loop still reached disc 2 and swept it (d2.mp3 removed, empty folder gone).
    // A single catch around the whole loop would skip disc 2, leaving it on disk — this assertion
    // is what distinguishes per-member try/catch from loop-level.
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(true);
    expect(await pathExists(join(disc2, 'd2.mp3'))).toBe(false);
    expect(await pathExists(disc2)).toBe(false);
  });

  it('still fails the import when copy verification falls below threshold (verification path untouched)', async () => {
    // Empty target keeps the direct-copy fast path. A no-op copy leaves the
    // target undersized so the inline verification throws — proving the
    // force: true change did not leak into the pre-commit verification path.
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(1000, 2));
    fsMocks.cp.mockImplementation(async () => {});

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).rejects.toThrow(/Copy verification failed/);
    // The single-source path now throws the typed ContentFailureError (#1304).
    await expect(copyToLibrary(item(), null, 'move', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
    // The throw precedes cleanup — the source is left intact, never removed.
    expect(await pathExists(source)).toBe(true);
    expect(fsMocks.rm).not.toHaveBeenCalledWith(source, expect.anything());
  });

  it('throws a typed ContentFailureError when the multi-disc copy falls below threshold (#1304)', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    // Empty target keeps the direct copyDiscGroup path; a no-op cp undersizes the
    // target so the shared verification helper throws ContentFailureError.
    fsMocks.cp.mockImplementation(async () => {});

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
  });

  it('throws a typed ContentFailureError when the staged-swap copy falls below threshold (#1304)', async () => {
    // Populated target routes through stagedAudioReplace; a no-op cp leaves the
    // staged audio undersized so the shared verification helper throws.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    fsMocks.cp.mockImplementation(async () => {});

    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
  });

  it('throws a typed ContentFailureError on the multi-disc populated-target replace branch (#1346, helpers.ts:168-180)', async () => {
    // Multi-disc group + already-populated target routes through the staged-swap branch
    // (copyDiscGroupToLibrary's getTargetAudioSize > 0 guard). A no-op cp undersizes the
    // staged audio so the shared verification throws the typed error — pin it by type, not
    // by the 'Copy verification failed' message text.
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    fsMocks.cp.mockImplementation(async () => {});

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
  });
});

describe('copyToLibrary — empty-target move cleanup (#1598)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  beforeEach(async () => {
    // Restore the module-level fs wrappers to passthrough (the #1287/#1337 suites mutate them).
    fsMocks.rm.mockReset();
    fsMocks.cp.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
    fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));
    fsMocks.readdir.mockImplementation((...args: unknown[]) => fsMocks.real.readdir(...args));

    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1598-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsMocks.real.rm(baseDir, { recursive: true, force: true });
  });

  // Gap 2 — the empty-target move now routes source cleanup through the managed-file helper instead
  // of a blanket `rm`, so a co-located foreign file survives (the original #1589 scenario, in the
  // one move branch it never covered).
  it('preserves a co-located foreign file on an empty-target single-source move', async () => {
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'bundled.epub'), Buffer.from('EBOOK'));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    // Empty target → audio-only fast path (#1602): the target holds the audio but NOT the foreign
    // file (the whole-tree verbatim copy is gone — both import paths now stage audio only).
    expect(await pathExists(join(target, 'new.mp3'))).toBe(true);
    expect(await pathExists(join(target, 'bundled.epub'))).toBe(false);
    // Source CLEANUP (#1598) still preserves the foreign file — audio removed, e-book kept, folder
    // retained — and with #1602 it is no longer DUPLICATED into the library.
    expect(await pathExists(join(source, 'new.mp3'))).toBe(false);
    expect(await pathExists(join(source, 'bundled.epub'))).toBe(true);
    expect(await pathExists(source)).toBe(true);
  });

  it('removes the source folder on an empty-target single-source move when only managed files exist', async () => {
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(500, 2));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect((await readdir(target)).sort()).toEqual(['a.mp3']);
    // Only managed files existed → the emptied source folder is removed.
    expect(await pathExists(source)).toBe(false);
  });

  it('preserves a co-located foreign file in a disc member on an empty-target multi-disc move', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc1, 'liner-notes.pdf'), Buffer.from('PDF'));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    // Empty target → direct disc-group flatten; both discs flattened into the target.
    expect((await readdir(target)).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    // Disc-1 audio removed but its bundled PDF preserved (folder retained); disc-2 fully removed.
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(false);
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
    expect(await pathExists(disc2)).toBe(false);
  });

  // Gap 1 — a top-level symlinked source on a populated-target (staged-swap) move: the import reads
  // through the link to stage the audio, but the post-commit cleanup must NOT follow the link and
  // delete the managed audio under its target (the #1591 delete-through-symlink class, in the
  // unguarded cleanup path #1591 didn't cover).
  it('does not delete through a top-level symlinked source during populated-target move cleanup', async () => {
    const external = mkdtempSync(join(tmpdir(), 'narratorr-1598-ext-'));
    try {
      await writeFile(join(external, 'new.mp3'), Buffer.alloc(500, 2));
      await writeFile(join(external, 'bundled.epub'), Buffer.from('EBOOK'));
      // item.path is a directory symlink/junction to the external source.
      const linkedSource = join(baseDir, 'downloads', 'linked-release');
      await symlink(external, linkedSource, process.platform === 'win32' ? 'junction' : 'dir');
      // Populated target routes through the staged swap.
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

      const linkedItem: ImportConfirmItem = { path: linkedSource, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
      await expect(copyToLibrary(linkedItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

      // New audio committed over the old edition.
      expect((await readdir(target)).sort()).toEqual(['new.mp3']);
      // The symlink target's files — managed AND foreign — survive: cleanup never followed the link.
      expect(await pathExists(join(external, 'new.mp3'))).toBe(true);
      expect(await pathExists(join(external, 'bundled.epub'))).toBe(true);
    } finally {
      await fsMocks.real.rm(external, { recursive: true, force: true });
    }
  });
});

// #1602: the empty-target fast path now imports AUDIO ONLY via the same `stageSourceAudio` copier the
// populated-target staged swap uses, so a co-located foreign file (ebook/PDF/NFO) no longer lands in
// the library — and the directory-vs-file branching keeps single-audio-file imports working while
// rejecting a single non-audio file. Real-tmpdir filesystem behavior, mirroring the #1598 suite.
describe('copyToLibrary — empty-target audio-only copy (#1602)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  beforeEach(async () => {
    // Restore the module-level fs wrappers to passthrough (other suites mutate them).
    fsMocks.rm.mockReset();
    fsMocks.cp.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
    fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));
    fsMocks.readdir.mockImplementation((...args: unknown[]) => fsMocks.real.readdir(...args));

    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1602-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsMocks.real.rm(baseDir, { recursive: true, force: true });
  });

  it('directory source, COPY, no progress: copies audio only — the co-located .epub is excluded from the library', async () => {
    await writeFile(join(source, 'book.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'book.epub'), Buffer.from('EBOOK'));

    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'book.mp3'))).toBe(true);
    expect(await pathExists(join(target, 'book.epub'))).toBe(false);
    // copy mode leaves the source intact, foreign file included.
    expect(await pathExists(join(source, 'book.epub'))).toBe(true);
  });

  it('directory source, COPY, with onProgress: audio only in target, foreign excluded, progress reported', async () => {
    await writeFile(join(source, 'book.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'info.nfo'), Buffer.from('NFO'));

    const progress: Array<{ current: number; total: number }> = [];
    const onProgress = (_p: number, byteCounter: { current: number; total: number }): void => {
      progress.push(byteCounter);
    };

    await expect(copyToLibrary(item(), null, 'copy', buildDeps(), onProgress)).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'book.mp3'))).toBe(true);
    expect(await pathExists(join(target, 'info.nfo'))).toBe(false);
    // Distinct (streaming) code path from the no-progress branch — assert it actually reported bytes.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({ current: 500, total: 500 });
  });

  it('disc-group source, COPY: a foreign file co-located in a disc member is excluded from the library', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc1, 'liner-notes.pdf'), Buffer.from('PDF'));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'copy', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    const targetEntries = await readdir(target);
    expect(targetEntries.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(targetEntries.some((f) => f.endsWith('.pdf'))).toBe(false);
    // copy mode leaves the disc member's bundled PDF in place.
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
  });

  it('foreign-only directory source (zero audio): nothing is copied — the target is created but empty', async () => {
    await writeFile(join(source, 'cover.jpg'), Buffer.from('IMG'));
    await writeFile(join(source, 'readme.txt'), Buffer.from('TXT'));

    // The manual-import fast path does not run validateSource/containsAudioFiles, so a zero-audio
    // source reaches the copier; copyAudioFiles writes nothing and assertCopyVerified(0, 0) passes.
    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(target)).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it('single audio-file source, COPY, no progress: the file lands in the library target', async () => {
    const file = join(baseDir, 'downloads', 'Doctor Sleep.m4b');
    await writeFile(file, Buffer.alloc(500, 2));
    const fileItem: ImportConfirmItem = { path: file, title: 'Title', authorName: 'Author' };

    await expect(copyToLibrary(fileItem, null, 'copy', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'Doctor Sleep.m4b'))).toBe(true);
  });

  it('single audio-file source, COPY, with onProgress: file lands in the library and progress is reported', async () => {
    const file = join(baseDir, 'downloads', 'Doctor Sleep.m4b');
    await writeFile(file, Buffer.alloc(500, 2));
    const fileItem: ImportConfirmItem = { path: file, title: 'Title', authorName: 'Author' };

    const progress: Array<{ current: number; total: number }> = [];
    const onProgress = (_p: number, byteCounter: { current: number; total: number }): void => {
      progress.push(byteCounter);
    };

    await expect(copyToLibrary(fileItem, null, 'copy', buildDeps(), onProgress)).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'Doctor Sleep.m4b'))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({ current: 500, total: 500 });
  });

  it('single audio-file source, MOVE: file lands in the library and the source file is removed', async () => {
    const file = join(baseDir, 'downloads', 'Doctor Sleep.m4b');
    await writeFile(file, Buffer.alloc(500, 2));
    const fileItem: ImportConfirmItem = { path: file, title: 'Title', authorName: 'Author' };

    await expect(copyToLibrary(fileItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'Doctor Sleep.m4b'))).toBe(true);
    // Move cleanup removes the (managed) audio source file.
    expect(await pathExists(file)).toBe(false);
  });

  it('single non-audio file source: rejected with ContentFailureError, no foreign file written to the library', async () => {
    const file = join(baseDir, 'downloads', 'notes.pdf');
    await writeFile(file, Buffer.from('PDF'));
    const fileItem: ImportConfirmItem = { path: file, title: 'Title', authorName: 'Author' };

    await expect(copyToLibrary(fileItem, null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);

    // stageSourceAudio mkdir's the target before extension-checking, so the dir may exist — the
    // invariant is that the foreign file was NOT copied in (F4).
    expect(await pathExists(join(target, 'notes.pdf'))).toBe(false);
    if (await pathExists(target)) {
      expect(await readdir(target)).toEqual([]);
    }
  });
});

// The nonfatal source-cleanup blocks were consolidated into one shared helper
// (`cleanupSourceManagedFilesNonfatal`, #1605). The helper's whole point is to preserve each call
// site's distinct, observable log behavior via its `context` — single-source success at `info`,
// disc success at `debug`, and the two site-specific warn-on-failure messages — so these pin those
// strings/levels directly (the behavior-preservation contract the consolidation must not break).
describe('copyToLibrary — consolidated nonfatal source-cleanup log contract (#1605)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;
  let log: FastifyBaseLogger;

  const eacces = (): NodeJS.ErrnoException => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log,
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue([{ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: 'B0SAME', duration: null }]) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const item = (): ImportConfirmItem => ({ path: source, title: 'Title', authorName: 'Author', asin: 'B0SAME' });

  beforeEach(async () => {
    fsMocks.rm.mockReset();
    fsMocks.cp.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.rm.mockImplementation((...args: unknown[]) => fsMocks.real.rm(...args));
    fsMocks.cp.mockImplementation((...args: unknown[]) => fsMocks.real.cp(...args));
    fsMocks.readdir.mockImplementation((...args: unknown[]) => fsMocks.real.readdir(...args));

    log = createMockLogger();
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1605-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsMocks.real.rm(baseDir, { recursive: true, force: true });
  });

  it('single-source success logs at `info` with the single-source message', async () => {
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ source, deleted: expect.any(Number), preservedForeign: expect.any(Number) }),
      'Source managed files removed after move (foreign files preserved)',
    );
  });

  it('single-source cleanup failure logs the single-source warn message and does not fail the import', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    // Post-commit (after the staged swap puts new.mp3 in the target), the source-cleanup readdir
    // rejects EACCES — a non-ENOENT error the deletion helper does NOT swallow, so it throws into
    // the consolidated helper's catch. Pre-swap reads pass through.
    fsMocks.readdir.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p) === source && existsSync(join(target, 'new.mp3'))) throw eacces();
      return fsMocks.real.readdir(p, opts);
    });

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source, error: expect.anything() }),
      'Failed to clean source after committed move — import already succeeded, continuing',
    );
  });

  it('disc-member success logs at `debug` with the disc-source message', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ source: disc1, deleted: expect.any(Number), preservedForeign: expect.any(Number) }),
      'Disc source managed files removed after move',
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ source: disc2 }),
      'Disc source managed files removed after move',
    );
  });

  it('disc-member cleanup failure logs the disc-source warn message per member without failing the import', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

    // Post-commit (old.m4b replaced), disc-1 cleanup readdir EACCES'es; disc 2 still sweeps.
    fsMocks.readdir.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p) === disc1 && !existsSync(join(target, 'old.m4b'))) throw eacces();
      return fsMocks.real.readdir(p, opts);
    });

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: disc1, error: expect.anything() }),
      'Failed to clean disc source after committed move — import already succeeded, continuing',
    );
  });
});


