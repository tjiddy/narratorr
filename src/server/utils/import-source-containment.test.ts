import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { join, parse } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * `fs-spy-over-importactual`: the resolved form needs REAL symlink semantics for the matrix below
 * AND an injectable errno for the EACCES arm, so `realpath` is the only member spied and it defaults
 * back to the real implementation in `beforeEach`.
 */
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  realpath: vi.fn(),
}));

import { mkdir, realpath, symlink } from 'node:fs/promises';
import { CAN_SYMLINK, removeDirTolerant } from '../__tests__/windows-fs.js';
import { classifyImportSource, classifyImportSourceResolved } from './import-source-containment.js';

const isWin = process.platform === 'win32';

/**
 * #2478 AC1–AC8 — the lexical containment rule the Import Files route and `orchestrateCopy` share.
 *
 * Pure and table-driven: the rule takes no filesystem access and no settings read, so every case
 * here is a string pair. The positive controls come first deliberately — without them every
 * refusal below would also pass against a rule that rejects everything.
 */
describe('classifyImportSource (#2478)', () => {
  describe('admissible sources', () => {
    it('admits a sibling download folder', () => {
      expect(classifyImportSource('/downloads/Book', '/audiobooks')).toEqual({ admissible: true });
    });

    it('admits a source several levels under a download folder', () => {
      expect(classifyImportSource('/downloads/complete/audio/Author/Book', '/audiobooks'))
        .toEqual({ admissible: true });
    });

    it('carries no message on the admissible verdict', () => {
      const verdict = classifyImportSource('/downloads/Book', '/audiobooks');
      expect(verdict).not.toHaveProperty('message');
      expect(verdict).not.toHaveProperty('reason');
    });
  });

  describe('refusal shape', () => {
    it.each([
      ['/', '/audiobooks', 'source_is_filesystem_root'],
      ['/audiobooks/Book', '/audiobooks', 'source_inside_library'],
      ['/media', '/media/audiobooks', 'source_contains_library'],
    ] as const)('classifies %s against %s as %s with a human-readable message', (source, root, reason) => {
      const verdict = classifyImportSource(source, root);
      expect(verdict.admissible).toBe(false);
      expect(verdict).toMatchObject({ admissible: false, reason });
      if (verdict.admissible) throw new Error('unreachable');
      expect(verdict.message.length).toBeGreaterThan(0);
    });

    it('gives each refusal class its own message', () => {
      const messages = (['/', '/audiobooks/Book', '/media'] as const).map((source, i) => {
        const verdict = classifyImportSource(source, ['/audiobooks', '/audiobooks', '/media/audiobooks'][i]!);
        if (verdict.admissible) throw new Error('expected a refusal');
        return verdict.message;
      });
      expect(new Set(messages).size).toBe(3);
    });
  });

  describe('boundaries', () => {
    // AC3's empty-`rel` arm — the one that classifies the OPPOSITE way to paths.ts:isOutsideRoot.
    it('classifies the library root ITSELF as inside-library, not contains-library', () => {
      expect(classifyImportSource('/audiobooks', '/audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });

    // AC7: a source that trips both answers deterministically.
    it('answers source_is_filesystem_root for `/` even though it also contains the library', () => {
      expect(classifyImportSource('/', '/audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    it('refuses a strict ancestor of the library root', () => {
      expect(classifyImportSource('/media', '/media/audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_contains_library' });
    });

    // A naive startsWith implementation reds here, in both directions.
    it('admits a sibling whose name merely PREFIXES the library root', () => {
      expect(classifyImportSource('/audiobooks-old', '/audiobooks')).toEqual({ admissible: true });
    });

    it('admits a library root whose name merely prefixes the source', () => {
      expect(classifyImportSource('/audiobooks', '/audiobooks-old')).toEqual({ admissible: true });
    });
  });

  describe('missing library root (AC6)', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
      ['whitespace-only', '   '],
    ] as const)('still refuses `/` with %s library path', (_label, root) => {
      expect(classifyImportSource('/', root))
        .toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
      ['whitespace-only', '   '],
    ] as const)('admits a normal source with %s library path', (_label, root) => {
      expect(classifyImportSource('/downloads/Book', root)).toEqual({ admissible: true });
    });
  });

  describe('canonicalization (AC2)', () => {
    it.each(['/media/', '/media/.', '/media/audiobooks/..'])(
      'classifies %s exactly as /media does',
      (spelling) => {
        expect(classifyImportSource(spelling, '/media/audiobooks'))
          .toEqual(classifyImportSource('/media', '/media/audiobooks'));
      },
    );

    /**
     * The `posix-resolve-ignores-backslash` fixture. A `/library/A/../Y` spelling is VACUOUS for
     * this property on POSIX — bare `resolve` already collapses it. Only the backslash form reds
     * against a fold-after-resolve implementation.
     */
    it('collapses a `..` segment spelled with backslashes before comparing', () => {
      expect(classifyImportSource('/library\\A\\..\\Y', '/library'))
        .toEqual(classifyImportSource('/library/Y', '/library'));
      expect(classifyImportSource('/library\\A\\..\\Y', '/library'))
        .toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });

    it('folds separators on the LIBRARY side too', () => {
      expect(classifyImportSource('/library/Y', '/library\\A\\..'))
        .toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });
  });

  describe('filesystem roots (AC5)', () => {
    it.each(['/', '//', '/.'])('classifies %s as a filesystem root', (spelling) => {
      expect(classifyImportSource(spelling, '/audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    it('classifies the running platform\'s own root', () => {
      expect(classifyImportSource(parse(process.cwd()).root, '/audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    // `path.parse('C:/').root` is '' on POSIX, so a drive root is only a root spelling on win32.
    it.runIf(isWin).each(['C:\\', 'C:/'])('classifies the drive root %s as a filesystem root', (spelling) => {
      expect(classifyImportSource(spelling, 'C:\\audiobooks'))
        .toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    it.each(['/x', '.'])('does NOT classify %s as a filesystem root', (spelling) => {
      const verdict = classifyImportSource(spelling, '/audiobooks');
      expect(verdict).not.toMatchObject({ reason: 'source_is_filesystem_root' });
    });
  });
});

/**
 * #2538 AC1–AC5 — the realpath-aware wrapper the three adoption sites call. The lexical rule above
 * stays the pure core; everything here is about the layer that resolves links on top of it.
 */
describe('classifyImportSourceResolved (#2538)', () => {
  let baseDir: string;
  let libraryRoot: string;
  let outside: string;

  beforeAll(async () => {
    (realpath as Mock).mockImplementation(actualFs.realpath as never);
    baseDir = mkdtempSync(join(tmpdir(), 'narratorr-2538-containment-'));
    libraryRoot = join(baseDir, 'library');
    outside = join(baseDir, 'outside');
    await mkdir(join(libraryRoot, 'Managed Book'), { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  beforeEach(() => {
    (realpath as Mock).mockReset();
    (realpath as Mock).mockImplementation(actualFs.realpath as never);
  });

  afterAll(() => {
    removeDirTolerant(baseDir);
  });

  /** A link name nobody else claims, so each case owns its own inode. */
  let linkSeq = 0;
  async function linkTo(target: string): Promise<string> {
    const link = join(baseDir, `link-${linkSeq++}`);
    await symlink(target, link, 'dir');
    return link;
  }

  // T1 — without these, every refusal below also passes against a wrapper that refuses everything.
  describe('positive controls', () => {
    it('admits a sibling download folder', async () => {
      await expect(classifyImportSourceResolved(outside, libraryRoot)).resolves.toEqual({ admissible: true });
    });

    it('admits a source several levels under a download folder', async () => {
      const deep = join(outside, 'complete', 'audio', 'Author', 'Book');
      await mkdir(deep, { recursive: true });

      await expect(classifyImportSourceResolved(deep, libraryRoot)).resolves.toEqual({ admissible: true });
    });
  });

  /**
   * T2 — the async form must not change any answer the lexical form already gives. The pairs are
   * absolute paths that do not exist, so the ENOENT arm returns the lexical verdict verbatim; the
   * point is that the wrapper is a pass-through when no link is involved.
   */
  describe('delegation equivalence', () => {
    it.each([
      ['/downloads/Book', '/audiobooks'],
      ['/downloads/complete/audio/Author/Book', '/audiobooks'],
      ['/', '/audiobooks'],
      ['/audiobooks', '/audiobooks'],
      ['/audiobooks/Book', '/audiobooks'],
      ['/media', '/media/audiobooks'],
      ['/audiobooks-old', '/audiobooks'],
      ['/audiobooks', '/audiobooks-old'],
      ['/library\\A\\..\\Y', '/library'],
      ['/', null],
      ['/downloads/Book', ''],
    ] as const)('answers for %s against %s exactly as the lexical form does', async (source, root) => {
      await expect(classifyImportSourceResolved(source, root)).resolves.toEqual(classifyImportSource(source, root));
    });
  });

  // T3 — AC1b: an inadmissible lexical pair performs NO filesystem access.
  describe('short-circuit on a lexical refusal', () => {
    it.each([
      ['a filesystem root', '/'],
      ['the library root itself', ''],
      ['a strict ancestor of the library root', '..'],
    ])('never calls realpath for %s', async (_label, suffix) => {
      const source = suffix === '/' ? '/' : (suffix === '' ? libraryRoot : baseDir);

      const verdict = await classifyImportSourceResolved(source, libraryRoot);

      expect(verdict.admissible).toBe(false);
      expect(realpath).not.toHaveBeenCalled();
    });

    it('DOES resolve both operands when the lexical pair is admissible', async () => {
      await expect(classifyImportSourceResolved(outside, libraryRoot)).resolves.toEqual({ admissible: true });

      expect(realpath).toHaveBeenCalledTimes(2);
      expect(realpath).toHaveBeenCalledWith(outside);
      expect(realpath).toHaveBeenCalledWith(libraryRoot);
    });
  });

  /**
   * T4/T5 — AC2. ENOENT is tolerated on either operand because `validateSource`'s remote-path-mapping
   * guidance must stay the message a missing source produces, and an install whose library root does
   * not exist yet must not have every import throw.
   */
  describe('realpath failures', () => {
    it('returns the lexical verdict when the SOURCE is missing', async () => {
      const missing = join(baseDir, 'no-such-source');

      await expect(classifyImportSourceResolved(missing, libraryRoot)).resolves.toEqual({ admissible: true });
    });

    it('returns the lexical verdict when the LIBRARY ROOT is missing', async () => {
      const missingRoot = join(baseDir, 'no-such-library');

      await expect(classifyImportSourceResolved(outside, missingRoot)).resolves.toEqual({ admissible: true });
    });

    it('returns the lexical verdict when BOTH operands are missing', async () => {
      const missing = join(baseDir, 'no-such-source');
      const missingRoot = join(baseDir, 'no-such-library');

      await expect(classifyImportSourceResolved(missing, missingRoot)).resolves.toEqual({ admissible: true });
    });

    it('still answers a lexical REFUSAL for a missing source inside the library', async () => {
      const missingInside = join(libraryRoot, 'no-such-book');

      await expect(classifyImportSourceResolved(missingInside, libraryRoot))
        .resolves.toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });

    it('propagates a non-ENOENT realpath error instead of admitting the source', async () => {
      (realpath as Mock).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      await expect(classifyImportSourceResolved(outside, libraryRoot)).rejects.toThrow(/EACCES/);
    });
  });

  /**
   * T6 — AC3. Only the LIBRARY ROOT is a link here, so the seductive "just realpath the source"
   * implementation answers admissible while the correct one answers `source_contains_library`.
   */
  it.skipIf(!CAN_SYMLINK)('resolves the library root, not only the source', async () => {
    const realMedia = join(baseDir, 'real-media');
    const realLibrary = join(realMedia, 'audiobooks');
    await mkdir(realLibrary, { recursive: true });
    const linkedRoot = await linkTo(realLibrary);

    // The lexical rule sees two unrelated siblings and admits.
    expect(classifyImportSource(realMedia, linkedRoot)).toEqual({ admissible: true });
    await expect(classifyImportSourceResolved(realMedia, linkedRoot))
      .resolves.toMatchObject({ admissible: false, reason: 'source_contains_library' });
  });

  /**
   * T7 — `posix-resolve-ignores-backslash`. A `/library/A/../Y` fixture is vacuous on POSIX; only the
   * backslash form reds against a fold-after-resolve implementation.
   */
  it('collapses a backslash-spelled `..` segment on the resolved pair too', async () => {
    const escaped = `${libraryRoot}\\A\\..\\Y`;

    await expect(classifyImportSourceResolved(escaped, libraryRoot))
      .resolves.toEqual(await classifyImportSourceResolved(join(libraryRoot, 'Y'), libraryRoot));
    await expect(classifyImportSourceResolved(escaped, libraryRoot))
      .resolves.toMatchObject({ admissible: false, reason: 'source_inside_library' });
  });

  // T8 — AC13/AC14: the whole point of the layer. Each case is a real on-disk link.
  describe('symlinked sources', () => {
    it.skipIf(!CAN_SYMLINK)('classifies a link to a filesystem root as source_is_filesystem_root', async () => {
      const link = await linkTo(parse(process.cwd()).root);

      await expect(classifyImportSourceResolved(link, libraryRoot))
        .resolves.toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });

    it.skipIf(!CAN_SYMLINK)('classifies a link to the library root as source_inside_library', async () => {
      const link = await linkTo(libraryRoot);

      await expect(classifyImportSourceResolved(link, libraryRoot))
        .resolves.toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });

    it.skipIf(!CAN_SYMLINK)('classifies a link to a strict ancestor of the library root as source_contains_library', async () => {
      const link = await linkTo(baseDir);

      await expect(classifyImportSourceResolved(link, libraryRoot))
        .resolves.toMatchObject({ admissible: false, reason: 'source_contains_library' });
    });

    it.skipIf(!CAN_SYMLINK)('classifies a link to a path UNDER the library root as source_inside_library', async () => {
      const link = await linkTo(join(libraryRoot, 'Managed Book'));

      await expect(classifyImportSourceResolved(link, libraryRoot))
        .resolves.toMatchObject({ admissible: false, reason: 'source_inside_library' });
    });

    // AC14's false-refusal control: symlinked media layouts stay supported.
    it.skipIf(!CAN_SYMLINK)('admits a link to an ordinary directory outside the library', async () => {
      const link = await linkTo(outside);

      await expect(classifyImportSourceResolved(link, libraryRoot)).resolves.toEqual({ admissible: true });
    });

    it.skipIf(!CAN_SYMLINK)('admits a linked source and a linked root resolving to unrelated trees', async () => {
      const realRoot = join(baseDir, 'unrelated-library');
      await mkdir(realRoot, { recursive: true });
      const linkedSource = await linkTo(outside);
      const linkedRoot = await linkTo(realRoot);

      await expect(classifyImportSourceResolved(linkedSource, linkedRoot)).resolves.toEqual({ admissible: true });
    });
  });

  // T9 — AC4: the verdict vocabulary is unchanged, on the async form too.
  describe('verdict shape', () => {
    it('carries no message or reason on the admissible verdict', async () => {
      const verdict = await classifyImportSourceResolved(outside, libraryRoot);

      expect(verdict).not.toHaveProperty('message');
      expect(verdict).not.toHaveProperty('reason');
    });

    it.skipIf(!CAN_SYMLINK)('carries a non-empty message on every resolved refusal class', async () => {
      const cases: Array<[string, string]> = [
        [await linkTo(parse(process.cwd()).root), 'source_is_filesystem_root'],
        [await linkTo(libraryRoot), 'source_inside_library'],
        [await linkTo(baseDir), 'source_contains_library'],
      ];

      const messages: string[] = [];
      for (const [link, reason] of cases) {
        const verdict = await classifyImportSourceResolved(link, libraryRoot);
        if (verdict.admissible) throw new Error(`expected a refusal for ${reason}`);
        expect(verdict.reason).toBe(reason);
        expect(verdict.message.length).toBeGreaterThan(0);
        messages.push(verdict.message);
      }
      expect(new Set(messages).size).toBe(3);
    });
  });

  // AC2's second dependant: an install whose library path is not configured at all.
  describe('missing library root', () => {
    it.each([['null', null], ['undefined', undefined], ['empty', '']] as const)(
      'admits an outside source with a %s library path', async (_label, root) => {
        await expect(classifyImportSourceResolved(outside, root)).resolves.toEqual({ admissible: true });
      });

    it.skipIf(!CAN_SYMLINK)('still refuses a link to a filesystem root with no library path', async () => {
      const link = await linkTo(parse(process.cwd()).root);

      await expect(classifyImportSourceResolved(link, null))
        .resolves.toMatchObject({ admissible: false, reason: 'source_is_filesystem_root' });
    });
  });
});
