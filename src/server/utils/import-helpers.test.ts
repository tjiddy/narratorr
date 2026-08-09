import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
}));

import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';

import {
  extractYear,
  buildTargetPath,
  getPathSize,
  getAudioPathSize,
  getVisiblePathSize,
  containsAudioFiles,
  copyAudioFiles,
  copyDiscGroup,
  reconstructDiscGroup,
  countAudioFiles,
  COPY_VERIFICATION_THRESHOLD,
  assertCopyVerified,
  ContentFailureError,
} from './import-helpers.js';

const norm = (s: string) => s.split('\\').join('/');

function makeDirent(name: string, isFile: boolean, isDirectory: boolean) {
  return { name, isFile: () => isFile, isDirectory: () => isDirectory };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractYear', () => {
  it('returns 4-digit year from date string like "2010-11-02"', () => {
    expect(extractYear('2010-11-02')).toBe('2010');
  });

  it('returns 4-digit year from year-only string like "2010"', () => {
    expect(extractYear('2010')).toBe('2010');
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractYear(null)).toBeUndefined();
    expect(extractYear(undefined)).toBeUndefined();
  });

  it('returns undefined for string with no 4-digit year', () => {
    expect(extractYear('no year here')).toBeUndefined();
    expect(extractYear('12')).toBeUndefined();
  });
});

describe('COPY_VERIFICATION_THRESHOLD', () => {
  it('is 0.99', () => {
    expect(COPY_VERIFICATION_THRESHOLD).toBe(0.99);
  });
});

describe('assertCopyVerified (#1304)', () => {
  it('throws a ContentFailureError when target is below source * threshold', () => {
    expect(() => assertCopyVerified(1000, 400)).toThrow(ContentFailureError);
  });

  it('retains the source/target byte sizes in the diagnostic message', () => {
    expect(() => assertCopyVerified(1000, 400))
      .toThrow('Copy verification failed: source 1000 bytes, target 400 bytes');
  });

  it('does not throw exactly at the threshold boundary (source * 0.99)', () => {
    expect(() => assertCopyVerified(1000, 990)).not.toThrow();
  });

  it('does not throw above the threshold', () => {
    expect(() => assertCopyVerified(1000, 1000)).not.toThrow();
  });

  it('throws just below the threshold boundary', () => {
    expect(() => assertCopyVerified(1000, 989)).toThrow(ContentFailureError);
  });

  it('does not throw for a zero-byte source/target (audio-free folder edge, #1346)', () => {
    expect(() => assertCopyVerified(0, 0)).not.toThrow();
  });
});

