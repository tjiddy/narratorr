import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { OPF_BACKUP_FILENAME, OPF_FILENAME, NARRATORR_OPF_MARKER } from '@core/utils/opf-regex.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';

// Real filesystem, with exactly two primitives injectable: `rename` to force the cross-volume
// branch, and `cp` to pause between the two entries the writer maintains as a matched pair.
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  rename: vi.fn(),
  cp: vi.fn(),
}));

import { cp, rename } from 'node:fs/promises';
import { RenameService } from './rename.service.js';
import { sidecarLockKey, writeOpfSidecar } from '../utils/opf-writer.js';
import { hasPendingPathWrite, withPathWriteLock } from '../utils/path-write-lock.js';
import { claimLockKey } from '../utils/claim-lock.js';

function markedOpf(generation: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    `    ${NARRATORR_OPF_MARKER}`,
    '    <dc:title>Mort</dc:title>',
    `    <dc:publisher>${generation}</dc:publisher>`,
    '  </metadata>',
    '</package>',
    '',
  ].join('\n');
}

const GENERATION_N_MINUS_1 = markedOpf('Generation N-1');
const GENERATION_N = markedOpf('Generation N — the curated one');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RenameService cross-volume fallback vs the sidecar writer (#2297 AC11)', () => {
  let libraryRoot: string;
  let oldFolder: string;
  let newFolder: string;
  let bookService: { getById: Mock; getAll: Mock; update: Mock };
  let service: RenameService;

  function bookRow(path: string, publisher: string | null) {
    return {
      ...createMockDbBook({ id: 1, title: 'Mort', path, status: 'imported', publisher }),
      authors: [createMockDbAuthor({ name: 'Terry Pratchett' })],
      narrators: [],
    } as unknown as BookWithAuthor;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (rename as Mock).mockImplementation(actualFs.rename as never);
    (cp as Mock).mockImplementation(actualFs.cp as never);

    libraryRoot = await actualFs.mkdtemp(join(tmpdir(), 'narratorr-2297-exdev-'));
    oldFolder = join(libraryRoot, 'Old Author', 'Old Title');
    newFolder = join(libraryRoot, 'Terry Pratchett', 'Mort');
    await mkdir(oldFolder, { recursive: true });
    await actualFs.writeFile(join(oldFolder, OPF_BACKUP_FILENAME), GENERATION_N_MINUS_1, 'utf-8');
    await actualFs.writeFile(join(oldFolder, OPF_FILENAME), GENERATION_N, 'utf-8');
    await actualFs.writeFile(join(oldFolder, 'book.m4b'), Buffer.alloc(64));

    const db = createMockDb();
    db.select.mockReturnValue(mockDbChain([]));
    bookService = {
      getById: vi.fn().mockResolvedValue(bookRow(oldFolder, 'Generation N — the curated one')),
      getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    service = new RenameService(
      inject<Db>(db),
      inject<BookService>(bookService),
      inject<SettingsService>(createMockSettingsService({
        library: { path: libraryRoot, folderFormat: '{author}/{title}', fileFormat: '' },
      })),
      inject<FastifyBaseLogger>(createMockLogger()),
    );
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true }).catch(() => { /* tolerant */ });
  });

  /** Reproduce `cp -r` faithfully — one entry at a time — with a pause after the backup. */
  function gateTheCopy(): { copying: Promise<void>; release: () => void } {
    const started = deferred<void>();
    const held = deferred<void>();
    (cp as Mock).mockImplementation(async (from: string, to: string) => {
      await actualFs.mkdir(to, { recursive: true });
      await actualFs.copyFile(join(from, OPF_BACKUP_FILENAME), join(to, OPF_BACKUP_FILENAME));
      started.resolve();
      await held.promise;
      for (const name of await actualFs.readdir(from)) {
        if (name === OPF_BACKUP_FILENAME) continue;
        await actualFs.copyFile(join(from, name), join(to, name));
      }
    });
    return { copying: started.promise, release: () => held.resolve() };
  }

  function startDivergentWrite(): Promise<string> {
    return writeOpfSidecar({
      enabled: true,
      bookService: {
        getById: vi.fn().mockResolvedValue(bookRow(oldFolder, 'Generation N+1')),
      } as unknown as BookService,
      bookId: 1,
      bookFolder: oldFolder,
      log: inject<FastifyBaseLogger>(createMockLogger()),
      preserve: { source: 'auto' },
    });
  }

  it('keeps the curated generation recoverable at the destination across the copy+delete pair', async () => {
    (rename as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' })));
    const { copying, release } = gateTheCopy();

    const renaming = service.renameBook(1);
    await copying;

    // Issued exactly in the window where cp has reproduced N−1 but not yet N.
    const writing = startDivergentWrite();
    await sleep(50);
    release();

    await renaming;
    await writing;

    const destinationSidecar = await actualFs.readFile(join(newFolder, OPF_FILENAME), 'utf-8');
    const destinationBackup = await actualFs.readFile(join(newFolder, OPF_BACKUP_FILENAME), 'utf-8');

    // Without the lock the destination reads N+1 beside N−1 and the curated generation is gone.
    expect([destinationSidecar, destinationBackup]).toContain(GENERATION_N);
    expect(destinationSidecar).toBe(GENERATION_N);
    expect(destinationBackup).toBe(GENERATION_N_MINUS_1);
  });

  it('a writer that acquires after the fallback releases fails rather than splitting the pair', async () => {
    (rename as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' })));
    const { copying, release } = gateTheCopy();

    const renaming = service.renameBook(1);
    await copying;
    const writing = startDivergentWrite();
    await sleep(50);
    release();
    await renaming;

    // The old folder is gone by the time the queued writer runs; its temp write cannot land.
    expect(await writing).toBe('failed');
    expect(await actualFs.stat(oldFolder).then(() => true, () => false)).toBe(false);
  });

  it('a cp that fails part-way leaves the source pair matched and books.path uncommitted', async () => {
    (rename as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' })));
    (cp as Mock).mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    await expect(service.renameBook(1)).rejects.toThrow('EIO');

    // `rm` is never reached, so the source folder still holds the matched pair.
    expect(await actualFs.readFile(join(oldFolder, OPF_FILENAME), 'utf-8')).toBe(GENERATION_N);
    expect(await actualFs.readFile(join(oldFolder, OPF_BACKUP_FILENAME), 'utf-8')).toBe(GENERATION_N_MINUS_1);
    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('the ATOMIC branch takes no lock — a single directory rename can never observe a split pair', async () => {
    const held = deferred<void>();
    const blocking = withPathWriteLock(sidecarLockKey(oldFolder), () => held.promise);

    // If the atomic branch acquired the key it would deadlock here rather than complete.
    await expect(Promise.race([service.renameBook(1), sleep(200).then(() => 'timed-out')]))
      .resolves.not.toBe('timed-out');

    expect((await readdir(newFolder)).sort()).toEqual([OPF_BACKUP_FILENAME, OPF_FILENAME, 'book.m4b'].sort());
    expect(cp).not.toHaveBeenCalled();

    held.resolve();
    await blocking;
  });

  it('nests the sidecar file key inside both claim keys without deadlocking, and leaks neither (#2301)', async () => {
    (rename as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' })));

    // A deadlock here hangs the suite, so the assertion is bounded rather than a bare await.
    await expect(Promise.race([service.renameBook(1), sleep(500).then(() => 'timed-out')]))
      .resolves.not.toBe('timed-out');

    // sidecarLockKey appends metadata.opf, so it can never equal the claim key it nests inside.
    expect(sidecarLockKey(oldFolder)).not.toBe(claimLockKey(oldFolder));
    await sleep(0);
    for (const key of [claimLockKey(oldFolder), claimLockKey(newFolder), sidecarLockKey(oldFolder)]) {
      expect(hasPendingPathWrite(key)).toBe(false);
    }
  });
});
