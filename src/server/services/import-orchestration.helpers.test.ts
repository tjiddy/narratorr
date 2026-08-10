import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { copyToLibrary, type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { ContentFailureError } from '../utils/import-helpers.js';
import { MarkerPathConflictError } from '../utils/import-staging.js';
import { mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations } from '@db/index.js';
import type { ImportConfirmItem } from './library-scan.service.js';

// Stored paths are POSIX-normalized; tmpdir paths are native, so Windows expectations need folding.
const toPosix = (p: string): string => p.split('\\').join('/');

vi.mock('./enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('./enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('./library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

// Hoisted passthrough wrappers let tests inject cleanup failures and undersized copies.
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


describe('copyToLibrary — token precedence (#1028)', () => {
  // Same-path short-circuit exposes rendered targetPath without filesystem work.
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

  it('item series fields win over meta.series[0] in the folder path (#1927 AC2 item-first)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    const targetPath = '/library/Author/The Dresden Files #10/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'The Dresden Files', seriesPosition: 10 },
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

  it('item series with NO position → folder path uses item series, metadata position NOT grafted (#1927 AC3 pair-lock)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Empty item position must not borrow metadata position 15; the renderer leaves a bare #.
    const targetPath = '/library/Author/Custom Saga #/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: 'Custom Saga' },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Provider Saga', position: 15 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
    expect(path.targetPath).not.toContain('#15');
    expect(path.targetPath).not.toContain('Provider Saga');
  });

  it('item OMITS series → folder path defers to meta.series[0], position 0 preserved (#1927 AC3 defer path)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    const targetPath = '/library/Author/Prequels #0/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author' },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Prequels', position: 0 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('item seriesName "   " (whitespace) → folder path defers to metadata (#1927 AC5 non-React-caller guard)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    const targetPath = '/library/Author/Wax and Wayne #1/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: '   ', seriesPosition: 99 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Wax and Wayne', position: 1 }] },
      'copy',
      deps,
    );
    expect(path.targetPath).toBe(targetPath);
  });

  it('padded item series " Saga " wins over a DIFFERENT metadata primary; renderer sanitizes to "Saga" (#1927 AC5/F12)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
    // Distinct metadata makes sanitized `Saga #3` prove item-first selection.
    const targetPath = '/library/Author/Saga #3/Title';
    const path = await copyToLibrary(
      { path: targetPath, title: 'Title', authorName: 'Author', seriesName: ' Saga ', seriesPosition: 3 },
      { title: 'Title', authors: [{ name: 'Author' }], series: [{ name: 'Other', position: 2 }] },
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

  it('uses meta.seriesPrimary for {series}/{seriesPosition} tokens when seriesPrimary differs from series[0] (#1097)', async () => {
    const deps = buildDeps('{author}/{series} #{seriesPosition}/{title}');
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

  // Shared-ASIN owner makes the collision fence permit replacement instead of disambiguation (#1711).
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
    // Populated reconstructed groups must stage-swap; direct merge-copy would retain old audio.
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));

    // Lowest-disc path must expand to the complete group.
    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    const result = await copyToLibrary(discItem, null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    const files = (await readdir(target)).sort();
    expect(files.filter((f) => f.endsWith('.m4b'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(files).toContain('cover.jpg');
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });
});

// Same-narrator, different known production forms without duration corroboration must hold at the copy fence (#1728).
describe('copyToLibrary — production-type veto on occupied target (#1728)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  // No ASIN or duration leaves production type as the deciding signal.
  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({
        findPathOwners: vi.fn().mockResolvedValue([
          { id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [{ name: 'Jim Dale' }], asin: null, duration: null, productionType: 'abridged' },
        ]),
      }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1728-orch-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('holds an abridged-vs-unabridged occupied target for review instead of staged-swapping it', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));

    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Jim Dale'] };
    const meta = { title: 'Title', authors: [{ name: 'Author' }], narrators: ['Jim Dale'], formatType: 'Unabridged' };

    await expect(copyToLibrary(item, meta, 'copy', buildDeps())).rejects.toMatchObject({
      code: 'OWNED_RECORDING',
      reason: 'recording-review',
    });
    expect((await readdir(target)).filter((f) => f.endsWith('.m4b'))).toEqual(['old.m4b']);
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

  // Post-kill #1290 window: empty target, stranded originals in .import-bak, marker armed.
  async function armInterruptedCommit(originals: Record<string, Buffer>): Promise<void> {
    await mkdir(target, { recursive: true });
    await mkdir(bakPath(), { recursive: true });
    for (const [name, buf] of Object.entries(originals)) {
      await writeFile(join(bakPath(), name), buf);
    }
    await writeFile(markerPath(), '');
  }

  beforeEach(async () => {
    // Another suite mutates these module-level wrappers.
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
    expect((await readdir(target)).sort()).toEqual(['a.mp3', 'b.mp3']);
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
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(300, 2));

    await copyToLibrary(item(), null, 'copy', buildDeps());

    expect(await readdir(target)).toContain('a.mp3');
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);
    expect(await pathExists(tmpPath())).toBe(false);
  });

  it('marker-absent stale .import-bak is strict-cleared, never restored, and the direct copy still runs (F1)', async () => {
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

    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(source)).toBe(false);
    expect(await pathExists(markerPath())).toBe(false);
    expect(await pathExists(bakPath())).toBe(false);

    const source2 = join(baseDir, 'downloads', 'release2');
    await mkdir(source2, { recursive: true });
    await writeFile(join(source2, 'final.mp3'), Buffer.alloc(600, 3));
    await copyToLibrary({ path: source2, title: 'Title', authorName: 'Author', asin: 'B0SAME' }, null, 'copy', buildDeps());

    const files = (await readdir(target)).sort();
    expect(files).toEqual(['final.mp3']);
    expect(files).not.toContain('old.m4b');
  });

  it('#1341: a DIRECTORY at the marker path aborts before recovery strict-clears an adjacent .import-bak', async () => {
    // A directory at the marker path must abort recovery before adjacent .import-bak cleanup.
    const bakBytes = Buffer.from('REAL-BOOK-IN-BAK');
    const targetBytes = Buffer.from('TARGET-AUDIO');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.mp3'), targetBytes);
    await mkdir(markerPath(), { recursive: true });
    await mkdir(bakPath(), { recursive: true });
    await writeFile(join(bakPath(), 'realbook.mp3'), bakBytes);
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(300, 2));

    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).rejects.toBeInstanceOf(MarkerPathConflictError);

    expect(await readFile(join(bakPath(), 'realbook.mp3'))).toEqual(bakBytes);
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
    // Restore module-level wrappers mutated by other suites.
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
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(false);
    expect(await pathExists(join(source, 'bundled.epub'))).toBe(true);
    expect(await pathExists(source)).toBe(true);
  });

  it('preserves a bundled .epub in the source after an EMPTY-target move (#1960 AC32)', async () => {
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'companion.epub'), Buffer.from('EBOOK'));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(false);
    expect(await pathExists(join(source, 'companion.epub'))).toBe(true);
    expect(await pathExists(source)).toBe(true);
  });

  it('a vanished source is a no-op and the committed move still succeeds (#1589)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

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
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    const files = (await readdir(target)).sort();
    expect(files.filter((f) => f.endsWith('.m4b'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(false);
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
    expect(await pathExists(disc2)).toBe(false);
  });

  it('records a locked managed source file without failing the committed move (#1589)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    fsMocks.rm.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p).endsWith('new.mp3')) throw eperm();
      return fsMocks.real.rm(p, opts);
    });

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(true);
  });

  it('a non-ENOENT cleanup error (readdir EACCES) does not fail the committed single-source move (#1591)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    // Fail only post-swap cleanup; pre-swap readdirs pass through.
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

    // Flattened names cannot gate post-swap cleanup; old.m4b disappearance triggers EACCES after staging reads.
    fsMocks.readdir.mockImplementation(async (p: unknown, opts: unknown) => {
      if (String(p) === disc1 && !existsSync(join(target, 'old.m4b'))) throw eacces();
      return fsMocks.real.readdir(p, opts);
    });

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });
    expect((await readdir(target)).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    // Disc 2 removal distinguishes per-member continuation from one catch around the loop.
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(true);
    expect(await pathExists(join(disc2, 'd2.mp3'))).toBe(false);
    expect(await pathExists(disc2)).toBe(false);
  });

  it('still fails the import when copy verification falls below threshold (verification path untouched)', async () => {
    // No-op copy leaves the empty-target fast path undersized, isolating pre-commit verification.
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(1000, 2));
    fsMocks.cp.mockImplementation(async () => {});

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).rejects.toThrow(/Copy verification failed/);
    await expect(copyToLibrary(item(), null, 'move', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
    // Verification failure precedes source cleanup.
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
    fsMocks.cp.mockImplementation(async () => {});

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
    await expect(copyToLibrary(discItem, null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
  });

  it('throws a typed ContentFailureError when the staged-swap copy falls below threshold (#1304)', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    fsMocks.cp.mockImplementation(async () => {});

    await expect(copyToLibrary(item(), null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);
  });

  it('throws a typed ContentFailureError on the multi-disc populated-target replace branch (#1346, helpers.ts:168-180)', async () => {
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
    // Restore module-level wrappers mutated by other suites.
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

  it('preserves a co-located foreign file on an empty-target single-source move', async () => {
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    await writeFile(join(source, 'bundled.epub'), Buffer.from('EBOOK'));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect(await pathExists(join(target, 'new.mp3'))).toBe(true);
    expect(await pathExists(join(target, 'bundled.epub'))).toBe(false);
    expect(await pathExists(join(source, 'new.mp3'))).toBe(false);
    expect(await pathExists(join(source, 'bundled.epub'))).toBe(true);
    expect(await pathExists(source)).toBe(true);
  });

  it('removes the source folder on an empty-target single-source move when only managed files exist', async () => {
    await writeFile(join(source, 'a.mp3'), Buffer.alloc(500, 2));

    await expect(copyToLibrary(item(), null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

    expect((await readdir(target)).sort()).toEqual(['a.mp3']);
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

    expect((await readdir(target)).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(join(disc1, 'd1.mp3'))).toBe(false);
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
    expect(await pathExists(disc2)).toBe(false);
  });

  // Staging may read through a top-level source symlink; cleanup must never follow it while deleting (#1591).
  it('does not delete through a top-level symlinked source during populated-target move cleanup', async () => {
    const external = mkdtempSync(join(tmpdir(), 'narratorr-1598-ext-'));
    try {
      await writeFile(join(external, 'new.mp3'), Buffer.alloc(500, 2));
      await writeFile(join(external, 'bundled.epub'), Buffer.from('EBOOK'));
      const linkedSource = join(baseDir, 'downloads', 'linked-release');
      await symlink(external, linkedSource, process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));

      const linkedItem: ImportConfirmItem = { path: linkedSource, title: 'Title', authorName: 'Author', asin: 'B0SAME' };
      await expect(copyToLibrary(linkedItem, null, 'move', buildDeps())).resolves.toMatchObject({ targetPath: toPosix(target) });

      expect((await readdir(target)).sort()).toEqual(['new.mp3']);
      expect(await pathExists(join(external, 'new.mp3'))).toBe(true);
      expect(await pathExists(join(external, 'bundled.epub'))).toBe(true);
    } finally {
      await fsMocks.real.rm(external, { recursive: true, force: true });
    }
  });
});

// Empty-target imports share stageSourceAudio and must preserve file-vs-directory behavior (#1602).
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
    // Restore module-level wrappers mutated by other suites.
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
    // Progress callback selects the distinct streaming copy path.
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
    expect(await pathExists(join(disc1, 'liner-notes.pdf'))).toBe(true);
  });

  it('foreign-only directory source (zero audio): nothing is copied — the target is created but empty', async () => {
    await writeFile(join(source, 'cover.jpg'), Buffer.from('IMG'));
    await writeFile(join(source, 'readme.txt'), Buffer.from('TXT'));

    // Manual import skips source validation, so zero audio reaches the copier and verifies as 0/0.
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
    expect(await pathExists(file)).toBe(false);
  });

  it('single non-audio file source: rejected with ContentFailureError, no foreign file written to the library', async () => {
    const file = join(baseDir, 'downloads', 'notes.pdf');
    await writeFile(file, Buffer.from('PDF'));
    const fileItem: ImportConfirmItem = { path: file, title: 'Title', authorName: 'Author' };

    await expect(copyToLibrary(fileItem, null, 'copy', buildDeps())).rejects.toBeInstanceOf(ContentFailureError);

    // Target may exist because stageSourceAudio creates it before extension validation.
    expect(await pathExists(join(target, 'notes.pdf'))).toBe(false);
    if (await pathExists(target)) {
      expect(await readdir(target)).toEqual([]);
    }
  });
});