describe('buildTargetPath', () => {
  it('renders folder format with author and title tokens', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson');
    expect(result).toMatch(/Brandon Sanderson/);
    expect(result).toMatch(/The Way of Kings/);
  });

  it('uses "Unknown Author" when authorName is null', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Test' }, null);
    expect(result).toMatch(/Unknown Author/);
  });

  it('renders series tokens when seriesName is present', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{series}/{title}', {
      title: 'Book 1',
      seriesName: 'My Series',
      seriesPosition: 1,
    }, 'Author');
    expect(result).toMatch(/My Series/);
  });

  it('omits optional tokens (narrator, year) when not provided', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Test' }, 'Author');
    expect(result).not.toMatch(/\{narrator\}/);
    expect(result).not.toMatch(/\{year\}/);
  });

  it('joins rendered path segments with library path', () => {
    const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Book' }, 'Author');
    expect(result).toContain('audiobooks');
    expect(result).toContain('Author');
    expect(result).toContain('Book');
  });

  describe('with naming options', () => {
    it('forwards separator option to renderTemplate — periods in token values', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson', { separator: 'period' });
      expect(result).toContain('Brandon.Sanderson');
      expect(result).toContain('The.Way.of.Kings');
    });

    it('forwards case option to renderTemplate — uppercase token values', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson', { case: 'upper' });
      expect(result).toContain('BRANDON SANDERSON');
      expect(result).toContain('THE WAY OF KINGS');
    });

    it('omitting options preserves existing behavior', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'The Way of Kings' }, 'Brandon Sanderson');
      expect(result).toContain('Brandon Sanderson');
      expect(result).toContain('The Way of Kings');
    });
  });

  describe('{edition} token + mandatory suffix double-render rule (#1712)', () => {
    it('template lacking {edition}: appends the mandatory " (label)" collision suffix (unchanged)', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Dark Matter' }, 'Blake Crouch', undefined, 'Full Cast');
      expect(result).toBe('/audiobooks/Blake Crouch/Dark Matter (Full Cast)');
    });

    it('template containing {edition}: renders the label in place and does NOT double it with the suffix', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', { title: 'Dark Matter' }, 'Blake Crouch', undefined, 'Full Cast');
      expect(result).toBe('/audiobooks/Blake Crouch/Dark Matter (Full Cast)');
      expect(result.match(/Full Cast/g)).toHaveLength(1);
    });

    it('null editionLabel: neither the token nor the suffix emits a label (single-edition path unchanged)', () => {
      const withToken = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', { title: 'Dark Matter' }, 'Blake Crouch', undefined, null);
      expect(withToken).toBe('/audiobooks/Blake Crouch/Dark Matter');
      const withoutToken = buildTargetPath('/audiobooks', '{author}/{title}', { title: 'Dark Matter' }, 'Blake Crouch', undefined, null);
      expect(withoutToken).toBe('/audiobooks/Blake Crouch/Dark Matter');
    });
  });

  describe('edition discriminator is sanitized as one path segment (#1739)', () => {
    const book = { title: 'Dark Matter' };

    it('a slash in the label does NOT fragment the path into extra segments (suffix branch)', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', undefined, 'R.C. Bray/Full Cast');
      expect(norm(result)).toBe('/audiobooks/Blake Crouch/Dark Matter (R.C. BrayFull Cast)');
    });

    it('a slash in the label does NOT fragment the path (token branch)', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', book, 'Blake Crouch', undefined, 'R.C. Bray/Full Cast');
      expect(norm(result)).toBe('/audiobooks/Blake Crouch/Dark Matter (R.C. BrayFull Cast)');
    });

    it('colons and control chars are stripped to a Windows-legal leaf in both branches', () => {
      const suffix = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', undefined, 'Cast: Ensemble');
      const token = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', book, 'Blake Crouch', undefined, 'Cast: Ensemble');
      expect(suffix).toBe(token);
      expect(norm(suffix)).toBe('/audiobooks/Blake Crouch/Dark Matter (Cast Ensemble)');
      expect(suffix.split('/').pop()).not.toContain(':');
    });

    it('a label that sanitizes to empty is treated like null — no Unknown discriminator (both branches)', () => {
      const suffix = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', undefined, ':::');
      const token = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', book, 'Blake Crouch', undefined, ':::');
      expect(suffix).toBe('/audiobooks/Blake Crouch/Dark Matter');
      expect(token).toBe('/audiobooks/Blake Crouch/Dark Matter');
      expect(suffix).not.toContain('Unknown');
    });

    it('a label ending in a reserved import-sibling suffix never yields a folder ending in it', () => {
      const result = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', undefined, 'Full Cast.import-bak');
      expect(norm(result).endsWith('.import-bak')).toBe(false);
      expect(norm(result)).toBe('/audiobooks/Blake Crouch/Dark Matter (Full Cast)');
    });

    it('#1911: the active scratch suffixes are reserved on the edition label too', () => {
      for (const suffix of ['.import-staging', '.import-backup']) {
        const result = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', undefined, `Full Cast${suffix}`);
        expect(norm(result).endsWith(suffix)).toBe(false);
        expect(norm(result)).toBe('/audiobooks/Blake Crouch/Dark Matter (Full Cast)');
      }
    });

    describe('no truncation-collapse with a 255-char title (F9)', () => {
      const longTitle = 'T'.repeat(255);
      const longBook = { title: longTitle };

      it('suffix branch: the discriminator survives, leaf ≤255, Windows-legal', () => {
        const result = buildTargetPath('/audiobooks', '{author}/{title}', longBook, 'Author', undefined, 'Full Cast');
        const leaf = norm(result).split('/').pop()!;
        expect(leaf.length).toBeLessThanOrEqual(255);
        expect(leaf).toContain('(Full Cast)');
      });

      it('token branch: the in-place {edition} discriminator survives generic segment truncation', () => {
        const result = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', longBook, 'Author', undefined, 'Full Cast');
        const leaf = norm(result).split('/').pop()!;
        expect(leaf.length).toBeLessThanOrEqual(255);
        expect(leaf).toContain('(Full Cast)');
        expect(leaf.endsWith('(Full Cast)')).toBe(true);
      });

      it('two distinct editions of the same long title do NOT collapse to the same path (token branch)', () => {
        const a = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', longBook, 'Author', undefined, 'Full Cast');
        const b = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', longBook, 'Author', undefined, 'Stephen Fry');
        expect(a).not.toBe(b);
      });

      it('suffix branch: an overlong discriminator behind a long title still survives non-empty (F1)', () => {
        const longLabel = 'N'.repeat(255);
        const result = buildTargetPath('/audiobooks', '{author}/{title}', longBook, 'Author', undefined, longLabel);
        const leaf = norm(result).split('/').pop()!;
        expect(leaf.length).toBeLessThanOrEqual(255);
        expect(leaf).toContain('N');
      });

      it('token branch: discriminator survives when BOTH {title} and {titleSort} land in the leaf (F2)', () => {
        const result = buildTargetPath('/audiobooks', '{author}/{title} - {titleSort} ({edition})', longBook, 'Author', undefined, 'Full Cast');
        const leaf = norm(result).split('/').pop()!;
        expect(leaf.length).toBeLessThanOrEqual(255);
        expect(leaf).toContain('(Full Cast)');
        expect(leaf.endsWith('(Full Cast)')).toBe(true);
      });

      it('token branch: an overlong discriminator with a 255-char title still survives non-empty (F3)', () => {
        // Short budgeting probes must not saturate when the discriminator does.
        const longLabel = 'N'.repeat(255);
        const result = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', longBook, 'Author', undefined, longLabel);
        const leaf = norm(result).split('/').pop()!;
        expect(leaf.length).toBeLessThanOrEqual(255);
        expect(leaf).toContain('N');
        expect(leaf).toContain('(N');
      });
    });

    describe('naming-options parity: token and suffix branches agree on the discriminator (F6)', () => {
      for (const options of [undefined, { separator: 'period' as const, case: 'upper' as const }]) {
        const label = options ? 'non-default (period/upper)' : 'default';
        it(`same discriminator under ${label} naming options`, () => {
          const suffix = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', options, 'Full Cast');
          const token = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', book, 'Blake Crouch', options, 'Full Cast');
          expect(suffix).toBe(token);
          // Naming transforms must not style the discriminator.
          expect(suffix.split('/').pop()).toContain('(Full Cast)');
        });

        it(`sanitize-to-empty renders the unchanged base in both branches under ${label}`, () => {
          const suffix = buildTargetPath('/audiobooks', '{author}/{title}', book, 'Blake Crouch', options, ':::');
          const token = buildTargetPath('/audiobooks', '{author}/{title} ({edition})', book, 'Blake Crouch', options, ':::');
          expect(suffix).toBe(token);
          expect(suffix.split('/').pop()).not.toContain('(');
        });
      }
    });
  });
});

describe('getPathSize', () => {
  it('returns file size for a single file', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 1024 } as Stats);
    const size = await getPathSize('/some/file.mp3');
    expect(size).toBe(1024);
  });

  it('returns total size for a directory with files', async () => {
    vi.mocked(stat)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats)
      .mockResolvedValueOnce({ size: 100 } as Stats)
      .mockResolvedValueOnce({ size: 200 } as Stats);
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('file1.mp3', true, false),
      makeDirent('file2.mp3', true, false),
    ] as never);

    const size = await getPathSize('/some/dir');
    expect(size).toBe(300);
  });

  it('recursively sums nested directory sizes', async () => {
    vi.mocked(stat)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats)
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true } as unknown as Stats)
      .mockResolvedValueOnce({ size: 500 } as Stats);

    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('nested.mp3', true, false)] as never);

    const size = await getPathSize('/root');
    expect(size).toBe(500);
  });
});

