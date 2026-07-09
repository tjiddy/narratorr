import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { AUDIO_EXTENSIONS, isHiddenName } from './audio-constants.js';
import { collectAudioFilePaths, collectSortedAudioFiles, compareAudioNames, disambiguateStems } from './collect-audio-files.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

const { readdir } = await import('node:fs/promises');
const mockReaddir = vi.mocked(readdir);

function makeDirent(name: string, isFile: boolean, isDirectory: boolean) {
  return { name, isFile: () => isFile, isDirectory: () => isDirectory } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('collectAudioFilePaths', () => {
  describe('core behavior', () => {
    it('returns audio file paths for a flat directory with mixed file types', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track1.mp3', true, false),
        makeDirent('readme.txt', true, false),
        makeDirent('track2.m4b', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/books/mybook');

      expect(result).toEqual(expect.arrayContaining([
        join('/books/mybook', 'track1.mp3'),
        join('/books/mybook', 'track2.m4b'),
      ]));
      expect(result).toHaveLength(2);
    });

    it('filters by default AUDIO_EXTENSIONS when no extensions option provided', async () => {
      const audioEntries = [...AUDIO_EXTENSIONS].map(ext =>
        makeDirent(`file${ext}`, true, false),
      );
      mockReaddir.mockResolvedValueOnce(audioEntries as never);

      const result = await collectAudioFilePaths('/dir');

      expect(result).toHaveLength(AUDIO_EXTENSIONS.size);
    });

    it('filters by custom extension set when provided', async () => {
      const customExtensions = new Set(['.mp3', '.m4a']);
      mockReaddir.mockResolvedValueOnce([
        makeDirent('a.mp3', true, false),
        makeDirent('b.flac', true, false),
        makeDirent('c.m4a', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/dir', { extensions: customExtensions });

      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([
        join('/dir', 'a.mp3'),
        join('/dir', 'c.m4a'),
      ]));
    });

    it('returns empty array for empty directory', async () => {
      mockReaddir.mockResolvedValueOnce([] as never);

      const result = await collectAudioFilePaths('/empty');

      expect(result).toEqual([]);
    });

    it('returns empty array for directory with no matching audio files', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('readme.md', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/noaudio');

      expect(result).toEqual([]);
    });
  });

  describe('recursive mode', () => {
    it('descends into subdirectories and returns nested audio file paths', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('track1.mp3', true, false),
          makeDirent('disc1', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track2.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/books/mybook', { recursive: true });

      expect(result).toEqual(expect.arrayContaining([
        join('/books/mybook', 'track1.mp3'),
        join('/books/mybook', 'disc1', 'track2.mp3'),
      ]));
      expect(result).toHaveLength(2);
    });

    it('returns files from all levels of nesting', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('level1', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('level2', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('deep.flac', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/root', { recursive: true });

      expect(result).toEqual([join('/root', 'level1', 'level2', 'deep.flac')]);
    });
  });

  describe('hidden directory skipping', () => {
    it('skips entries starting with . when skipHidden is true', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('.hidden', false, true),
          makeDirent('visible', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/dir', { recursive: true, skipHidden: true });

      expect(result).toEqual([join('/dir', 'visible', 'track.mp3')]);
      expect(mockReaddir).toHaveBeenCalledTimes(2); // root + visible only
    });

    it('includes hidden entries when skipHidden is false (default)', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('.hidden', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/dir', { recursive: true });

      expect(result).toEqual([join('/dir', '.hidden', 'track.mp3')]);
    });
  });

  describe('non-recursive mode (default)', () => {
    it('returns only direct children, ignoring subdirectories', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('subdir', false, true),
      ] as never);

      const result = await collectAudioFilePaths('/dir');

      expect(result).toEqual([join('/dir', 'track.mp3')]);
      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });
  });

  // #1852 AC2: dot-FILES are never collected, regardless of skipHidden (which gates only
  // directory recursion). Independent of the dot-DIRECTORY skip above.
  describe('hidden file skipping (#1852)', () => {
    it('excludes a born-hidden temp file but keeps the real file (non-recursive)', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('real.mp3', true, false),
        makeDirent('.real.tmp.mp3', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/dir');
      expect(result).toEqual([join('/dir', 'real.mp3')]);
    });

    it('excludes dot-files even when skipHidden is false (recursive, dot-file inside a dot-dir)', async () => {
      mockReaddir
        .mockResolvedValueOnce([makeDirent('.merge-tmp', false, true)] as never)
        .mockResolvedValueOnce([
          makeDirent('track.mp3', true, false),   // visible file inside the dot-dir → still collected under default
          makeDirent('.stray.tmp.mp3', true, false), // dot-file → dropped by the file-level rule
        ] as never);

      const result = await collectAudioFilePaths('/dir', { recursive: true });
      expect(result).toEqual([join('/dir', '.merge-tmp', 'track.mp3')]);
    });

    it('keeps an interior-dot name like My.Book.mp3', async () => {
      mockReaddir.mockResolvedValueOnce([makeDirent('My.Book.mp3', true, false)] as never);
      expect(await collectAudioFilePaths('/dir')).toEqual([join('/dir', 'My.Book.mp3')]);
    });

    it('custom extension set (AC4): collects a.xyz, excludes hidden .a.xyz', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('a.xyz', true, false),
        makeDirent('.a.xyz', true, false),
        makeDirent('b.mp3', true, false), // not in the custom set → excluded
      ] as never);

      const result = await collectAudioFilePaths('/dir', { extensions: new Set(['.xyz']) });
      expect(result).toEqual([join('/dir', 'a.xyz')]);
    });

    it('identity root (F38): a hidden dir passed as the root still yields its visible children', async () => {
      // The root basename is never self-filtered — only DISCOVERED children are.
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('.half.tmp.mp3', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/x/.merge-tmp', { recursive: true, skipHidden: true });
      expect(result).toEqual([join('/x/.merge-tmp', 'track.mp3')]);
    });
  });
});

