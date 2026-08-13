import { describe, it, expect, vi } from 'vitest';
import { mkdir, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { deleteManagedBookFiles } from './delete-managed-files.js';
import { PathOutsideLibraryError } from './paths.js';
import { NARRATORR_OPF_MARKER } from '@core/utils/opf-regex.js';

const MARKED_OPF = `<?xml version="1.0"?><package><metadata>${NARRATORR_OPF_MARKER}<dc:title>X</dc:title></metadata></package>`;
const FOREIGN_OPF = '<?xml version="1.0"?><package><metadata><dc:title>ABS</dc:title></metadata></package>';

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
    await writeFile(join(book, 'fanart.jpg'), 'g');
    await writeFile(join(book, 'metadata.nfo'), 'h');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['chapter1.mp3', 'chapter2.m4b', 'cover.jpg']);
    expect(base(result.preservedForeign)).toEqual(['book.epub', 'fanart.jpg', 'manual.pdf', 'metadata.nfo', 'subs.srt']);
    expect(result.failedManaged).toEqual([]);

    expect(await pathExists(join(book, 'chapter1.mp3'))).toBe(false);
    expect(await pathExists(join(book, 'cover.jpg'))).toBe(false);
    expect(await pathExists(join(book, 'book.epub'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('#1852: preserves a born-hidden temp file AND a .merge-tmp/ subtree (never deleted, never classified)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'chapter1.mp3'), 'a');
    await writeFile(join(book, '.chapter1.tmp.mp3'), 'b');
    await mkdir(join(book, '.merge-tmp'), { recursive: true });
    await writeFile(join(book, '.merge-tmp', 'staged.m4b'), 'c');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['chapter1.mp3']);
    expect(base(result.preservedForeign)).toEqual([]);
    expect(await pathExists(join(book, '.chapter1.tmp.mp3'))).toBe(true);
    expect(await pathExists(join(book, '.merge-tmp', 'staged.m4b'))).toBe(true);
  }));

  // A caller-supplied hidden root is descended; only discovered hidden children are skipped.
  it('#1852 F9: a hidden book root still deletes its visible managed audio while preserving a hidden temp', withTmp(async (root) => {
    const book = join(root, '.Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'chapter1.mp3'), 'a');
    await writeFile(join(book, '.chapter1.tmp.mp3'), 'b');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['chapter1.mp3']);
    expect(await pathExists(join(book, 'chapter1.mp3'))).toBe(false);
    expect(await pathExists(join(book, '.chapter1.tmp.mp3'))).toBe(true);
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

  it('preserves nested covers (managed cover only at the book-folder root), deletes nested audio (#1591)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(join(book, 'Disc 1'), { recursive: true });
    await mkdir(join(book, 'Extras'), { recursive: true });
    await writeFile(join(book, 'cover.jpg'), 'root-cover');
    await writeFile(join(book, 'a.mp3'), 'a');
    await writeFile(join(book, 'Disc 1', 'cover.jpg'), 'per-disc');
    await writeFile(join(book, 'Disc 1', 'd1.mp3'), 'd1');
    await writeFile(join(book, 'Extras', 'cover.png'), 'extras');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['a.mp3', 'cover.jpg', 'd1.mp3']);
    expect(base(result.preservedForeign)).toEqual(['cover.jpg', 'cover.png']);
    expect(await pathExists(join(book, 'cover.jpg'))).toBe(false);
    expect(await pathExists(join(book, 'Disc 1', 'cover.jpg'))).toBe(true);
    expect(await pathExists(join(book, 'Extras', 'cover.png'))).toBe(true);
    expect(await pathExists(join(book, 'Disc 1', 'd1.mp3'))).toBe(false);
    expect(await pathExists(book)).toBe(true);
  }));

  it('deletes a MARKED root metadata.opf sidecar (managed), removing the folder when otherwise empty (#1674)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'a.mp3'), 'a');
    await writeFile(join(book, 'metadata.opf'), MARKED_OPF);

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['a.mp3', 'metadata.opf']);
    expect(result.preservedForeign).toEqual([]);
    expect(await pathExists(book)).toBe(false);
  }));

  it('preserves an UNMARKED (foreign) root metadata.opf, leaving it on disk and retaining the folder (#1674)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'a.mp3'), 'a');
    await writeFile(join(book, 'metadata.opf'), FOREIGN_OPF);

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['a.mp3']);
    expect(base(result.preservedForeign)).toEqual(['metadata.opf']);
    expect(await pathExists(join(book, 'metadata.opf'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('is case-insensitive: a MARKED Metadata.OPF is deleted (#1674)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'Metadata.OPF'), MARKED_OPF);

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['Metadata.OPF']);
    expect(await pathExists(book)).toBe(false);
  }));

  it('is case-insensitive: an UNMARKED METADATA.OPF is preserved (#1674)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'METADATA.OPF'), FOREIGN_OPF);

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(result.deletedManaged).toEqual([]);
    expect(base(result.preservedForeign)).toEqual(['METADATA.OPF']);
    expect(await pathExists(join(book, 'METADATA.OPF'))).toBe(true);
  }));

  it('preserves a nested metadata.opf regardless of marker — managed only at the root (#1674)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(join(book, 'Disc 1'), { recursive: true });
    await writeFile(join(book, 'metadata.opf'), MARKED_OPF);
    await writeFile(join(book, 'a.mp3'), 'a');
    await writeFile(join(book, 'Disc 1', 'metadata.opf'), MARKED_OPF);
    await writeFile(join(book, 'Disc 1', 'd1.mp3'), 'd1');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.deletedManaged)).toEqual(['a.mp3', 'd1.mp3', 'metadata.opf']);
    expect(base(result.preservedForeign)).toEqual(['metadata.opf']);
    expect(await pathExists(join(book, 'metadata.opf'))).toBe(false);
    expect(await pathExists(join(book, 'Disc 1', 'metadata.opf'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('preserves a DIRECTORY named metadata.opf as foreign without reading through it (#1674, #2297)', withTmp(async (root) => {
    const book = join(root, 'Book');
    await mkdir(join(book, 'metadata.opf'), { recursive: true });
    await writeFile(join(book, 'a.mp3'), 'a');
    const log = makeLog();

    const result = await deleteManagedBookFiles(book, root, log);

    expect(base(result.deletedManaged)).toEqual(['a.mp3']);
    expect(base(result.preservedForeign)).toEqual(['metadata.opf']);
    expect(await pathExists(join(book, 'metadata.opf'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
    // Type is settled from the Dirent before any read, so there is no EISDIR to report.
    expect(log.warn).not.toHaveBeenCalled();
  }));

  it('refuses a guarded-mode bookPath that is an in-library symlink escaping the root — external files untouched (#1591)', withTmp(async (root) => {
    const external = mkdtempSync(join(tmpdir(), 'narratorr-1591-ext-'));
    try {
      await writeFile(join(external, 'track.mp3'), 'a');
      await writeFile(join(external, 'book.epub'), 'b');
      const link = join(root, 'EscapeBook');
      // Windows junctions avoid symlink privileges while preserving the tested link semantics.
      await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');

      await expect(deleteManagedBookFiles(link, root, makeLog())).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(await pathExists(join(external, 'track.mp3'))).toBe(true);
      expect(await pathExists(join(external, 'book.epub'))).toBe(true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));

  it('does not traverse a symlinked subfolder during the sweep — external files untouched (#1591)', withTmp(async (root) => {
    const external = mkdtempSync(join(tmpdir(), 'narratorr-1591-ext-'));
    try {
      await writeFile(join(external, 'track.mp3'), 'a');
      await writeFile(join(external, 'book.epub'), 'b');
      const book = join(root, 'Book');
      await mkdir(book, { recursive: true });
      await writeFile(join(book, 'real.mp3'), 'r');
      await symlink(external, join(book, 'Disc 1'), process.platform === 'win32' ? 'junction' : 'dir');

      const result = await deleteManagedBookFiles(book, root, makeLog());

      expect(base(result.deletedManaged)).toEqual(['real.mp3']);
      expect(await pathExists(join(book, 'real.mp3'))).toBe(false);
      expect(await pathExists(join(external, 'track.mp3'))).toBe(true);
      expect(await pathExists(join(external, 'book.epub'))).toBe(true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));

  it('classifies a top-level directory symlink as a link — does not follow it or delete its target (#1598)', withTmp(async (root) => {
    const external = mkdtempSync(join(tmpdir(), 'narratorr-1598-ext-'));
    try {
      await writeFile(join(external, 'track.mp3'), 'a');
      await writeFile(join(external, 'book.epub'), 'b');
      const link = join(root, 'LinkedSource');
      await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');

      const result = await deleteManagedBookFiles(link, root, makeLog(), { assertInsideLibrary: false });

      expect(result.deletedManaged).toEqual([]);
      expect(base(result.preservedForeign)).toEqual(['LinkedSource']);
      expect(result.failedManaged).toEqual([]);
      expect(await pathExists(join(external, 'track.mp3'))).toBe(true);
      expect(await pathExists(join(external, 'book.epub'))).toBe(true);
      expect(await pathExists(link)).toBe(true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));

  it('does not throw for an external source path in non-containment mode but only deletes managed files', withTmp(async (root) => {
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

/**
 * These AC13 cases need a FILE symlink, which Windows refuses with EPERM unless Developer Mode
 * is on — unlike the directory symlinks above, which fall back to junctions. Probe the
 * capability rather than the platform: these guard a security property (never read through an
 * operator's link to decide ownership), so they are worth skipping as rarely as possible.
 */
const CAN_SYMLINK = await (async () => {
  const probe = mkdtempSync(join(tmpdir(), 'narratorr-symlink-probe-'));
  try {
    const target = join(probe, 't');
    await writeFile(target, '');
    await symlink(target, join(probe, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true }).catch(() => { /* tolerant */ });
  }
})();

describe('deleteManagedBookFiles — the rolling sidecar backup (#2297 AC13)', () => {

  it('deletes a marked metadata.opf.bak alongside the sidecar and then removes the empty folder', withTmp(async (root) => {
    const book = join(root, 'Author', 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'metadata.opf'), MARKED_OPF);
    await writeFile(join(book, 'metadata.opf.bak'), MARKED_OPF);
    await writeFile(join(book, 'a.mp3'), 'a');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    // Left behind, the backup would both orphan itself and keep the folder alive on ENOTEMPTY.
    expect(base(result.deletedManaged)).toEqual(['a.mp3', 'metadata.opf', 'metadata.opf.bak']);
    expect(await pathExists(book)).toBe(false);
  }));

  it('preserves an UNMARKED operator-authored metadata.opf.bak and keeps the folder', withTmp(async (root) => {
    const book = join(root, 'Author', 'Book');
    await mkdir(book, { recursive: true });
    await writeFile(join(book, 'metadata.opf.bak'), FOREIGN_OPF);
    await writeFile(join(book, 'a.mp3'), 'a');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.preservedForeign)).toEqual(['metadata.opf.bak']);
    expect(await pathExists(join(book, 'metadata.opf.bak'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it.skipIf(!CAN_SYMLINK)('never reads through a symlinked metadata.opf.bak, so the operator link and its target survive', withTmp(async (root) => {
    const outside = join(root, 'marked-elsewhere.opf');
    await writeFile(outside, MARKED_OPF);
    const book = join(root, 'Author', 'Book');
    await mkdir(book, { recursive: true });
    await symlink(outside, join(book, 'metadata.opf.bak'));
    await writeFile(join(book, 'a.mp3'), 'a');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    // A content-only classifier follows the link, reads the marker, and deletes the link.
    expect(base(result.preservedForeign)).toEqual(['metadata.opf.bak']);
    expect(await pathExists(join(book, 'metadata.opf.bak'))).toBe(true);
    expect(await pathExists(outside)).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it.skipIf(!CAN_SYMLINK)('never reads through a symlinked metadata.opf either', withTmp(async (root) => {
    const outside = join(root, 'marked-elsewhere.opf');
    await writeFile(outside, MARKED_OPF);
    const book = join(root, 'Author', 'Book');
    await mkdir(book, { recursive: true });
    await symlink(outside, join(book, 'metadata.opf'));

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.preservedForeign)).toEqual(['metadata.opf']);
    expect(await pathExists(outside)).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));

  it('preserves a DIRECTORY named metadata.opf.bak as foreign', withTmp(async (root) => {
    const book = join(root, 'Author', 'Book');
    await mkdir(join(book, 'metadata.opf.bak'), { recursive: true });
    await writeFile(join(book, 'a.mp3'), 'a');

    const result = await deleteManagedBookFiles(book, root, makeLog());

    expect(base(result.preservedForeign)).toEqual(['metadata.opf.bak']);
    expect(await pathExists(join(book, 'metadata.opf.bak'))).toBe(true);
    expect(await pathExists(book)).toBe(true);
  }));
});