// Public-wrapper matrix for the shared walker: hidden/audio/root/Dirent/error policies (#1856).
describe('directory sizers — consolidated walker policy matrix (#1856)', () => {
  const ROOT = '/root';

  // Unknown paths reject so forbidden stat/readdir calls fail loudly.
  function mockFs(
    dirs: Record<string, ReturnType<typeof makeDirent>[]>,
    files: Record<string, number>,
  ): void {
    vi.mocked(stat).mockImplementation(async (p) => {
      const key = String(p);
      if (key in files) return { isFile: () => true, isDirectory: () => false, size: files[key] } as Stats;
      if (key in dirs) return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
      throw new Error(`unexpected stat: ${key}`);
    });
    vi.mocked(readdir).mockImplementation(async (p) => {
      const key = String(p);
      if (key in dirs) return dirs[key] as never;
      throw new Error(`unexpected readdir: ${key}`);
    });
  }

  it('dir with a.mp3 (100) + uppercase TRACK.M4B (10): 110 / 110 / 110', async () => {
    mockFs(
      { [ROOT]: [makeDirent('a.mp3', true, false), makeDirent('TRACK.M4B', true, false)] },
      { [join(ROOT, 'a.mp3')]: 100, [join(ROOT, 'TRACK.M4B')]: 10 },
    );
    expect(await getPathSize(ROOT)).toBe(110);
    expect(await getAudioPathSize(ROOT)).toBe(110);
    expect(await getVisiblePathSize(ROOT)).toBe(110);
  });

  it('dir with only a visible non-audio cover.jpg (50): 50 / 0 / 50', async () => {
    mockFs({ [ROOT]: [makeDirent('cover.jpg', true, false)] }, { [join(ROOT, 'cover.jpg')]: 50 });
    expect(await getPathSize(ROOT)).toBe(50);
    expect(await getAudioPathSize(ROOT)).toBe(0);
    expect(await getVisiblePathSize(ROOT)).toBe(50);
  });

  it('dir with visible a.mp3 (100) + dot-file .tmp.mp3 (999): 1099 / 100 / 100', async () => {
    mockFs(
      { [ROOT]: [makeDirent('a.mp3', true, false), makeDirent('.tmp.mp3', true, false)] },
      { [join(ROOT, 'a.mp3')]: 100, [join(ROOT, '.tmp.mp3')]: 999 },
    );
    expect(await getPathSize(ROOT)).toBe(1099);
    expect(await getAudioPathSize(ROOT)).toBe(100);
    expect(await getVisiblePathSize(ROOT)).toBe(100);
  });

  it('dir with visible a.mp3 (100) + dot-dir .hidden/ (5000): includes / 100 / 100', async () => {
    mockFs(
      {
        [ROOT]: [makeDirent('a.mp3', true, false), makeDirent('.hidden', false, true)],
        [join(ROOT, '.hidden')]: [makeDirent('big.m4b', true, false)],
      },
      { [join(ROOT, 'a.mp3')]: 100, [join(ROOT, '.hidden', 'big.m4b')]: 5000 },
    );
    expect(await getPathSize(ROOT)).toBe(5100);
    expect(await getAudioPathSize(ROOT)).toBe(100);
    expect(await getVisiblePathSize(ROOT)).toBe(100);
  });

  it('empty directory: 0 / 0 / 0 (base case, F8)', async () => {
    mockFs({ [ROOT]: [] }, {});
    expect(await getPathSize(ROOT)).toBe(0);
    expect(await getAudioPathSize(ROOT)).toBe(0);
    expect(await getVisiblePathSize(ROOT)).toBe(0);
  });

  it('direct file root a.mp3 (100): 100 / 100 / 100', async () => {
    const p = '/x/a.mp3';
    mockFs({}, { [p]: 100 });
    expect(await getPathSize(p)).toBe(100);
    expect(await getAudioPathSize(p)).toBe(100);
    expect(await getVisiblePathSize(p)).toBe(100);
  });

  it('direct file root cover.jpg (50): 50 / 0 / 50', async () => {
    const p = '/x/cover.jpg';
    mockFs({}, { [p]: 50 });
    expect(await getPathSize(p)).toBe(50);
    expect(await getAudioPathSize(p)).toBe(0);
    expect(await getVisiblePathSize(p)).toBe(50);
  });

  it('direct file root uppercase BOOK.M4B (100): 100 / 100 / 100 (case-insensitive root predicate, F2)', async () => {
    const p = '/x/BOOK.M4B';
    mockFs({}, { [p]: 100 });
    expect(await getPathSize(p)).toBe(100);
    expect(await getAudioPathSize(p)).toBe(100);
    expect(await getVisiblePathSize(p)).toBe(100);
  });

  it('direct hidden file root .a.mp3 (100): 100 / 0 / 100 (F32)', async () => {
    const p = '/x/.a.mp3';
    mockFs({}, { [p]: 100 });
    expect(await getPathSize(p)).toBe(100);
    expect(await getAudioPathSize(p)).toBe(0);
    expect(await getVisiblePathSize(p)).toBe(100);
  });

  it('direct hidden file root .cover.jpg (50): 50 / 0 / 50', async () => {
    const p = '/x/.cover.jpg';
    mockFs({}, { [p]: 50 });
    expect(await getPathSize(p)).toBe(50);
    expect(await getAudioPathSize(p)).toBe(0);
    expect(await getVisiblePathSize(p)).toBe(50);
  });

  it('hidden directory root .merge-tmp/ with visible children: descended (F38)', async () => {
    const staging = '/x/.merge-tmp';
    mockFs(
      { [staging]: [makeDirent('t.mp3', true, false), makeDirent('c.jpg', true, false)] },
      { [join(staging, 't.mp3')]: 42, [join(staging, 'c.jpg')]: 15 },
    );
    expect(await getPathSize(staging)).toBe(57);
    expect(await getAudioPathSize(staging)).toBe(42);
    expect(await getVisiblePathSize(staging)).toBe(57);
  });

  // Only a nested fixture proves both policy flags propagate through recursion.
  it('recursive descent forwards both policies into a nested visible subdir (F1)', async () => {
    const sub = join(ROOT, 'sub');
    const nested = join(sub, '.nested');
    mockFs(
      {
        [ROOT]: [makeDirent('top.mp3', true, false), makeDirent('sub', false, true)],
        [sub]: [
          makeDirent('deep.mp3', true, false),
          makeDirent('notes.txt', true, false),
          makeDirent('.hidden.mp3', true, false),
          makeDirent('.nested', false, true),
        ],
        [nested]: [makeDirent('buried.mp3', true, false)],
      },
      {
        [join(ROOT, 'top.mp3')]: 100,
        [join(sub, 'deep.mp3')]: 200,
        [join(sub, 'notes.txt')]: 30,
        [join(sub, '.hidden.mp3')]: 999,
        [join(nested, 'buried.mp3')]: 5000,
      },
    );
    expect(await getPathSize(ROOT)).toBe(6329);
    expect(await getAudioPathSize(ROOT)).toBe(300);
    expect(await getVisiblePathSize(ROOT)).toBe(330);
  });

  it('skips hidden children before stat/readdir — audio & visible wrappers (F40)', async () => {
    const realFile = join(ROOT, 'real.mp3');
    const hiddenFile = join(ROOT, '.tmp.mp3');
    const hiddenDir = join(ROOT, '.hidden');

    for (const fn of [getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockImplementation(async (p) => {
        const key = String(p);
        if (key === ROOT) return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
        if (key === realFile) return { isFile: () => true, size: 100 } as Stats;
        throw new Error(`ENOENT stat ${key}`);
      });
      vi.mocked(readdir).mockImplementation(async (p) => {
        if (String(p) === ROOT) {
          return [
            makeDirent('real.mp3', true, false),
            makeDirent('.tmp.mp3', true, false),
            makeDirent('.hidden', false, true),
          ] as never;
        }
        throw new Error(`ENOENT readdir ${String(p)}`);
      });

      expect(await fn(ROOT)).toBe(100);
      expect(vi.mocked(stat).mock.calls.every((c) => c[0] !== hiddenFile && c[0] !== hiddenDir)).toBe(true);
      expect(vi.mocked(readdir).mock.calls.every((c) => c[0] !== hiddenDir)).toBe(true);
    }
  });

  it('getAudioPathSize never stats a visible non-audio child', async () => {
    const realFile = join(ROOT, 'real.mp3');
    const coverFile = join(ROOT, 'cover.jpg');
    vi.mocked(stat).mockImplementation(async (p) => {
      const key = String(p);
      if (key === ROOT) return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
      if (key === realFile) return { isFile: () => true, size: 100 } as Stats;
      throw new Error(`ENOENT stat ${key}`);
    });
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('real.mp3', true, false),
      makeDirent('cover.jpg', true, false),
    ] as never);

    expect(await getAudioPathSize(ROOT)).toBe(100);
    expect(vi.mocked(stat).mock.calls.every((c) => c[0] !== coverFile)).toBe(true);
  });

  // Dirent classification must prevent stat-following symlinks and devices.
  it('ignores a non-regular child Dirent without stat/readdir — all three presets (F5)', async () => {
    const realFile = join(ROOT, 'real.mp3');
    const weird = join(ROOT, 'weird');
    for (const fn of [getPathSize, getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockImplementation(async (p) => {
        const key = String(p);
        if (key === ROOT) return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
        if (key === realFile) return { isFile: () => true, size: 100 } as Stats;
        throw new Error(`must not touch ${key}`);
      });
      vi.mocked(readdir).mockImplementation(async (p) => {
        if (String(p) === ROOT) {
          return [makeDirent('real.mp3', true, false), makeDirent('weird', false, false)] as never;
        }
        throw new Error(`must not readdir ${String(p)}`);
      });

      expect(await fn(ROOT)).toBe(100);
      expect(vi.mocked(stat).mock.calls.every((c) => c[0] !== weird)).toBe(true);
      expect(vi.mocked(readdir).mock.calls.every((c) => c[0] !== weird)).toBe(true);
    }
  });

  it('non-file root falls through to readdir and propagates its error — all three presets (F10)', async () => {
    const sentinel = new Error('ENOTDIR sentinel');
    for (const fn of [getPathSize, getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => false } as unknown as Stats);
      vi.mocked(readdir).mockRejectedValue(sentinel);
      await expect(fn(ROOT)).rejects.toBe(sentinel);
      expect(vi.mocked(readdir).mock.calls.some((c) => c[0] === ROOT)).toBe(true);
    }
  });

  it('root stat rejection propagates unchanged — all three presets', async () => {
    const sentinel = new Error('root stat sentinel');
    for (const fn of [getPathSize, getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockRejectedValue(sentinel);
      await expect(fn(ROOT)).rejects.toBe(sentinel);
    }
  });

  it('root readdir rejection (directory root) propagates unchanged — all three presets', async () => {
    const sentinel = new Error('root readdir sentinel');
    for (const fn of [getPathSize, getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as unknown as Stats);
      vi.mocked(readdir).mockRejectedValue(sentinel);
      await expect(fn(ROOT)).rejects.toBe(sentinel);
    }
  });

  it('admitted child stat rejection propagates unchanged — all three presets', async () => {
    const sentinel = new Error('child stat sentinel');
    const realFile = join(ROOT, 'real.mp3');
    for (const fn of [getPathSize, getAudioPathSize, getVisiblePathSize]) {
      vi.clearAllMocks();
      vi.mocked(stat).mockImplementation(async (p) => {
        const key = String(p);
        if (key === ROOT) return { isFile: () => false, isDirectory: () => true } as unknown as Stats;
        if (key === realFile) throw sentinel;
        throw new Error(`unexpected stat ${key}`);
      });
      vi.mocked(readdir).mockResolvedValue([makeDirent('real.mp3', true, false)] as never);
      await expect(fn(ROOT)).rejects.toBe(sentinel);
    }
  });
});