describe('isHiddenName (#1852)', () => {
  it('is true only for a leading-dot basename', () => {
    expect(isHiddenName('.x.mp3')).toBe(true);
    expect(isHiddenName('.merge-tmp')).toBe(true);
    expect(isHiddenName('x.mp3')).toBe(false);
    expect(isHiddenName('My.Book.mp3')).toBe(false);
  });
});

describe('collectSortedAudioFiles', () => {
  describe('locale-numeric sort (default)', () => {
    it('sorts by basename with locale-aware numeric ordering', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track10.mp3', true, false),
        makeDirent('track2.mp3', true, false),
        makeDirent('track1.mp3', true, false),
      ] as never);

      const result = await collectSortedAudioFiles('/dir');

      expect(result).toEqual([
        join('/dir', 'track1.mp3'),
        join('/dir', 'track2.mp3'),
        join('/dir', 'track10.mp3'),
      ]);
    });
  });

  describe('lexicographic sort', () => {
    it('sorts by full path using default JS string comparison', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track10.mp3', true, false),
        makeDirent('track2.mp3', true, false),
        makeDirent('track1.mp3', true, false),
      ] as never);

      const result = await collectSortedAudioFiles('/dir', { sort: 'lexicographic' });

      // Lexicographic: "track10" < "track2" because '1' < '2'
      expect(result).toEqual([
        join('/dir', 'track1.mp3'),
        join('/dir', 'track10.mp3'),
        join('/dir', 'track2.mp3'),
      ]);
    });
  });

  describe('locale sort (no numeric)', () => {
    it('sorts by basename with locale compare but without numeric awareness', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track10.mp3', true, false),
        makeDirent('track2.mp3', true, false),
        makeDirent('track1.mp3', true, false),
      ] as never);

      const result = await collectSortedAudioFiles('/dir', { sort: 'locale' });

      // Locale without numeric: "track10" < "track2" because '1' < '2'
      expect(result).toEqual([
        join('/dir', 'track1.mp3'),
        join('/dir', 'track10.mp3'),
        join('/dir', 'track2.mp3'),
      ]);
    });
  });

  it('passes recursive option through to collectAudioFilePaths', async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirent('sub', false, true),
      ] as never)
      .mockResolvedValueOnce([
        makeDirent('nested.mp3', true, false),
      ] as never);

    const result = await collectSortedAudioFiles('/dir', { recursive: true });

    expect(result).toEqual([join('/dir', 'sub', 'nested.mp3')]);
    expect(mockReaddir).toHaveBeenCalledTimes(2);
  });

  it('passes custom extensions option through to collectAudioFilePaths', async () => {
    const customExtensions = new Set(['.mp3']);
    mockReaddir.mockResolvedValueOnce([
      makeDirent('a.mp3', true, false),
      makeDirent('b.flac', true, false),
    ] as never);

    const result = await collectSortedAudioFiles('/dir', { extensions: customExtensions });

    expect(result).toEqual([join('/dir', 'a.mp3')]);
  });

  it('returns empty array for empty directory', async () => {
    mockReaddir.mockResolvedValueOnce([] as never);

    const result = await collectSortedAudioFiles('/dir');

    expect(result).toEqual([]);
  });
});

