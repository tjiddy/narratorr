import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';

// Real filesystem semantics AND injected errno failures: a temp that is created and only then
// rejected is the whole defect, and a fully mocked fs cannot leave residue for the assertion to see.
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

import { rename, writeFile } from 'node:fs/promises';
import { uploadBookCover } from './cover-upload.js';

const PNG = Buffer.from('fake-png-bytes');

function makeLog(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info',
  });
}

function makeDb(): { db: Db; update: Mock } {
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  });
  return { db: inject<Db>({ update }), update };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

let root: string;
let bookPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // The factory's vi.fn()s carry no implementation, so re-arm the real ones every test.
  (writeFile as Mock).mockImplementation(actualFs.writeFile as never);
  (rename as Mock).mockImplementation(actualFs.rename as never);

  root = await actualFs.mkdtemp(join(tmpdir(), 'narratorr-2302-'));
  bookPath = join(root, 'Terry Pratchett', 'Mort');
  await actualFs.mkdir(bookPath, { recursive: true });
});

afterEach(async () => {
  // Windows keeps handles open; a leaked tmpdir is cheaper than a red suite.
  await actualFs.rm(root, { recursive: true, force: true }).catch(() => { /* tolerant */ });
});

const entries = (): Promise<string[]> => actualFs.readdir(bookPath);
const tempsLeftBehind = async (): Promise<string[]> =>
  (await entries()).filter((name) => name.endsWith('.tmp'));

describe('uploadBookCover — cleanup boundary spans the temp write (#2302)', () => {
  it('cleans up a PARTIALLY WRITTEN temp when the temp write itself rejects', async () => {
    const cause = errno('ENOSPC');
    (writeFile as Mock).mockImplementation(async (path: string) => {
      // Reject only AFTER creating the temp — the arm a try wrapped around `rename` alone misses.
      await actualFs.writeFile(path, 'partial');
      throw cause;
    });
    const { db, update } = makeDb();

    await expect(uploadBookCover(5, bookPath, PNG, 'image/png', db, makeLog())).rejects.toBe(cause);

    expect(await tempsLeftBehind()).toEqual([]);
    expect(await entries()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('propagates the original error unchanged when the temp write rejects BEFORE creating the file', async () => {
    const cause = errno('EACCES');
    (writeFile as Mock).mockRejectedValue(cause);
    const { db, update } = makeDb();

    // The cleanup unlink hits a path that was never created; its ENOENT must not surface.
    await expect(uploadBookCover(5, bookPath, PNG, 'image/png', db, makeLog())).rejects.toBe(cause);

    expect(await entries()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('cleans up the temp when the rename rejects after a successful temp write', async () => {
    const cause = errno('EXDEV');
    (rename as Mock).mockRejectedValue(cause);
    const { db, update } = makeDb();

    await expect(uploadBookCover(5, bookPath, PNG, 'image/png', db, makeLog())).rejects.toBe(cause);

    expect(await tempsLeftBehind()).toEqual([]);
    expect(await entries()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves a pre-existing cover byte-identical when the temp write rejects', async () => {
    const seeded = Buffer.from('the-original-jpeg');
    await actualFs.writeFile(join(bookPath, 'cover.jpg'), seeded);
    (writeFile as Mock).mockImplementation(async (path: string) => {
      await actualFs.writeFile(path, 'partial');
      throw errno('ENOSPC');
    });

    await expect(
      uploadBookCover(5, bookPath, PNG, 'image/png', makeDb().db, makeLog()),
    ).rejects.toThrow('ENOSPC');

    expect(await actualFs.readFile(join(bookPath, 'cover.jpg'))).toEqual(seeded);
    expect(await entries()).toEqual(['cover.jpg']);
  });
});

describe('uploadBookCover — successful replacement (#2302)', () => {
  it('commits the uploaded bytes, sweeps a stale cover, and leaves no residue', async () => {
    await actualFs.writeFile(join(bookPath, 'cover.jpg'), 'stale');
    const { db, update } = makeDb();

    const outcome = await uploadBookCover(5, bookPath, PNG, 'image/png', db, makeLog());

    expect(outcome).toBe('written');
    expect(await actualFs.readFile(join(bookPath, 'cover.png'))).toEqual(PNG);
    expect(await tempsLeftBehind()).toEqual([]);
    expect(await entries()).toEqual(['cover.png']);
    expect(update).toHaveBeenCalled();
  });

  it('writes the temp as a born-hidden .cover-upload- sibling in the book folder', async () => {
    await uploadBookCover(5, bookPath, PNG, 'image/png', makeDb().db, makeLog());

    const tempPath = (writeFile as Mock).mock.calls[0]![0] as string;
    expect(basename(tempPath)).toMatch(/^\.cover-upload-[0-9a-f-]+\.tmp$/);
    expect(dirname(tempPath)).toBe(bookPath);
  });

  it('commits a zero-byte buffer rather than short-circuiting on its length', async () => {
    const outcome = await uploadBookCover(5, bookPath, Buffer.alloc(0), 'image/png', makeDb().db, makeLog());

    expect(outcome).toBe('written');
    expect(await actualFs.readFile(join(bookPath, 'cover.png'))).toEqual(Buffer.alloc(0));
    expect(await entries()).toEqual(['cover.png']);
  });
});
