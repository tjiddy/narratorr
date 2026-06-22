import { describe, it, expect, vi } from 'vitest';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { deleteManagedBookFiles } from './delete-managed-files.js';
import { PathOutsideLibraryError } from './paths.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const base = (paths: string[]): string[] => paths.map((p) => p.split(/[\\/]/).pop()!).sort();

function withTmp(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'narratorr-1589-'));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe('deleteManagedBookFiles', () => {
  it('deletes audio + cover sidecar, preserves foreign files, and retains the folder', withTmp(async (root) => {
    const book = join(root, 'Author', 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'chapter1.mp3'), 'a');
    await writeFile(join(book, 'chapter2.m4b'), 'b');
    await writeFile(join(book, 'cover.jpg'), 'c');
    await writeFile(join(book, 'book.epub'), 'd');
    await writeFile(join(book, 'manual.pdf'), 'e');
    await writeFile(join(book, 'subs.srt'), 'f');
    await writeFile(join(book, 'fanart.jpg'), 'g'); // non-cover image name → foreign
    await writeFile(join(book, 'metadata.nfo'), 'h');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['chapter1.mp3', 'chapter2.m4b', 'cover.jpg']);
    expect(base(result.preservedForeign)).toEqual(['book.epub', 'fanart.jpg', 'manual.pdf', 'metadata.nfo', 'subs.srt']);
    expect(result.failedManaged).toEqual([]);

    // Managed gone, foreign + folder retained.
    expect(await pathExists(join(book, 'chapter1.mp3'))).toBe(false);
    expect(await pathExists(join(book, 'cover.jpg'))).toBe(false);
    expect(await pathExists(join(book, 'book.epub'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('is case-insensitive for audio and cover extensions', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'Track.MP3'), 'a');
    await writeFile(join(book, 'Cover.JPG'), 'b');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['Cover.JPG', 'Track.MP3']);
    expect(result.preservedForeign).toEqual([]);
    // Only managed files existed → folder removed.
    expect(await pathExists(book)).toBe(false);
  }));

  it('recurses into multi-disc subfolders, preserves a top-level pdf, retains the folder', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(join(book, 'Disc 1'), { recursive: true });
    await mkdir(join(book, 'Disc 2'), { recursive: true });
    await writeFile(join(book, 'Disc 1', 'd1.mp3'), 'a');
    await writeFile(join(book, 'Disc 2', 'd2.mp3'), 'b');
    await writeFile(join(book, 'ebook.pdf'), 'c');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['d1.mp3', 'd2.mp3']);
    expect(base(result.preservedForeign)).toEqual(['ebook.pdf']);
    // Empty disc subfolders removed, but the book folder is retained for the foreign pdf.
    expect(await pathExists(join(book, 'Disc 1'))).toBe(false);
    expect(await pathExists(join(book, 'Disc 2'))).toBe(false);
    expect(await pathExists(join(book, 'ebook.pdf'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('removes the folder when only managed files existed', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'a.mp3'), 'a');
    await writeFile(join(book, 'cover.png'), 'b');

    await deleteManagedBookFiles(book, root, makeLog());

    expect(await pathExists(book)).toBe(false);
  }));

  it('handles a single audio-file source path (move-mode source regression)', withTmp(async (root) => {
    const sourceFile = join(root, 'audiobook.mp3');
    await writeFile(sourceFile, 'a');

    const result = await deleteManagedBookFiles(sourceFile, root, makeLog(), { assertInsideLibrary: false });

    expect(base(result.deletedManaged)).toEqual(['audiobook.mp3']);
    expect(await pathExists(sourceFile)).toBe(false);
  }));

  it('is a no-op for a missing path', withTmp(async (root) => {
    const result = await deleteManagedBookFiles(join(root, 'does-not-exist'), root, makeLog());
    expect(result).toEqual({ deletedManaged: [], preservedForeign: [], failedManaged: [] });
  }));

  it('throws PathOutsideLibraryError in the containment-guarded mode', withTmp(async (root) => {
    await expect(deleteManagedBookFiles('/etc', root, makeLog())).rejects.toBeInstanceOf(PathOutsideLibraryError);
  }));

  it('does not throw for an external source path in non-containment mode but only deletes managed files', withTmp(async (root) => {
    // A sibling directory OUTSIDE the library root.
    const external = join(root, '..', `narratorr-1589-ext-${process.pid}`);
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'a.mp3'), 'a');
    await writeFile(join(external, 'bundled.pdf'), 'b');
    try {
      const result = await deleteManagedBookFiles(external, root, makeLog(), { assertInsideLibrary: false });
      expect(base(result.deletedManaged)).toEqual(['a.mp3']);
      expect(base(result.preservedForeign)).toEqual(['bundled.pdf']);
      expect(await pathExists(join(external, 'bundled.pdf'))).toBe(true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));
});