describe('compareAudioNames', () => {
  it('orders zero-padded names numerically (001 < 010 < 100)', () => {
    const sorted = ['100.mp3', '010.mp3', '001.mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['001.mp3', '010.mp3', '100.mp3']);
  });

  it('orders unpadded track names numerically, not lexicographically (Track2 < Track10)', () => {
    const sorted = ['Track10.mp3', 'Track2.mp3', 'Track1.mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['Track1.mp3', 'Track2.mp3', 'Track10.mp3']);
  });

  it('orders parenthesized suffixes numerically ((2) < (10) < (100)), not by char code', () => {
    const sorted = ['Title (100).mp3', 'Title (10).mp3', 'Title (2).mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['Title (2).mp3', 'Title (10).mp3', 'Title (100).mp3']);
  });

  it('compares on basename, ignoring directory components', () => {
    expect(compareAudioNames('/a/b/Track2.mp3', '/z/Track10.mp3')).toBeLessThan(0);
  });

  it('sorts the bare file first, before its (N) duplicate copies', () => {
    const sorted = ['X (2).mp3', 'X.mp3', 'X (10).mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['X.mp3', 'X (2).mp3', 'X (10).mp3']);
  });

  it('orders (N) duplicate copies numerically ((2) < (10) < (32))', () => {
    const sorted = ['X (32).mp3', 'X (10).mp3', 'X (2).mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['X (2).mp3', 'X (10).mp3', 'X (32).mp3']);
  });

  it('sorts the real 32-file "The Heroes" set bare → (2) → … → (32)', () => {
    const names = [
      'The Heroes (32).mp3',
      'The Heroes.mp3',
      ...Array.from({ length: 30 }, (_, i) => `The Heroes (${i + 2}).mp3`),
    ];
    const sorted = [...names].sort(compareAudioNames);
    const expected = [
      'The Heroes.mp3',
      ...Array.from({ length: 31 }, (_, i) => `The Heroes (${i + 2}).mp3`),
    ];
    expect(sorted).toEqual(expected);
  });

  it('orders mixed extensions by stem then index (Title.m4b before Title (2).mp3)', () => {
    const sorted = ['Title (2).mp3', 'Title.m4b'].sort(compareAudioNames);
    expect(sorted).toEqual(['Title.m4b', 'Title (2).mp3']);
  });

  it('tertiary tie-break: same stem + index, different extension orders deterministically', () => {
    expect(compareAudioNames('Title.mp3', 'Title.m4b')).not.toBe(0);
    expect(['Title.mp3', 'Title.m4b'].sort(compareAudioNames)).toEqual(['Title.m4b', 'Title.mp3']);
    expect(compareAudioNames('Title (2).mp3', 'Title (2).m4b')).not.toBe(0);
    expect(['Title (2).mp3', 'Title (2).m4b'].sort(compareAudioNames)).toEqual([
      'Title (2).m4b',
      'Title (2).mp3',
    ]);
  });

  it('final tie-break: case-only distinct basenames never collapse to 0', () => {
    expect(compareAudioNames('Title.mp3', 'title.mp3')).not.toBe(0);
    expect(['title.mp3', 'Title.mp3'].sort(compareAudioNames)).toEqual(
      ['Title.mp3', 'title.mp3'].sort(compareAudioNames),
    );
    expect(compareAudioNames('Tïtle.mp3', 'Title.mp3')).not.toBe(0);
  });

  it('treats a year-style suffix as a numeric index (no special-case, no regression)', () => {
    const sorted = ['Foo (1980).mp3', 'Foo (1975).mp3', 'Foo (1976).mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['Foo (1975).mp3', 'Foo (1976).mp3', 'Foo (1980).mp3']);
  });

  it('range-style suffix does not match the marker and falls through to locale-numeric', () => {
    const sorted = ['Part (10 of 5).mp3', 'Part (2 of 5).mp3'].sort(compareAudioNames);
    expect(sorted).toEqual(['Part (2 of 5).mp3', 'Part (10 of 5).mp3']);
  });

  it('is a deterministic, idempotent, antisymmetric total order', () => {
    const shuffled = [
      'X (10).mp3',
      'X.mp3',
      'Title.m4b',
      'X (2).mp3',
      'title.mp3',
      'Title.mp3',
      'X (2).m4b',
    ];
    const sorted = [...shuffled].sort(compareAudioNames);
    expect([...sorted].sort(compareAudioNames)).toEqual(sorted);
    // antisymmetry spot-checks: cmp(a,b) === -cmp(b,a)
    const sign = (n: number) => Math.sign(n);
    const pairs: [string, string][] = [
      ['X.mp3', 'X (2).mp3'],
      ['X (2).mp3', 'X (10).mp3'],
      ['Title.mp3', 'Title.m4b'],
      ['Title.mp3', 'title.mp3'],
    ];
    for (const [a, b] of pairs) {
      expect(sign(compareAudioNames(a, b))).toBe(-sign(compareAudioNames(b, a)));
    }
  });
});

describe('disambiguateStems', () => {
  it('passes through a single stem un-numbered', () => {
    expect(disambiguateStems(['Author - Title'])).toEqual(['Author - Title']);
  });

  it('passes through an empty list', () => {
    expect(disambiguateStems([])).toEqual([]);
  });

  it('leaves already-unique stems untouched (a per-file token is present)', () => {
    const stems = ['01 - Intro', '02 - Journey', '03 - End'];
    expect(disambiguateStems(stems)).toEqual(stems);
  });

  it('numbers every colliding stem including the first, single-digit width for 2–3 files', () => {
    // padWidth(3) === 1 — no leading zeros (mirrors planFileRenames paths.test.ts:411-425).
    expect(disambiguateStems(['A - B', 'A - B', 'A - B'])).toEqual([
      'A - B (1)', 'A - B (2)', 'A - B (3)',
    ]);
  });

  it('collides case-insensitively', () => {
    expect(disambiguateStems(['A - B', 'a - b'])).toEqual(['A - B (1)', 'a - b (2)']);
  });

  it('pads to 2 digits for 10–99 files', () => {
    const out = disambiguateStems(Array.from({ length: 12 }, () => 'Same'));
    expect(out[0]).toBe('Same (01)');
    expect(out[11]).toBe('Same (12)');
    expect(out.every((s) => /\(\d{2}\)$/.test(s))).toBe(true);
  });

  it('pads to 3 digits only once the count reaches 100 (width tracks padWidth, not hard-coded)', () => {
    const out = disambiguateStems(Array.from({ length: 100 }, () => 'Same'));
    expect(out[0]).toBe('Same (001)');
    expect(out[99]).toBe('Same (100)');
    expect(out.every((s) => /\(\d{3}\)$/.test(s))).toBe(true);
  });

  it('assigns ordinals in the caller-provided order (play order, not lexicographic)', () => {
    // Caller sorts with compareAudioNames first: Track1, Track2, Track10.
    const ordered = ['Track1.mp3', 'Track2.mp3', 'Track10.mp3'].sort(compareAudioNames);
    // Render collapses all to the same book-only stem; the ordinal follows play order.
    const stems = ordered.map(() => 'Author - Title');
    expect(disambiguateStems(stems)).toEqual([
      'Author - Title (1)', 'Author - Title (2)', 'Author - Title (3)',
    ]);
    // Sanity: the sort put Track2 before Track10 (numeric), so ordinal 2 maps to Track2.
    expect(ordered).toEqual(['Track1.mp3', 'Track2.mp3', 'Track10.mp3']);
  });
});
