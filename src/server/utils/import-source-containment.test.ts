import { describe, expect, it } from 'vitest';
import { parse } from 'node:path';
import { classifyImportSource } from './import-source-containment.js';

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