describe('containsAudioFiles', () => {
  it('returns true when directory contains audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track.mp3', true, false),
    ] as never);

    expect(await containsAudioFiles('/dir')).toBe(true);
  });

  it('returns false when directory has no audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('readme.txt', true, false),
    ] as never);

    expect(await containsAudioFiles('/dir')).toBe(false);
  });

  it('finds audio files in nested subdirectories', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('track.m4b', true, false)] as never);

    expect(await containsAudioFiles('/dir')).toBe(true);
  });
});

describe('copyAudioFiles', () => {
  it('copies only audio files from source to target', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track.mp3', true, false),
      makeDirent('cover.jpg', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(mkdir).toHaveBeenCalledWith('/dest', { recursive: true });
    expect(cp).toHaveBeenCalledTimes(1);
    expect(cp).toHaveBeenCalledWith(
      expect.stringContaining('track.mp3'),
      expect.stringContaining('track.mp3'),
      { errorOnExist: false },
    );
  });

  it('flattens single subfolder — audio files copied directly to target, not nested', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('subdir', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('audio.m4b', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(norm((mkdir as Mock).mock.calls[0]![0] as string)).toBe('/dest');
    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0]!.map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/subdir/audio.m4b');
    expect(dest).toBe('/dest/audio.m4b');
  });

  it('flattens deeply nested single-path structure (A/B/C/audio.mp3) to target root', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('A', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('B', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('C', false, true)] as never)
      .mockResolvedValueOnce([makeDirent('deep.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0]!.map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/A/B/C/deep.mp3');
    expect(dest).toBe('/dest/deep.mp3');
  });

  it('flattens multiple subfolders with uniquely-named audio files into target', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('chapter1.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('chapter2.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0]![0]).toBe('/src/Part 1/chapter1.mp3');
    expect(calls[0]![1]).toBe('/dest/chapter1.mp3');
    expect(calls[1]![0]).toBe('/src/Part 2/chapter2.mp3');
    expect(calls[1]![1]).toBe('/dest/chapter2.mp3');
  });

  it('copies audio files at root level without change (no subfolder)', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('track1.mp3', true, false),
      makeDirent('track2.mp3', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0]![0]).toBe('/src/track1.mp3');
    expect(calls[0]![1]).toBe('/dest/track1.mp3');
    expect(calls[1]![0]).toBe('/src/track2.mp3');
    expect(calls[1]![1]).toBe('/dest/track2.mp3');
  });

  it('flattens mixed content — audio at root AND in subfolders — all end up at target root', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('root.mp3', true, false),
        makeDirent('sub', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('nested.m4b', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    const calls = (cp as Mock).mock.calls.map((c: unknown[]) => c.map((a: unknown) => typeof a === 'string' ? norm(a) : a));
    expect(calls[0]![0]).toBe('/src/sub/nested.m4b');
    expect(calls[0]![1]).toBe('/dest/nested.m4b');
    expect(calls[1]![0]).toBe('/src/root.mp3');
    expect(calls[1]![1]).toBe('/dest/root.mp3');
  });

  it('skips non-audio files in subfolders during flattening', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('sub', false, true)] as never)
      .mockResolvedValueOnce([
        makeDirent('audio.mp3', true, false),
        makeDirent('notes.txt', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(1);
    const [src, dest] = (cp as Mock).mock.calls[0]!.map((a: unknown) => typeof a === 'string' ? norm(a) : a);
    expect(src).toBe('/src/sub/audio.mp3');
    expect(dest).toBe('/dest/audio.mp3');
  });

  it('skips non-audio files at root level', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('notes.txt', true, false),
      makeDirent('image.png', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).not.toHaveBeenCalled();
  });

  it('fails with error identifying conflicting filenames when flattening produces duplicate basenames', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never);

    const err = await copyAudioFiles('/src', '/dest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentFailureError);
    expect(norm((err as Error).message)).toBe(
      'Duplicate filename "01.mp3" found during import flattening: "/src/Part 1/01.mp3" and "/src/Part 2/01.mp3"',
    );
  });

  it('collision detection runs before any files are copied — no partial state on cp mock', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Part 1', false, true),
        makeDirent('Part 2', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow();

    expect(cp).not.toHaveBeenCalled();
  });

  it('copies files in alphabetical order regardless of readdir order', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('Part 2.mp3', true, false),
      makeDirent('Part 3.mp3', true, false),
      makeDirent('Part 1.mp3', true, false),
    ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(3);
    const copiedNames = (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[1] as string).split('/').pop(),
    );
    expect(copiedNames).toEqual(['Part 1.mp3', 'Part 2.mp3', 'Part 3.mp3']);
  });

  it('propagates cp error (fail-fast) — does not continue copying remaining files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('a.mp3', true, false),
      makeDirent('b.mp3', true, false),
    ] as never);
    vi.mocked(cp)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await expect(copyAudioFiles('/src', '/dest')).rejects.toThrow('disk full');

    expect(cp).toHaveBeenCalledTimes(1);
  });
});