// Consolidated cleanup preserves call-site log levels/messages: single info, disc debug, and site-specific warns (#1605).
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

    // Gate EACCES on new.mp3 so only post-commit cleanup fails.
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

    // Gate EACCES on old.m4b replacement so only post-commit disc-1 cleanup fails.
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



describe('copyToLibrary — cross-row collision fence (#1711)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  function buildDeps(owners: unknown[]): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: vi.fn().mockResolvedValue(owners) }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  const owner = (overrides: Record<string, unknown> = {}): unknown =>
    ({ id: 1, title: 'Title', authors: [{ name: 'Author' }], narrators: [], asin: null, duration: null, ...overrides });

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1711-fence-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'incumbent.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('different recording (1 owner) → copies into a disambiguated (edition) folder, incumbent untouched (keep-both)', async () => {
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'] };
    const result = await copyToLibrary(item, null, 'copy', buildDeps([owner({ narrators: [{ name: 'Jim Dale' }] })]));

    expect(result.editionLabel).toBe('Stephen Fry');
    expect(result.targetPath).toBe(toPosix(join(libraryRoot, 'Author', 'Title (Stephen Fry)')));
    expect(await pathExists(join(target, 'incumbent.m4b'))).toBe(true);
    expect(await readdir(result.targetPath)).toContain('new.mp3');
  });

  it('review verdict (1 owner, no narrator signal) → throws OwnedRecordingError, never overwrites', async () => {
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author' };
    await expect(copyToLibrary(item, null, 'copy', buildDeps([owner()]))).rejects.toMatchObject({ name: 'OwnedRecordingError' });
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
  });

  it('full-cast candidate over a solo-narrator owner → disambiguates into an edition folder (#2206)', async () => {
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry', 'Full Cast'] };
    const result = await copyToLibrary(item, null, 'copy', buildDeps([owner({ narrators: [{ name: 'Jim Dale' }] })]));

    const disambig = join(libraryRoot, 'Author', 'Title (Stephen Fry)');
    expect(result.editionLabel).toBe('Stephen Fry');
    expect(result.targetPath).toBe(toPosix(disambig));
    expect(await readdir(disambig)).toContain('new.mp3');
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('all-placeholder candidate over that same owner is unchanged → recording-review, never disambiguated (#2206)', async () => {
    // Empty survivor set on the candidate side: undecidable under both the old and the narrowed guard.
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Full Cast'] };
    await expect(
      copyToLibrary(item, null, 'copy', buildDeps([owner({ narrators: [{ name: 'Jim Dale' }] })])),
    ).rejects.toMatchObject({ name: 'OwnedRecordingError', reason: 'recording-review' });
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
    expect(await readdir(join(libraryRoot, 'Author'))).toEqual(['Title']);
  });

  it('zero owners (orphan folder with audio) → disambiguates into a new folder, orphan untouched', async () => {
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'] };
    const result = await copyToLibrary(item, null, 'copy', buildDeps([]));

    expect(result.editionLabel).toBe('Stephen Fry');
    expect(result.targetPath).toBe(toPosix(join(libraryRoot, 'Author', 'Title (Stephen Fry)')));
    expect(await pathExists(join(target, 'incumbent.m4b'))).toBe(true);
  });

  it('two owners (data anomaly) → throws OwnedRecordingError, never overwrites', async () => {
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'] };
    await expect(
      copyToLibrary(item, null, 'copy', buildDeps([owner({ id: 1 }), owner({ id: 2, title: 'Other' })])),
    ).rejects.toMatchObject({ name: 'OwnedRecordingError' });
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
  });

  it('different recording whose label sanitizes to null (e.g. ":::") → held for review, not base-collapsed (#1739, F5)', async () => {
    // Raw ":::" is truthy but sanitizes to null; the guard must evaluate the sanitized discriminator.
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: [':::'] };
    await expect(
      copyToLibrary(item, null, 'copy', buildDeps([owner({ narrators: [{ name: 'Jim Dale' }] })])),
    ).rejects.toMatchObject({ name: 'OwnedRecordingError', reason: 'recording-review-no-disambiguator' });
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
    expect((await readdir(join(libraryRoot, 'Author'))).some((n) => n.includes(':'))).toBe(false);
  });

  // First owner lookup chooses disambiguation; the second decides whether an occupied edition swaps or holds (#1737).
  function buildDepsSeq(fpo: ReturnType<typeof vi.fn>): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService: inject<BookService>({ findPathOwners: fpo }),
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  it('disambiguated folder occupied by the SAME recording → staged swap into the (edition) folder (re-check, #1737)', async () => {
    const disambig = join(libraryRoot, 'Author', 'Title (Stephen Fry)');
    await mkdir(disambig, { recursive: true });
    await writeFile(join(disambig, 'old.m4b'), Buffer.alloc(500, 9));

    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'], asin: 'B0FRY' };
    // Base owner differs; edition-folder owner shares ASIN.
    const fpo = vi.fn()
      .mockResolvedValueOnce([owner({ narrators: [{ name: 'Jim Dale' }], asin: 'B0JIM' })])
      .mockResolvedValueOnce([owner({ id: 2, narrators: [{ name: 'Stephen Fry' }], asin: 'B0FRY' })]);

    const result = await copyToLibrary(item, null, 'copy', buildDepsSeq(fpo));

    expect(result.targetPath).toBe(toPosix(disambig));
    expect((await readdir(disambig)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(target, 'incumbent.m4b'))).toBe(true);
    expect(fpo).toHaveBeenCalledTimes(2);
  });

  it('disambiguated folder occupied by a DIFFERENT recording → throws recording-review-disambiguated-collision (re-check, #1737)', async () => {
    const disambig = join(libraryRoot, 'Author', 'Title (Stephen Fry)');
    await mkdir(disambig, { recursive: true });
    await writeFile(join(disambig, 'other.m4b'), Buffer.alloc(500, 9));

    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'], asin: 'B0FRY' };
    // Call 1 base and call 2 disambiguated are both different recordings.
    const fpo = vi.fn()
      .mockResolvedValueOnce([owner({ narrators: [{ name: 'Jim Dale' }], asin: 'B0JIM' })])
      .mockResolvedValueOnce([owner({ id: 3, narrators: [{ name: 'Andrew Smith' }], asin: 'B0OTHER' })]);

    await expect(copyToLibrary(item, null, 'copy', buildDepsSeq(fpo)))
      .rejects.toMatchObject({ name: 'OwnedRecordingError', reason: 'recording-review-disambiguated-collision' });
    expect((await readdir(target)).sort()).toEqual(['incumbent.m4b']);
    expect((await readdir(disambig)).sort()).toEqual(['other.m4b']);
    expect(fpo).toHaveBeenCalledTimes(2);
  });

  it('disc-group: different recording on an occupied target disambiguates into an (edition) folder, never overwriting (#1737)', async () => {
    const downloads = join(baseDir, 'downloads');
    const disc1 = join(downloads, 'Author - Book Disc 1 of 2');
    const disc2 = join(downloads, 'Author - Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));

    const discItem: ImportConfirmItem = { path: disc1, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'] };
    const result = await copyToLibrary(discItem, null, 'copy', buildDeps([owner({ narrators: [{ name: 'Jim Dale' }] })]));

    const disambig = join(libraryRoot, 'Author', 'Title (Stephen Fry)');
    expect(result.editionLabel).toBe('Stephen Fry');
    expect(result.targetPath).toBe(toPosix(disambig));
    expect((await readdir(disambig)).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(join(target, 'incumbent.m4b'))).toBe(true);
  });
});

// Real BookService exercises eq(books.path, ...) through the fence; mocks elsewhere miss POSIX folding of Windows-resolved keys (#1752).
describe('copyToLibrary — non-mocked findPathOwners through the fence (real DB, #1737/#1752)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let source: string;
  let target: string;
  let dbDir: string;
  let db: Db;
  let bookService: BookService;

  const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  function buildDeps(): ImportPipelineDeps {
    return {
      db: inject<Db>({}),
      log: createMockLogger(),
      bookService,
      bookImportService: inject<BookImportService>({}),
      settingsService: inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}' },
      })),
      eventHistory: inject<EventHistoryService>({ create: vi.fn() }),
      enrichmentDeps: {} as EnrichmentDeps,
    };
  }

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-1737-realdb-'));
    libraryRoot = join(baseDir, 'library');
    source = join(baseDir, 'downloads', 'release');
    target = join(libraryRoot, 'Author', 'Title');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'incumbent.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    dbDir = mkdtempSync(join(tmpdir(), 'narratorr-1737-db-'));
    const dbFile = join(dbDir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    bookService = new BookService(db, createMockLogger());
  });

  afterEach(async () => {
    db.$client.close();
    await rm(baseDir, { recursive: true, force: true });
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort.
    }
  });

  it('resolves the real owner row stored at the POSIX target path and routes the same recording through a staged swap', async () => {
    const seeded = await bookService.create({ title: 'Title', authors: [{ name: 'Author' }], asin: 'B0SAME', status: 'imported' });
    await bookService.update(seeded.id, { path: toPosix(target) });

    // Base-path result distinguishes a matched owner from the zero-owner disambiguation path.
    const item: ImportConfirmItem = { path: source, title: 'Title', authorName: 'Author', narrators: ['Stephen Fry'], asin: 'B0SAME' };
    const result = await copyToLibrary(item, null, 'copy', buildDeps());

    expect(result.targetPath).toBe(toPosix(target));
    expect(result.editionLabel).toBeUndefined();
    expect((await readdir(target)).sort()).toEqual(['new.mp3']);
    expect(await pathExists(join(libraryRoot, 'Author', 'Title (Stephen Fry)'))).toBe(false);
  });

  // Literal backslashes exercise POSIX folding on every host, not only Windows (#1752).
  it('findPathOwners folds a backslash query key to POSIX so it still matches the stored path (#1752)', async () => {
    const seeded = await bookService.create({ title: 'Title', authors: [{ name: 'Author' }], asin: 'B0FOLD', status: 'imported' });
    await bookService.update(seeded.id, { path: '/library/Author/Title' });

    const owners = await bookService.findPathOwners('\\library\\Author\\Title');
    expect(owners.map(o => o.id)).toEqual([seeded.id]);

    // A genuinely different POSIX path still misses; the fold does not over-match.
    expect(await bookService.findPathOwners('\\library\\Author\\Other')).toEqual([]);
  });
});