describe('copyAudioFiles — multi-disc detection and sequential renaming', () => {
  function setupDiscLayout(discEntries: Array<[string, string[]]>, rootFiles: string[] = []) {
    const rootItems = [
      ...rootFiles.map(f => makeDirent(f, true, false)),
      ...discEntries.map(([name]) => makeDirent(name, false, true)),
    ];
    vi.mocked(readdir)
      .mockResolvedValueOnce(rootItems as never);

    for (const [, files] of discEntries) {
      vi.mocked(readdir).mockResolvedValueOnce(
        files.map(f => makeDirent(f, true, false)) as never,
      );
    }
  }

  function getCopiedDestNames(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[1] as string).split('/').pop()!,
    );
  }

  function getCopiedSrcPaths(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[0] as string),
    );
  }

  it('detects disc subfolders (Disc 01, Disc 02) and copies files with sequential names', async () => {
    setupDiscLayout([
      ['Disc 01', ['01.mp3', '02.mp3']],
      ['Disc 02', ['01.mp3', '02.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(4);
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3']);
  });

  it('sorts discs naturally — Disc 2 before Disc 10', async () => {
    setupDiscLayout([
      ['Disc 10', ['a.mp3']],
      ['Disc 2', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 2');
    expect(srcPaths[1]).toContain('Disc 10');
  });

  it('orders tracks within each disc alphabetically by filename', async () => {
    setupDiscLayout([
      ['Disc 01', ['03 - Third.mp3', '01 - First.mp3', '02 - Second.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('01 - First.mp3');
    expect(srcPaths[1]).toContain('02 - Second.mp3');
    expect(srcPaths[2]).toContain('03 - Third.mp3');
  });

  it('orders unpadded tracks within each disc numerically — Track2 before Track10 (#1192)', async () => {
    setupDiscLayout([
      ['Disc 01', ['Track10.mp3', 'Track2.mp3', 'Track1.mp3']],
      ['Disc 02', ['Track2.mp3', 'Track1.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]!.split('\\').join('/')).toBe('/src/Disc 01/Track1.mp3');
    expect(srcPaths[1]!.split('\\').join('/')).toBe('/src/Disc 01/Track2.mp3');
    expect(srcPaths[2]!.split('\\').join('/')).toBe('/src/Disc 01/Track10.mp3');
    expect(srcPaths[3]!.split('\\').join('/')).toBe('/src/Disc 02/Track1.mp3');
    expect(srcPaths[4]!.split('\\').join('/')).toBe('/src/Disc 02/Track2.mp3');
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3']);
  });

  it('keeps padded multi-disc sources correctly ordered (no regression)', async () => {
    setupDiscLayout([
      ['Disc 01', ['003.mp3', '001.mp3', '002.mp3']],
      ['Disc 02', ['001.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('001.mp3');
    expect(srcPaths[1]).toContain('002.mp3');
    expect(srcPaths[2]).toContain('003.mp3');
  });

  it('handles common disc patterns: CD 1, Disk 2, disc01, DISC 004, cd1', async () => {
    for (const discName of ['CD 1', 'Disk 2', 'disc01', 'DISC 004', 'cd1']) {
      vi.clearAllMocks();
      vi.mocked(readdir)
        .mockResolvedValueOnce([makeDirent(discName, false, true)] as never)
        .mockResolvedValueOnce([makeDirent('track.mp3', true, false)] as never);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects non-disc folders — does not treat Extras, Part 1, 01 - Chapter One as disc folders', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Extras', false, true),
        makeDirent('Part 1', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('bonus.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('chapter.mp3', true, false)] as never);

    await copyAudioFiles('/src', '/dest');

    const destNames = getCopiedDestNames();
    expect(destNames).toContain('bonus.mp3');
    expect(destNames).toContain('chapter.mp3');
  });

  it('single disc subfolder — no sequential renaming', async () => {
    setupDiscLayout([
      ['Disc 01', ['track1.mp3', 'track2.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const destNames = getCopiedDestNames();
    expect(destNames).toEqual(['track1.mp3', 'track2.mp3']);
  });

  it('two discs with 1 track each — output is 1.mp3, 2.mp3', async () => {
    setupDiscLayout([
      ['Disc 01', ['track.mp3']],
      ['Disc 02', ['track.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('zero-pads sequential names when 10+ tracks (2-digit padding)', async () => {
    setupDiscLayout([
      ['Disc 01', ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3']],
      ['Disc 02', ['g.mp3', 'h.mp3', 'i.mp3', 'j.mp3', 'k.mp3', 'l.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(12);
    const destNames = getCopiedDestNames();
    expect(destNames[0]).toBe('01.mp3');
    expect(destNames[9]).toBe('10.mp3');
    expect(destNames[11]).toBe('12.mp3');
  });

  it('track numbering boundary — Disc 1 has 3 tracks, Disc 2 starts at 4', async () => {
    setupDiscLayout([
      ['Disc 01', ['a.mp3', 'b.mp3', 'c.mp3']],
      ['Disc 02', ['x.mp3', 'y.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3']);
  });

  it('zero-padded disc numbers (Disc 01) and unpadded (Disc 1) both detected and sorted correctly', async () => {
    setupDiscLayout([
      ['Disc 1', ['a.mp3']],
      ['Disc 02', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 1');
    expect(srcPaths[1]).toContain('Disc 02');
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('non-audio files in disc subfolders (cover.jpg, .cue) are ignored', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('Disc 01', false, true)] as never)
      .mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('cover.jpg', true, false),
        makeDirent('disc.cue', true, false),
      ] as never);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(1);
    expect(getCopiedDestNames()).toEqual(['track.mp3']);
  });

  it('non-disc subfolders mixed with disc subfolders — non-disc content recursively flattened', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
        makeDirent('Extras', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 02
      .mockResolvedValueOnce([makeDirent('bonus.mp3', true, false)] as never); // Extras

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(3);
    const destNames = getCopiedDestNames();
    expect(destNames).toContain('bonus.mp3');
    expect(destNames).toContain('1.mp3');
    expect(destNames).toContain('2.mp3');
  });

  it('errors when non-disc file name collides with sequential disc numbering', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
        makeDirent('Extras', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('a.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('b.mp3', true, false)] as never) // Disc 02
      .mockResolvedValueOnce([makeDirent('1.mp3', true, false)] as never); // Extras — collides with sequential "1.mp3"

    const err = await copyAudioFiles('/src', '/dest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentFailureError);
    expect(norm((err as Error).message)).toBe(
      'Duplicate filename "1.mp3" found during import flattening: non-disc file "/src/Extras/1.mp3" collides with sequential disc numbering',
    );
    expect(cp).not.toHaveBeenCalled();
  });

  it('duplicate filenames within the SAME disc still error', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
      ] as never)
      .mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('track.mp3', true, false),
      ] as never)
      .mockResolvedValueOnce([makeDirent('other.mp3', true, false)] as never);

    // Sequential renaming makes duplicate source basenames safe within a disc.
    await copyAudioFiles('/src', '/dest');
    expect(cp).toHaveBeenCalledTimes(3);
  });

  it('errors when non-disc subfolders produce duplicate basenames (Extras/cover.mp3 + Bonus/cover.mp3)', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
        makeDirent('Extras', false, true),
        makeDirent('Bonus', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('02.mp3', true, false)] as never) // Disc 02
      .mockResolvedValueOnce([makeDirent('cover.mp3', true, false)] as never) // Extras
      .mockResolvedValueOnce([makeDirent('cover.mp3', true, false)] as never); // Bonus

    const err = await copyAudioFiles('/src', '/dest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentFailureError);
    expect(norm((err as Error).message)).toBe(
      'Duplicate filename "cover.mp3" found during import flattening: "/src/Extras/cover.mp3" and "/src/Bonus/cover.mp3"',
    );
    expect(cp).not.toHaveBeenCalled();
  });

  it('disc subfolders with mixed naming patterns (CD 1, Disc 02) all detected', async () => {
    setupDiscLayout([
      ['CD 1', ['a.mp3']],
      ['Disc 02', ['b.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('sorts mixed-prefix disc folders by disc number — CD 10 after Disc 2', async () => {
    setupDiscLayout([
      ['CD 10', ['ten.mp3']],
      ['Disc 2', ['two.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 2');
    expect(srcPaths[1]).toContain('CD 10');
  });

  it('loose audio files at root alongside disc subfolders — loose files ordered before disc files', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('root_track.mp3', true, false),
        makeDirent('Disc 01', false, true),
        makeDirent('Disc 02', false, true),
      ] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never) // Disc 01
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never); // Disc 02

    await copyAudioFiles('/src', '/dest');

    const destNames = getCopiedDestNames();
    expect(destNames).toEqual(['root_track.mp3', '1.mp3', '2.mp3']);
  });

  it('detects embedded "Disc N of M" source subfolders and flattens without a basename collision', async () => {
    setupDiscLayout([
      ['2005 Non Fiction David McCullough - 1776 Disc 1 of 10 - File ~ of 28 - yEnc', ['01.mp3']],
      ['2005 Non Fiction David McCullough - 1776 Disc 2 of 10 - File ~ of 28 - yEnc', ['01.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(cp).toHaveBeenCalledTimes(2);
    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('detects embedded "CD NN of M" source subfolders', async () => {
    setupDiscLayout([
      ['Stephen King - It CD 01 of 03', ['01.mp3']],
      ['Stephen King - It CD 02 of 03', ['01.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
  });

  it('sorts embedded-marker discs by parsed disc number — shared parser with discovery', async () => {
    // These match only the embedded grammar, so ordering proves shared-parser use.
    setupDiscLayout([
      ['Author - Long Book Disc 10 of 10', ['ten.mp3']],
      ['Author - Long Book Disc 2 of 10', ['two.mp3']],
    ]);

    await copyAudioFiles('/src', '/dest');

    const srcPaths = getCopiedSrcPaths();
    expect(srcPaths[0]).toContain('Disc 2 of 10');
    expect(srcPaths[1]).toContain('Disc 10 of 10');
  });
});

describe('reconstructDiscGroup', () => {
  // Mock readdir: same-module containsAudioFiles calls cannot be intercepted.
  type TreeEntry = { name: string; isFile: boolean; reject?: boolean };
  // Normalize lookup keys because node:path emits backslashes on Windows.
  const norm = (paths: string[]): string[] => paths.map(p => p.split('\\').join('/'));
  function setupTree(tree: Record<string, TreeEntry[]>) {
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      const key = String(p).split('\\').join('/');
      const entries = tree[key];
      if (!entries) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      if (entries.some(e => e.reject)) {
        throw Object.assign(new Error(`EACCES: ${key}`), { code: 'EACCES' });
      }
      return entries.map(e => makeDirent(e.name, e.isFile, !e.isFile)) as never;
    });
  }

  function discTree(
    parent: string,
    stem: string,
    count: number,
    total: number,
    extras: Record<string, TreeEntry[]> = {},
  ): { tree: Record<string, TreeEntry[]>; discPaths: string[] } {
    const discNames = Array.from({ length: count }, (_, i) => `${stem} Disc ${i + 1} of ${total}`);
    const extraNames = Object.keys(extras).map(p => p.slice(parent.length + 1));
    const tree: Record<string, TreeEntry[]> = {
      [parent]: [
        ...discNames.map(n => ({ name: n, isFile: false })),
        ...extraNames.map(n => ({ name: n, isFile: false })),
      ],
    };
    for (const n of discNames) tree[`${parent}/${n}`] = [{ name: 'track.mp3', isFile: true }];
    Object.assign(tree, extras);
    return { tree, discPaths: discNames.map(n => `${parent}/${n}`) };
  }

  it('returns [path] for a non-disc folder without touching the filesystem', async () => {
    const result = await reconstructDiscGroup('/lib/Author/Book Title');
    expect(result).toEqual(['/lib/Author/Book Title']);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('reconstructs the ordered member set from sibling disc folders', async () => {
    const { tree, discPaths } = discTree('/downloads', 'Author - Book', 3, 3);
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/Author - Book Disc 1 of 3');

    expect(norm(result)).toEqual(discPaths);
  });

  it('filters to siblings sharing the stem — ignores a different group under the same parent', async () => {
    const tree: Record<string, TreeEntry[]> = {
      '/downloads': [
        { name: '1776 Disc 1 of 2', isFile: false },
        { name: '1776 Disc 2 of 2', isFile: false },
        { name: 'Slaughterhouse Disc 1 of 2', isFile: false },
        { name: 'Slaughterhouse Disc 2 of 2', isFile: false },
      ],
      '/downloads/1776 Disc 1 of 2': [{ name: 'a.mp3', isFile: true }],
      '/downloads/1776 Disc 2 of 2': [{ name: 'a.mp3', isFile: true }],
      '/downloads/Slaughterhouse Disc 1 of 2': [{ name: 'a.mp3', isFile: true }],
      '/downloads/Slaughterhouse Disc 2 of 2': [{ name: 'a.mp3', isFile: true }],
    };
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/1776 Disc 1 of 2');

    expect(norm(result)).toEqual(['/downloads/1776 Disc 1 of 2', '/downloads/1776 Disc 2 of 2']);
  });

  // Membership cannot prove the hidden guard because stem mismatch also excludes it; assert no probe.
  it('#1852 F7: never probes (readdir) a hidden audio-bearing sibling subtree', async () => {
    const hiddenSibling = '/downloads/.Author - Book Disc 2 of 3';
    const tree: Record<string, TreeEntry[]> = {
      '/downloads': [
        { name: 'Author - Book Disc 1 of 3', isFile: false },
        { name: 'Author - Book Disc 2 of 3', isFile: false },
        { name: 'Author - Book Disc 3 of 3', isFile: false },
        { name: '.Author - Book Disc 2 of 3', isFile: false },
      ],
      '/downloads/Author - Book Disc 1 of 3': [{ name: 'a.mp3', isFile: true }],
      '/downloads/Author - Book Disc 2 of 3': [{ name: 'a.mp3', isFile: true }],
      '/downloads/Author - Book Disc 3 of 3': [{ name: 'a.mp3', isFile: true }],
      [hiddenSibling]: [{ name: 'a.mp3', isFile: true }],
    };
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/Author - Book Disc 1 of 3');

    expect(norm(result)).toEqual([
      '/downloads/Author - Book Disc 1 of 3',
      '/downloads/Author - Book Disc 2 of 3',
      '/downloads/Author - Book Disc 3 of 3',
    ]);
    const probed = vi.mocked(readdir).mock.calls.map(c => String(c[0]).split('\\').join('/'));
    expect(probed).toContain('/downloads/Author - Book Disc 2 of 3');
    expect(probed).not.toContain(hiddenSibling);
  });

  it('does NOT reconstruct a set with inconsistent "of M" totals (mirrors discovery guard)', async () => {
    const tree: Record<string, TreeEntry[]> = {
      '/downloads': [
        { name: 'Author - Book Disc 1 of 10', isFile: false },
        { name: 'Author - Book Disc 2 of 8', isFile: false },
      ],
      '/downloads/Author - Book Disc 1 of 10': [{ name: 'a.mp3', isFile: true }],
      '/downloads/Author - Book Disc 2 of 8': [{ name: 'a.mp3', isFile: true }],
    };
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/Author - Book Disc 1 of 10');

    expect(norm(result)).toEqual(['/downloads/Author - Book Disc 1 of 10']);
  });

  it('does NOT reconstruct when an AUDIO-bearing markerless sibling shares the stem (all-or-nothing)', async () => {
    const { tree } = discTree('/downloads', 'Author - Book', 2, 3, {
      '/downloads/Author - Book Bonus Material': [{ name: 'extra.mp3', isFile: true }],
    });
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/Author - Book Disc 1 of 3');

    expect(norm(result)).toEqual(['/downloads/Author - Book Disc 1 of 3']);
  });

  it('reconstructs the FULL N-disc set despite an audioless markerless stem-sharing sibling (#1280)', async () => {
    const { tree, discPaths } = discTree('/downloads', '1776', 10, 10, {
      '/downloads/1776 Artwork': [{ name: 'cover.jpg', isFile: true }, { name: 'info.nfo', isFile: true }],
    });
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/1776 Disc 1 of 10');

    expect(norm(result)).toEqual(discPaths);
    expect(result).toHaveLength(10);
    expect(norm(result)).not.toContain('/downloads/1776 Artwork');
  });

  it('returns the full set with NO audioless sibling present (happy-path control)', async () => {
    const { tree, discPaths } = discTree('/downloads', '1776', 10, 10);
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/1776 Disc 1 of 10');

    expect(norm(result)).toEqual(discPaths);
  });

  it('excludes a marker-carrying AUDIOLESS sibling from the member set (members are audio-bearing dirs only)', async () => {
    const { tree, discPaths } = discTree('/downloads', '1776', 10, 10, {
      '/downloads/1776 Disc 11 of 10': [{ name: 'liner-notes.pdf', isFile: true }],
    });
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/1776 Disc 1 of 10');

    expect(norm(result)).toEqual(discPaths);
    expect(norm(result)).not.toContain('/downloads/1776 Disc 11 of 10');
  });

  it('reconstructs ALL members of an incomplete N-of-M set unchanged — import is never blocked (#1282)', async () => {
    // Missing discs are a discovery warning, not an import veto.
    const { tree, discPaths } = discTree('/downloads', 'Author - Book', 8, 10);
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/Author - Book Disc 1 of 10');

    expect(norm(result)).toEqual(discPaths);
    expect(result).toHaveLength(8);
  });

  it('treats an unreadable audioless sibling as zero-audio (mirrors discovery scanDir)', async () => {
    const { tree, discPaths } = discTree('/downloads', '1776', 10, 10, {
      '/downloads/1776 Artwork': [{ name: 'x', isFile: true, reject: true }],
    });
    setupTree(tree);

    const result = await reconstructDiscGroup('/downloads/1776 Disc 1 of 10');

    expect(norm(result)).toEqual(discPaths);
  });
});

describe('copyDiscGroup', () => {
  it('flattens an ordered member-disc set into target with sequential renaming', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never)
      .mockResolvedValueOnce([makeDirent('01.mp3', true, false)] as never);

    await copyDiscGroup(
      ['/downloads/Author - Book Disc 1 of 2', '/downloads/Author - Book Disc 2 of 2'],
      '/dest',
    );

    expect(cp).toHaveBeenCalledTimes(2);
    const destNames = (cp as Mock).mock.calls.map((c: unknown[]) => norm(c[1] as string).split('/').pop());
    expect(destNames).toEqual(['1.mp3', '2.mp3']);
  });
});

describe('countAudioFiles', () => {
  it('counts audio files in a flat directory', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('a.mp3', true, false),
      makeDirent('b.m4b', true, false),
      makeDirent('c.txt', true, false),
    ] as never);

    expect(await countAudioFiles('/dir')).toBe(2);
  });

  it('counts audio files recursively in nested directories', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        makeDirent('a.mp3', true, false),
        makeDirent('sub', false, true),
      ] as never)
      .mockResolvedValueOnce([
        makeDirent('b.flac', true, false),
      ] as never);

    expect(await countAudioFiles('/dir')).toBe(2);
  });

  it('returns 0 for directory with no audio files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      makeDirent('readme.txt', true, false),
    ] as never);

    expect(await countAudioFiles('/dir')).toBe(0);
  });
});

describe('buildTargetPath — first-by-position author/narrator tokens (#71)', () => {
  it('two authors → {author} token resolves to authors[0].name (position=0)', () => {
    const result = buildTargetPath('/library', '{author}/{title}', { title: 'The Way of Kings', narrators: null }, 'Brandon Sanderson');
    expect(result).toBe('/library/Brandon Sanderson/The Way of Kings');
  });

  it('two narrators → {narrator} token resolves to narrators[0].name (position=0)', () => {
    const result = buildTargetPath('/library', '{narrator}/{title}', {
      title: 'The Way of Kings',
      narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
    }, 'Brandon Sanderson');
    expect(result).toBe('/library/Michael Kramer/The Way of Kings');
  });

  it('empty narrators array → {narrator} token is omitted (undefined)', () => {
    const result = buildTargetPath('/library', '{narrator}/{title}', {
      title: 'The Way of Kings',
      narrators: [],
    }, 'Brandon Sanderson');
    expect(result).toBe('/library/The Way of Kings');
  });

  it('{authorLastFirst} formats passed authorName; {narratorLastFirst} uses position-0 narrator only (not all narrators joined)', () => {
    const result = buildTargetPath(
      '/library',
      '{authorLastFirst}/{narratorLastFirst}/{title}',
      {
        title: 'The Way of Kings',
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
      },
      'Brandon Sanderson',
    );
    expect(result).toBe('/library/Sanderson, Brandon/Kramer, Michael/The Way of Kings');
  });
});

describe('titled-disc import flattening (issue #426)', () => {
  function setupDiscLayout(discEntries: Array<[string, string[]]>, rootFiles: string[] = []) {
    const rootItems = [
      ...rootFiles.map(f => makeDirent(f, true, false)),
      ...discEntries.map(([name]) => makeDirent(name, false, true)),
    ];
    vi.mocked(readdir).mockResolvedValueOnce(rootItems as never);
    for (const [, files] of discEntries) {
      vi.mocked(readdir).mockResolvedValueOnce(
        files.map(f => makeDirent(f, true, false)) as never,
      );
    }
  }

  function getCopiedDestNames(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[1] as string).split('/').pop()!,
    );
  }

  function getCopiedSrcPaths(): string[] {
    return (cp as Mock).mock.calls.map(
      (c: unknown[]) => norm(c[0] as string),
    );
  }

  describe('copyAudioFiles with titled-disc folders', () => {
    it('sequentially flattens titled-disc folders with duplicate basenames', async () => {
      setupDiscLayout([
        ['BookTitle (Disc 01)', ['01.mp3', '02.mp3']],
        ['BookTitle (Disc 02)', ['01.mp3', '02.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(4);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3']);
    });

    it('extracts disc number from parenthetical suffix, not title digits', async () => {
      setupDiscLayout([
        ['Book 99 (Disc 02)', ['track.mp3']],
        ['Book 99 (Disc 01)', ['track.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      const srcPaths = getCopiedSrcPaths();
      expect(srcPaths[0]).toContain('Disc 01');
      expect(srcPaths[1]).toContain('Disc 02');
    });

    it('flattens N-of-M titled folders in correct order', async () => {
      setupDiscLayout([
        ['BookTitle (3 of 3)', ['01.mp3']],
        ['BookTitle (1 of 3)', ['01.mp3']],
        ['BookTitle (2 of 3)', ['01.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      const srcPaths = getCopiedSrcPaths();
      expect(srcPaths[0]).toContain('1 of 3');
      expect(srcPaths[1]).toContain('2 of 3');
      expect(srcPaths[2]).toContain('3 of 3');
    });

    it('handles mixed bare + titled disc folders in same directory', async () => {
      setupDiscLayout([
        ['CD1', ['track.mp3']],
        ['BookTitle (Disc 02)', ['track.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(2);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
    });

    it('handles titled-disc folders with non-disc sibling', async () => {
      setupDiscLayout([
        ['BookTitle (Disc 01)', ['01.mp3']],
        ['BookTitle (Disc 02)', ['01.mp3']],
        ['Bonus', ['bonus.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(3);
      const destNames = getCopiedDestNames();
      expect(destNames).toContain('bonus.mp3');
    });

    it('sorts scrambled disc numbers correctly', async () => {
      setupDiscLayout([
        ['BookTitle (Disc 03)', ['01.mp3']],
        ['BookTitle (Disc 01)', ['01.mp3']],
        ['BookTitle (Disc 02)', ['01.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      const srcPaths = getCopiedSrcPaths();
      expect(srcPaths[0]).toContain('Disc 01');
      expect(srcPaths[1]).toContain('Disc 02');
      expect(srcPaths[2]).toContain('Disc 03');
    });

    it('handles duplicate disc numbers — both copied without crash', async () => {
      setupDiscLayout([
        ['BookTitle (Disc 01)', ['track.mp3']],
        ['BookTitle (Disc 01)', ['track.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(2);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
    });

    it('handles "Disk" spelling variant in import flattening', async () => {
      setupDiscLayout([
        ['BookTitle (Disk 01)', ['track.mp3']],
        ['BookTitle (Disk 02)', ['track.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(2);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
    });
  });

  describe('copyAudioFiles regression — bare disc folders', () => {
    it('still sequentially renames bare disc folders (CD1, Disc 2)', async () => {
      setupDiscLayout([
        ['CD1', ['01.mp3', '02.mp3']],
        ['Disc 2', ['01.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(3);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3']);
    });
  });

  describe('D-alias disc detection (#1164)', () => {
    it('sequentially flattens D1/D2 titled-disc folders — Shakespeare for Squirrels regression', async () => {
      setupDiscLayout([
        ['Shakespeare for Squirrels (D1)', ['Track01.mp3', 'Track02.mp3']],
        ['Shakespeare for Squirrels (D2)', ['Track01.mp3', 'Track02.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(4);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3', '4.mp3']);
      const srcPaths = getCopiedSrcPaths();
      expect(srcPaths[0]).toContain('(D1)');
      expect(srcPaths[2]).toContain('(D2)');
    });

    it('sequentially flattens bare D1/D2 folders', async () => {
      setupDiscLayout([
        ['D1', ['01.mp3', '02.mp3']],
        ['D2', ['01.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(3);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3', '3.mp3']);
    });

    it('handles mixed D-alias and CD prefix (D1 + CD2)', async () => {
      setupDiscLayout([
        ['D1', ['track.mp3']],
        ['CD2', ['track.mp3']],
      ]);

      await copyAudioFiles('/src', '/dest');

      expect(cp).toHaveBeenCalledTimes(2);
      expect(getCopiedDestNames()).toEqual(['1.mp3', '2.mp3']);
    });
  });
});

