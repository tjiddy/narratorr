import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { tagFile, TaggingService, RetagError, pickCoverFile, type TagMetadata } from './tagging.service.js';
import { buildCanonicalTags, readExistingTags, resolveTags } from './retag-plan.js';
import {
  MP4_TAG_ATOMS,
  ID3_TAG_FRAMES,
  COVER_MIME_BY_EXTENSION,
  type MutagenRequest,
} from './mutagen-tag-payload.js';
import { createMockSettingsService } from '../__tests__/helpers.js';

// A plain closure survives vi.clearAllMocks; tests toggle auto-detection through hoisted state.
/** Stand-in for the SHA-256 the real helper reports for a written cover. */
const FAKE_COVER_DIGEST = 'f'.repeat(64);

const { mutagenState } = vi.hoisted(() => ({
  mutagenState: {
    resolves: true,
    /** Payloads captured off the child's stdin, in call order. */
    requests: [] as unknown[],
    /** One-shot outcomes; an empty queue means "echo the request back and verify clean". */
    outcomes: [] as ({ stdout?: string; error?: Error } | undefined)[],
  },
}));

vi.mock('@core/utils/mutagen-resolver.js', () => ({
  resolveMutagenPython: () => Promise.resolve(mutagenState.resolves ? '/usr/bin/python3' : null),
}));

/**
 * The mutagen writer wraps `execFile` itself and destructures (error, stdout, stderr)
 * POSITIONALLY; a `promisify` consumer would need `cb(null, { stdout, stderr })`. Dispatch on argv
 * so a second consumer cannot silently receive the wrong shape — handing the object form to this
 * arm makes JSON.parse see "[object Object]", which reads as a legitimate protocol failure rather
 * than a mock bug (execfile-mock-dual-callback-shape).
 */
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (...cbArgs: unknown[]) => void;
    if (!Array.isArray(argv) || argv[0] !== '-c') {
      // Not the tag writer: the promisified object shape.
      cb(null, { stdout: '', stderr: '' });
      return {};
    }
    return {
      stdin: {
        on: () => {},
        end: (data: string) => {
          const request = JSON.parse(data) as MutagenRequest;
          mutagenState.requests.push(request);
          const outcome = mutagenState.outcomes.shift();
          if (outcome?.error) return cb(outcome.error, '', '');
          if (outcome?.stdout !== undefined) return cb(null, outcome.stdout, '');
          const verified: Record<string, string> = {};
          for (const op of request.ops) verified[op.key] = op.value;
          // Mirror the helper's cover contract: the digest it wrote must equal the digest it read
          // back, and the stored format must be the requested mime (#2210 F1).
          const coverDigest = request.cover ? FAKE_COVER_DIGEST : undefined;
          if (request.cover) {
            verified.__cover__ = FAKE_COVER_DIGEST;
            verified.__cover_format__ = request.cover.mime;
          }
          cb(null, JSON.stringify({
            ok: true, sizeBefore: 1000, sizeAfter: 1100, verified,
            ...(coverDigest && { coverDigest }),
          }), '');
        },
      },
    };
  }),
}));

/** Arm the next helper invocation to fail or return a specific response. */
function armMutagenOutcome(outcome: { stdout?: string; error?: Error }): void {
  mutagenState.outcomes.push(outcome);
}

function mutagenRequest(index: number): MutagenRequest {
  const request = mutagenState.requests[index] as MutagenRequest | undefined;
  if (!request) throw new Error(`No mutagen request at index ${index} (captured ${mutagenState.requests.length})`);
  return request;
}

/**
 * Field-name view of what a given write actually asked for, resolved through the production
 * mapping tables so the assertion reads the same for MP3 and M4B. Returning a populated object is
 * also the mock-shape regression guard: a wrong callback shape yields no captured request at all.
 */
function writtenTags(index: number): Record<string, string> {
  const request = mutagenRequest(index);
  const byKey = new Map(request.ops.map(op => [op.key, op.value]));
  const result: Record<string, string> = {};
  for (const [field, key] of request.format === 'mp4' ? MP4_TAG_ATOMS : ID3_TAG_FRAMES) {
    const value = byKey.get(key);
    if (value !== undefined) result[field] = value;
  }
  const isMp4 = request.format === 'mp4';
  const track = byKey.get(isMp4 ? 'trkn' : 'TRCK');
  if (track !== undefined) result.track = track;
  const seriesPart = byKey.get(isMp4 ? '----:com.apple.iTunes:SERIES-PART' : 'TXXX:series-part');
  if (seriesPart !== undefined) result.seriesPart = seriesPart;
  return result;
}

/** Per-write value of one field, in call order; undefined where that write omitted it. */
function writtenField(field: string): (string | undefined)[] {
  return mutagenState.requests.map((_, index) => writtenTags(index)[field]);
}

/** Target paths of every write, in call order. */
function writtenPaths(): string[] {
  return (mutagenState.requests as MutagenRequest[]).map(request => request.path);
}

function resetMutagenCapture(): void {
  mutagenState.requests.length = 0;
  mutagenState.outcomes.length = 0;
}

// withFileTypes callers need Dirent-like entries; bare readdir callers need filenames.
let _readdirFiles: string[] = [];
/**
 * 1-based ordinal of the bare `readdir` call to reject, or null for none. tagBook issues them in a
 * fixed order — `warnUnsupportedFormats` first, then `findCoverFile`'s cover probe — so only an
 * ordinal can target the probe: rejecting on the argument shape also hits the unguarded scan, which
 * throws out of tagBook before the probe ever runs.
 */
let _bareReaddirRejectOrdinal: number | null = null;
let _bareReaddirCalls = 0;
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn((_dir: string, opts?: { withFileTypes?: boolean }) => {
    if (opts?.withFileTypes) {
      return Promise.resolve(_readdirFiles.map(name => ({
        name,
        isFile: () => true,
        isDirectory: () => false,
      })));
    }
    _bareReaddirCalls += 1;
    if (_bareReaddirCalls === _bareReaddirRejectOrdinal) {
      return Promise.reject(new Error('EACCES: permission denied, scandir'));
    }
    return Promise.resolve([..._readdirFiles]);
  }),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1000 }),
}));

vi.mock('music-metadata', () => ({
  parseFile: vi.fn().mockResolvedValue({
    common: {},
    format: {},
  }),
}));

// Preserve real exports used by transitive imports; override only eq for assertion capture.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    eq: vi.fn((col, val) => ({ col, val })),
  };
});

vi.mock('@db/schema.js', () => ({
  books: { id: 'books.id' },
  authors: { id: 'authors.id', name: 'authors.name' },
  bookAuthors: { bookId: 'bookAuthors.bookId', authorId: 'bookAuthors.authorId', position: 'bookAuthors.position' },
  bookNarrators: { bookId: 'bookNarrators.bookId', narratorId: 'bookNarrators.narratorId' },
  narrators: { id: 'narrators.id', name: 'narrators.name' },
}));

import { rename, unlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { parseFile } from 'music-metadata';

beforeEach(() => {
  _bareReaddirCalls = 0;
  _bareReaddirRejectOrdinal = null;
});


describe('buildCanonicalTags field mapping (#1671)', () => {
  it('date = extractYear(publishedDate); genre = genres[0]', () => {
    const tags = buildCanonicalTags({ title: 'B', publishedDate: '2010-11-02', genres: ['Fantasy', 'Adventure'] });
    expect(tags.date).toBe('2010');
    expect(tags.genre).toBe('Fantasy');
  });

  it('omits date when no 4-digit year; omits genre when array empty', () => {
    const tags = buildCanonicalTags({ title: 'B', publishedDate: 'n/a', genres: [] });
    expect(tags.date).toBeUndefined();
    expect(tags.genre).toBeUndefined();
  });

  it('omits genre when genres undefined or first element empty', () => {
    expect(buildCanonicalTags({ title: 'B' }).genre).toBeUndefined();
    expect(buildCanonicalTags({ title: 'B', genres: [''] }).genre).toBeUndefined();
  });

  it('seriesPosition 0 maps to seriesPart 0 (!= null, not truthy)', () => {
    expect(buildCanonicalTags({ title: 'B', seriesPosition: 0 }).seriesPart).toBe(0);
    expect(buildCanonicalTags({ title: 'B', seriesPosition: null }).seriesPart).toBeUndefined();
  });

  it('seriesName populates both grouping and series', () => {
    const tags = buildCanonicalTags({ title: 'B', seriesName: 'Stormlight' });
    expect(tags.grouping).toBe('Stormlight');
    expect(tags.series).toBe('Stormlight');
  });

  it('threads asin/subtitle/description/publisher verbatim, omitting empties', () => {
    const tags = buildCanonicalTags({ title: 'B', asin: 'B0X', subtitle: 'Sub', description: 'D', publisher: 'P' });
    expect(tags).toMatchObject({ asin: 'B0X', subtitle: 'Sub', description: 'D', publisher: 'P' });
    const empty = buildCanonicalTags({ title: 'B', asin: '', subtitle: '', description: '', publisher: '' });
    expect(empty.asin).toBeUndefined();
    expect(empty.subtitle).toBeUndefined();
  });
});

describe('readExistingTags new-field readback (#1671)', () => {
  it('reads new fields from common + native (series/series-part/publisher)', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: {
        subtitle: ['Sub'], description: ['Desc'], genre: ['Fantasy', 'X'],
        asin: 'B0X', year: 2010,
      },
      native: { 'ID3v2.4': [
        { id: 'TXXX:series', value: 'Stormlight' },
        { id: 'TXXX:series-part', value: '2' },
        { id: 'TPUB', value: 'Tor' },
      ] },
      format: {},
    });
    const tags = await readExistingTags('/book.mp3');
    expect(tags).toMatchObject({
      subtitle: 'Sub', publisher: 'Tor', description: 'Desc', genre: 'Fantasy', asin: 'B0X',
      date: '2010', series: 'Stormlight', seriesPart: 2,
    });
  });

  // AC8: music-metadata maps TPUB to common.label and has no MP4 publisher mapping at all, so a
  // common-only read was a silent no-op that made populate_missing rewrite publisher every pass.
  it('reads publisher from the native frames, never from common.publisher', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: { publisher: ['Never Read'], label: ['Tor Books'] },
      native: { 'ID3v2.4': [{ id: 'TPUB', value: 'Tor Books' }] },
      format: {},
    });
    expect((await readExistingTags('/book.mp3')).publisher).toBe('Tor Books');

    (parseFile as Mock).mockResolvedValueOnce({
      common: {},
      native: { iTunes: [{ id: '----:com.apple.iTunes:PUBLISHER', value: 'Tor Books' }] },
      format: {},
    });
    expect((await readExistingTags('/book.m4b')).publisher).toBe('Tor Books');
  });

  it('reads trackTotal from common.track.of alongside track.no', async () => {
    (parseFile as Mock).mockResolvedValueOnce({ common: { track: { no: 2, of: 5 } }, format: {} });
    expect(await readExistingTags('/book.mp3')).toMatchObject({ track: 2, trackTotal: 5 });
  });

  // AC9: an existing 747-book library was written by the pre-mutagen ffmpeg path.
  it.each([
    ['bare ffmpeg-era ids', { 'ID3v2.4': [{ id: 'series', value: 'Legacy' }, { id: 'series-part', value: '3' }] }],
    ['ID3 TXXX ids', { 'ID3v2.4': [{ id: 'TXXX:series', value: 'Legacy' }, { id: 'TXXX:series-part', value: '3' }] }],
    ['MP4 freeform ids', { iTunes: [{ id: '----:com.apple.iTunes:series', value: 'Legacy' }, { id: '----:com.apple.iTunes:series-part', value: '3' }] }],
  ])('still reads a file tagged with %s', async (_name, native) => {
    (parseFile as Mock).mockResolvedValueOnce({ common: {}, native, format: {} });
    expect(await readExistingTags('/book.mp3')).toMatchObject({ series: 'Legacy', seriesPart: 3 });
  });

  it('falls back to the movement channel for a file written by something else', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: {},
      native: { 'ID3v2.4': [{ id: 'MVNM', value: 'Foreign Series' }, { id: 'MVIN', value: '4' }] },
      format: {},
    });
    expect(await readExistingTags('/book.mp3')).toMatchObject({ series: 'Foreign Series', seriesPart: 4 });
  });

  it('prefers the lossless freeform over the integer-truncating movement atom', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: {},
      native: { iTunes: [
        { id: '©mvi', value: 2 },
        { id: '----:com.apple.iTunes:SERIES-PART', value: '2.5' },
      ] },
      format: {},
    });
    expect((await readExistingTags('/book.m4b')).seriesPart).toBe(2.5);
  });

  it('reads date from common.date when present, else year', async () => {
    (parseFile as Mock).mockResolvedValueOnce({ common: { date: '2018' }, format: {} });
    expect((await readExistingTags('/b.mp3')).date).toBe('2018');
  });
});

describe('resolveTags new-field populate_missing awareness (#1671)', () => {
  const desired: TagMetadata = {
    series: 'S', seriesPart: 3, subtitle: 'Sub', asin: 'B0X',
    publisher: 'P', description: 'D', date: '2010', genre: 'Fantasy',
  };

  it('populates a new field when existing is empty/absent', () => {
    const resolved = resolveTags(desired, {}, 'populate_missing');
    expect(resolved).toMatchObject({ series: 'S', seriesPart: 3, subtitle: 'Sub', asin: 'B0X', publisher: 'P', description: 'D', date: '2010', genre: 'Fantasy' });
  });

  it('does NOT overwrite a populated new field', () => {
    const existing: Partial<TagMetadata> = {
      series: 'old', seriesPart: 9, subtitle: 'old', asin: 'OLD', publisher: 'old', description: 'old', date: '1999', genre: 'old',
    };
    const resolved = resolveTags(desired, existing, 'populate_missing');
    expect(resolved).toBeNull();
  });

  it('seriesPart 0 populates an absent value (!= null, not truthy)', () => {
    const resolved = resolveTags({ seriesPart: 0 }, {}, 'populate_missing');
    expect(resolved).toEqual({ seriesPart: 0 });
  });

  it('empty-string desired value is dropped (truthy coercion, pinned intentional)', () => {
    const resolved = resolveTags({ subtitle: '' }, {}, 'populate_missing');
    expect(resolved).toBeNull();
  });
});

describe('readExistingTags non-numeric native series-part (#1696)', () => {
  const readSeriesPart = async (value: string): Promise<number | undefined> => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: {},
      native: { 'ID3v2.4': [{ id: 'TXXX:series-part', value }] },
      format: {},
    });
    return (await readExistingTags('/book.mp3')).seriesPart;
  };

  it.each(['Book 2', 'II', '2 of 5'])('treats non-numeric native series-part %j as absent (not NaN)', async (value) => {
    expect(await readSeriesPart(value)).toBeUndefined();
  });

  it('treats whitespace-only native series-part as absent (not 0)', async () => {
    expect(await readSeriesPart('   ')).toBeUndefined();
  });

  it('treats empty-string native series-part as absent (existing truthy/empty-string drop)', async () => {
    expect(await readSeriesPart('')).toBeUndefined();
  });

  it('reads a numeric native series-part as the number', async () => {
    expect(await readSeriesPart('3')).toBe(3);
  });

  it('reads a whitespace-wrapped numeric native series-part as the number (trim then parse)', async () => {
    expect(await readSeriesPart('  3  ')).toBe(3);
  });
});

describe('resolveTags series-part populate_missing with malformed existing (#1696)', () => {
  it('writes canonical seriesPart when existing is absent (non-numeric native read → undefined)', () => {
    const resolved = resolveTags({ seriesPart: 2 }, {}, 'populate_missing');
    expect(resolved).toEqual({ seriesPart: 2 });
  });

  it('suppresses the write when existing seriesPart is already a number', () => {
    const resolved = resolveTags({ seriesPart: 3 }, { seriesPart: 3 }, 'populate_missing');
    expect(resolved).toBeNull();
  });

  it('overwrite ignores a non-numeric existing series-part and returns desired (NaN cannot manifest)', () => {
    const resolved = resolveTags({ seriesPart: 2 }, { seriesPart: Number.NaN }, 'overwrite');
    expect(resolved).toEqual({ seriesPart: 2 });
  });
});

describe('pickCoverFile (#2214)', () => {
  /**
   * readdir order is undefined, so every ranking claim is asserted in both permutations: one order
   * alone passes against a first-match picker roughly half the time and proves nothing.
   */
  function pickBothOrders(entries: string[]): (string | undefined)[] {
    return [pickCoverFile(entries), pickCoverFile([...entries].reverse())];
  }

  it.each([
    [['cover.webp', 'cover.jpg'], 'cover.jpg'],
    [['cover.webp', 'cover.jpeg'], 'cover.jpeg'],
    [['cover.webp', 'cover.png'], 'cover.png'],
  ])('prefers the embeddable %j over the webp in both readdir orders', (entries, expected) => {
    expect(pickBothOrders(entries)).toEqual([expected, expected]);
  });

  it('prefers .jpg over .png — both are embeddable, so preference order decides', () => {
    expect(pickBothOrders(['cover.png', 'cover.jpg'])).toEqual(['cover.jpg', 'cover.jpg']);
  });

  it.each([
    [['cover.webp', 'cover.png', 'cover.jpg']],
    [['cover.png', 'cover.jpg', 'cover.webp']],
    [['cover.jpg', 'cover.webp', 'cover.png']],
  ])('picks cover.jpg out of %j regardless of permutation', (entries) => {
    expect(pickBothOrders(entries)).toEqual(['cover.jpg', 'cover.jpg']);
  });

  // Linux is case-sensitive, so these pairs genuinely coexist. They tie on capability and on
  // preference, leaving the raw-filename key as the only thing that makes the pick deterministic.
  it.each([
    [['cover.jpg', 'Cover.JPG'], 'Cover.JPG'],
    [['cover.png', 'Cover.PNG'], 'Cover.PNG'],
  ])('breaks the %j tie on code-unit filename order, both ways', (entries, expected) => {
    expect(pickBothOrders(entries)).toEqual([expected, expected]);
  });

  it.each([
    [['cover.webp', 'Cover.JPG'], 'Cover.JPG'],
    [['COVER.WEBP', 'cover.Png'], 'cover.Png'],
  ])('compares extensions case-insensitively for %j', (entries, expected) => {
    expect(pickBothOrders(entries)).toEqual([expected, expected]);
  });

  it('still returns the webp when it is the only cover (#2210 D4 fallback)', () => {
    expect(pickCoverFile(['ch01.mp3', 'cover.webp'])).toBe('cover.webp');
  });

  it('ignores non-cover images and unrelated files', () => {
    expect(pickBothOrders(['ch01.mp3', 'metadata.opf', 'artwork.jpg', 'cover.webp', 'cover.jpg']))
      .toEqual(['cover.jpg', 'cover.jpg']);
  });

  it.each([
    [[]],
    [['ch01.mp3', 'notes.txt']],
    [['cover.gif', 'cover.bmp']],
  ])('returns undefined when nothing in %j is an admitted cover', (entries) => {
    expect(pickCoverFile(entries)).toBeUndefined();
  });

  // Driven off the MIME table rather than three hand-written cases: if the table ever gains or
  // loses an extension, this coverage follows it instead of going quietly stale.
  it.each(Object.keys(COVER_MIME_BY_EXTENSION))('beats a webp with a table-supported %s', (ext) => {
    expect(pickBothOrders(['cover.webp', `cover${ext}`])).toEqual([`cover${ext}`, `cover${ext}`]);
  });
});

describe('tagFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
  });

  it('skips unsupported format (.ogg) with warning', async () => {
    const result = await tagFile('/books/file.ogg', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Unsupported format');
    expect(result.reason).toContain('.ogg');
  });

  it('skips unsupported format (.flac)', async () => {
    const result = await tagFile('/books/file.flac', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('skipped');
  });

  it('tags MP3 file in overwrite mode', async () => {
    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author', album: 'Book' }, 'overwrite');
    expect(result.status).toBe('tagged');
    expect(result.file).toBe('file.mp3');
    expect(writtenTags(0)).toEqual({ artist: 'Author', album: 'Book' });
  });

  it('writes the m4b through the MP4 arm and the mp3 through the ID3 arm', async () => {
    await tagFile('/books/file.m4b', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    expect(mutagenRequest(0).format).toBe('mp4');
    expect(mutagenRequest(0).ops).toContainEqual({ key: '\u00a9ART', kind: 'text', value: 'Author' });
    expect(mutagenRequest(1).format).toBe('id3');
    expect(mutagenRequest(1).ops).toContainEqual({ key: 'TPE1', kind: 'text', value: 'Author' });
  });

  it('tags M4B file in overwrite mode', async () => {
    const result = await tagFile('/books/file.m4b', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('tagged');
    expect(result.file).toBe('file.m4b');
  });

  it('tags M4A file in overwrite mode', async () => {
    const result = await tagFile('/books/file.m4a', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('tagged');
  });

  it('#2495: routes a .mp4 through the MP4 atom arm, not the ID3 arm', async () => {
    const result = await tagFile('/books/file.mp4', '/usr/bin/python3', { artist: 'Author', album: 'Book' }, 'overwrite');

    expect(result.status).toBe('tagged');
    expect(result.file).toBe('file.mp4');
    expect(mutagenRequest(0).format).toBe('mp4');
    expect(mutagenRequest(0).ops).toContainEqual({ key: '©ART', kind: 'text', value: 'Author' });
    expect(mutagenRequest(0).ops).toContainEqual({ key: '©alb', kind: 'text', value: 'Book' });
    expect(mutagenRequest(0).ops.map(op => op.key)).not.toContain('TPE1');
  });

  it('writes tags with a sanitized env (no secret leak, PATH preserved)', async () => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-secret';
    try {
      const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
      expect(result.status).toBe('tagged');

      const { execFile } = await import('node:child_process');
      const opts = (execFile as unknown as Mock).mock.calls[0]![2] as { env?: Record<string, string> };
      expect(opts.env).toBeDefined();
      expect(opts.env).not.toHaveProperty('NARRATORR_SECRET_KEY');
      expect(opts.env).toHaveProperty('PATH');
      expect(opts.env!.PYTHONDONTWRITEBYTECODE).toBe('1');
    } finally {
      delete process.env.NARRATORR_SECRET_KEY;
    }
  });

  it('in populate_missing mode, reads existing tags and skips non-empty fields', async () => {
    (parseFile as Mock).mockResolvedValueOnce({
      common: { artist: 'Existing Author', album: '', title: '' },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'New Author', album: 'New Book', title: 'Title' },
      'populate_missing',
    );

    expect(result.status).toBe('tagged');
    expect(parseFile).toHaveBeenCalledWith('/books/file.mp3');

    expect(writtenTags(0)).toEqual({ album: 'New Book', title: 'Title' });
  });

  it('in populate_missing mode, skips entirely when all tags populated', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: {
        artist: 'Existing',
        albumartist: 'Existing',
        album: 'Existing',
        title: 'Existing',
        composer: ['Existing'],
        grouping: 'Existing',
        track: { no: 1 },
        picture: [],
      },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'New', album: 'New', title: 'New', composer: 'New', grouping: 'New' },
      'populate_missing',
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('All tags already populated');
  });

  it('in overwrite mode with empty desired tags and no cover, skips without spawning the tag writer (#1086 amendment)', async () => {
    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', {}, 'overwrite');
    expect(result.status).toBe('skipped');
    expect(execFile).not.toHaveBeenCalled();
    expect(mutagenState.requests).toHaveLength(0);
  });

  it('in overwrite mode with empty desired tags but cover present, still tags (cover-only write)', async () => {
    (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', {}, 'overwrite', '/books/cover.jpg');
    expect(result.status).toBe('tagged');
    expect(mutagenRequest(0).cover).toEqual({ path: '/books/cover.jpg', mime: 'image/jpeg' });
    expect(mutagenRequest(0).ops).toEqual([]);
  });

  it('in populate_missing mode with empty desired tags and no cover, skips (regression guard)', async () => {
    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', {}, 'populate_missing');
    expect(result.status).toBe('skipped');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns failed status when the tag writer exits non-zero', async () => {
    armMutagenOutcome({ error: new Error('Command failed: python3 -c') });

    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Command failed');
  });

  it('returns failed when the helper exits 0 with ok:false', async () => {
    armMutagenOutcome({ stdout: JSON.stringify({ ok: false, error: 'MP4MetadataValueError: bad atom' }) });

    const result = await tagFile('/books/file.m4b', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('MP4MetadataValueError: bad atom');
  });

  it('returns failed when the helper writes malformed JSON', async () => {
    armMutagenOutcome({ stdout: 'Traceback (most recent call last):' });

    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('unparseable output');
  });

  it('releases the write lock after a failure, so the next write to the same path still runs', async () => {
    armMutagenOutcome({ error: new Error('killed') });

    const failed = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    const recovered = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    expect(failed.status).toBe('failed');
    expect(recovered.status).toBe('tagged');
  });

  // D2/AC12: size is reported, never adjudicated. An overwrite that legitimately shrinks the file
  // — shorter description, smaller replacement cover — is a success.
  it('reports tagged when the file SHRANK but every requested value read back', async () => {
    armMutagenOutcome({
      stdout: JSON.stringify({
        ok: true, sizeBefore: 5_000_000, sizeAfter: 3_000_000, verified: { TPE1: 'Author' },
      }),
    });

    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    expect(result.status).toBe('tagged');
    expect(result.sizeBefore).toBe(5_000_000);
    expect(result.sizeAfter).toBe(3_000_000);
  });

  it('reports failed when a requested key is missing from verified, even though the file grew', async () => {
    armMutagenOutcome({
      stdout: JSON.stringify({
        ok: true, sizeBefore: 1000, sizeAfter: 9_000_000, verified: { TPE1: 'Author' },
      }),
    });

    const result = await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author', album: 'Book' }, 'overwrite');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('TALB');
  });

  // AC11: the write is in place. #1852 AC9's hazard — a library scan ingesting the born-hidden
  // temp file before the rename — cannot occur when no second file is ever created.
  it('writes in place: no temp file, no rename, and the helper targets the original path', async () => {
    await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(mutagenRequest(0).path).toBe('/books/file.mp3');
  });

  it('creates nothing to clean up on a failed write', async () => {
    armMutagenOutcome({ error: new Error('helper error') });

    await tagFile('/books/file.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('assigns track number for multi-file books, omits for single-file', async () => {
    await tagFile('/books/ch02.mp3', '/usr/bin/python3', { artist: 'Author', track: 2, trackTotal: 5 }, 'overwrite');
    expect(writtenTags(0).track).toBe('2/5');

    await tagFile('/books/book.mp3', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');
    expect(writtenTags(1).track).toBeUndefined();
  });

  it('in populate_missing mode with cover, skips cover when file already has art', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: { artist: 'Existing', album: 'Existing', title: 'Existing', picture: [{ data: Buffer.from('img') }] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'Author', album: 'Book', title: 'Title' },
      'populate_missing',
      '/books/cover.jpg',
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('All tags already populated');
  });

  it('in populate_missing mode with cover, embeds cover when file has no art', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: { artist: 'Existing', album: 'Existing', title: 'Existing', picture: [] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'Author', album: 'Book', title: 'Title' },
      'populate_missing',
      '/books/cover.jpg',
    );

    expect(result.status).toBe('tagged');

    expect(mutagenRequest(0).cover).toEqual({ path: '/books/cover.jpg', mime: 'image/jpeg' });
  });

  it('in overwrite mode, always embeds cover even when file has art', async () => {
    (parseFile as Mock).mockResolvedValue({
      common: { picture: [{ data: Buffer.from('img') }] },
      format: {},
    });

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'Author' },
      'overwrite',
      '/books/cover.jpg',
    );

    expect(result.status).toBe('tagged');
    expect(mutagenRequest(0).cover).toEqual({ path: '/books/cover.jpg', mime: 'image/jpeg' });
  });

  // F1: the operator-visible consequence — a retained old cover must not be reported as `tagged`.
  it('reports failed when the helper stored a cover other than the requested image', async () => {
    (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
    armMutagenOutcome({
      stdout: JSON.stringify({
        ok: true,
        sizeBefore: 1000,
        sizeAfter: 1100,
        verified: { '©alb': 'Book', __cover__: 'a'.repeat(64), __cover_format__: 'image/jpeg' },
        coverDigest: 'b'.repeat(64),
      }),
    });

    const result = await tagFile('/books/file.m4b', '/usr/bin/python3', { album: 'Book' }, 'overwrite', '/books/cover.jpg');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('cover art');
  });

  it('warns but still writes the tags for a .webp cover (D4)', async () => {
    (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });

    const result = await tagFile('/books/file.m4b', '/usr/bin/python3', { artist: 'Author' }, 'overwrite', '/books/cover.webp');

    expect(result.status).toBe('tagged');
    expect(result.warnings).toEqual(['Cover art format not supported for embedding: .webp']);
    expect(mutagenRequest(0).cover).toBeNull();
    expect(writtenTags(0).artist).toBe('Author');
  });

  it('leaves an embedded picture untouched when no cover is supplied (#2078 AC16)', async () => {
    await tagFile('/books/file.m4b', '/usr/bin/python3', { artist: 'Author' }, 'overwrite');

    // Structural now: mutagen never rewrites covr/APIC unless the request carries a cover.
    expect(mutagenRequest(0).cover).toBeNull();
  });

  it('readExistingTags returns empty on parse failure (treats as all empty)', async () => {
    (parseFile as Mock).mockRejectedValueOnce(new Error('corrupt file'));

    const result = await tagFile(
      '/books/file.mp3',
      '/usr/bin/python3',
      { artist: 'Author' },
      'populate_missing',
    );

    expect(result.status).toBe('tagged');
  });
});

  describe('TaggingService', () => {
  function createMockDb() {
    return { select: vi.fn() };
  }

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockBookService = { getById: vi.fn() };
  });

  function makeBook(overrides: {
    id?: number; title?: string; path?: string | null;
    authors?: { name: string }[]; narrators?: { name: string }[];
    seriesName?: string | null; seriesPosition?: number | null; coverUrl?: string | null;
    asin?: string | null; subtitle?: string | null; description?: string | null;
    publisher?: string | null; publishedDate?: string | null; genres?: string[] | null;
  } = {}) {
    return {
      id: 1,
      title: 'Test Book',
      path: '/library/test',
      authors: [],
      narrators: [],
      seriesName: null,
      seriesPosition: null,
      asin: null,
      subtitle: null,
      description: null,
      publisher: null,
      publishedDate: null,
      genres: null,
      coverUrl: null,
      ...overrides,
    };
  }

  const taggingDefaults = {
    processing: {},
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  function createMockLog() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      level: 'info',
      silent: vi.fn(),
    };
  }

  describe('retagBook', () => {
    it('throws MUTAGEN_NOT_CONFIGURED when no mutagen-capable interpreter resolves', async () => {
      const db = createMockDb();
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite' },
      });

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      mutagenState.resolves = false;
      try {
        await expect(service.retagBook(1)).rejects.toThrow(RetagError);
        await expect(service.retagBook(1)).rejects.toThrow(/mutagen module is not available/);
      } finally {
        mutagenState.resolves = true;
      }
    });

    it('throws NOT_FOUND when book does not exist', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(null);
      const settings = createMockSettingsService(taggingDefaults);

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(999)).rejects.toThrow(RetagError);
    });

    it('throws NO_PATH when book has no library path', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ path: null }));
      const settings = createMockSettingsService(taggingDefaults);

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(1)).rejects.toThrow(/no library path/);
    });

    it('throws PATH_MISSING when book path does not exist on disk', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ path: '/nonexistent' }));
      const settings = createMockSettingsService(taggingDefaults);
      (stat as Mock).mockRejectedValueOnce(new Error('ENOENT'));

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await expect(service.retagBook(1)).rejects.toThrow(/does not exist on disk/);
    });

    it('fetches book via BookService.getById and calls tagBook with correct metadata', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({
        id: 42,
        title: 'The Final Empire',
        path: '/library/sanderson/final-empire',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: [{ name: 'Michael Kramer' }],
        seriesName: 'Mistborn',
        seriesPosition: 1,
        coverUrl: 'https://example.com/cover.jpg',
      }));
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing', embedCover: true },
      });
      (stat as Mock).mockResolvedValue({ size: 1000 });
      _readdirFiles = ['ch01.mp3'];

      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);
      const result = await service.retagBook(42);

      expect(mockBookService.getById).toHaveBeenCalledWith(42);
      expect(result.bookId).toBe(42);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, tagged: 1 }),
        expect.any(String),
      );
    });

    it('passes null author name when book has no author', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({ authors: [], narrators: [] }));
      const settings = createMockSettingsService(taggingDefaults);
      (stat as Mock).mockResolvedValue({ size: 1000 });
      _readdirFiles = ['book.mp3'];

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      const result = await service.retagBook(1);

      expect(result.tagged).toBe(1);
    });

    it('threads new ABS fields + seriesPosition=0 into the applied ffmpeg args (#1671)', async () => {
      const db = createMockDb();
      mockBookService.getById.mockResolvedValue(makeBook({
        title: 'Book', path: '/library/x', authors: [{ name: 'Author' }],
        seriesName: 'Stormlight', seriesPosition: 0,
        asin: 'B0XYZ', subtitle: 'Sub', description: 'Desc', publisher: 'Tor',
        publishedDate: '2014-03-04', genres: ['Fantasy', 'Adventure'],
      }));
      const settings = createMockSettingsService(taggingDefaults);
      (stat as Mock).mockResolvedValue({ size: 1000 });
      _readdirFiles = ['book.mp3'];
      (execFile as unknown as Mock).mockClear();
      resetMutagenCapture();

      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);
      await service.retagBook(1);

      expect(writtenTags(0)).toMatchObject({
        series: 'Stormlight', seriesPart: '0', asin: 'B0XYZ', subtitle: 'Sub',
        description: 'Desc', publisher: 'Tor', date: '2014', genre: 'Fantasy',
      });
    });
  });

  describe('tagBook', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
      _readdirFiles = [];
      (stat as Mock).mockResolvedValue({ size: 1000 });
    });

    it('returns empty result when no taggable audio files found', async () => {
      _readdirFiles = [];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(result.tagged).toBe(0);
      expect(result.warnings).toContain('No taggable audio files found');
    });

    it('assigns track numbers in locale-aware sort order for multi-file books', async () => {
      _readdirFiles = ['02.mp3', '01.mp3', '10.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ tagged: 3 }),
        expect.any(String),
      );

      expect(writtenField('track')).toEqual(['1/3', '2/3', '3/3']);

      const inputFiles = writtenPaths();
      expect(inputFiles[0]).toContain('01.mp3');
      expect(inputFiles[1]).toContain('02.mp3');
      expect(inputFiles[2]).toContain('10.mp3');
    });

    it('omits track number for single-file books', async () => {
      _readdirFiles = ['book.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(result.tagged).toBe(1);

      expect(writtenTags(0).track).toBeUndefined();
    });

    it('warns about unsupported audio formats in directory', async () => {
      _readdirFiles = ['book.ogg', 'book.flac', 'cover.jpg'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(result.tagged).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.warnings).toContainEqual(expect.stringContaining('.ogg'));
      expect(result.warnings).toContainEqual(expect.stringContaining('.flac'));
      expect(result.warnings).toContain('No taggable audio files found');
      expect(result.warnings.some(w => w.includes('cover.jpg'))).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ file: 'book.ogg' }),
        'Tag write skipped',
      );
    });

    it('#1852 F34: does not warn about a hidden unsupported file (.hidden.flac)', async () => {
      _readdirFiles = ['visible.ogg', '.hidden.flac', 'cover.jpg'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', { title: 'Test' }, '/usr/bin/python3', 'overwrite', false);

      expect(result.skipped).toBe(1);
      expect(result.warnings).toContainEqual(expect.stringContaining('visible.ogg'));
      expect(result.warnings.some(w => w.includes('.hidden.flac'))).toBe(false);
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ file: '.hidden.flac' }),
        'Tag write skipped',
      );
    });

    it('logs warnings for unsupported files alongside tagging taggable ones', async () => {
      _readdirFiles = ['ch01.mp3', 'bonus.ogg', 'ch02.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(result.tagged).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toContainEqual(expect.stringContaining('.ogg'));
    });

    it('#2495: a .mp4-only folder tags cleanly with no "Unsupported format" warning', async () => {
      _readdirFiles = ['FortuneFunhouseMissFortuneMysteriesBook19.mp4', 'cover.jpg'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test', authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', true);

      expect(result.tagged).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.warnings.some(w => w.includes('.mp4'))).toBe(false);
      expect(result.warnings).not.toContain('No taggable audio files found');
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ file: 'FortuneFunhouseMissFortuneMysteriesBook19.mp4' }),
        'Tag write skipped',
      );

      const request = mutagenRequest(0);
      expect(request.format).toBe('mp4');
      expect(request.cover).toEqual({
        path: expect.stringContaining('cover.jpg') as unknown as string,
        mime: 'image/jpeg',
      });
      expect(writtenTags(0)).toEqual({ artist: 'Author', albumArtist: 'Author', album: 'Test', title: 'Test' });
    });

    // The registry-minus-taggable difference is where the two sets interact: .mp4 crossed from one
    // side to the other, .flac did not.
    it('#2495: a mixed .mp4 + .flac folder tags the mp4 and skips only the flac', async () => {
      _readdirFiles = ['Book.mp4', 'Book.flac'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const log = createMockLog();
      const service = new TaggingService(db as never, settings as never, log as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test', authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false);

      expect(result.tagged).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toContainEqual(expect.stringContaining('Book.flac'));
      expect(result.warnings.some(w => w.includes('Book.mp4'))).toBe(false);
      expect(mutagenRequest(0).path.split('\\').join('/')).toContain('/Book.mp4');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ file: 'Book.flac' }),
        'Tag write skipped',
      );
    });

    it('adds warning when cover embedding enabled but no cover file found', async () => {
      _readdirFiles = ['book.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test',
        authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', true);

      expect(result.warnings.some(w => w.includes('cover image found'))).toBe(true);
    });

    describe('cover selection (#2214)', () => {
      function makeService() {
        const settings = createMockSettingsService(taggingDefaults);
        return new TaggingService(
          createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never,
        );
      }

      /** findCoverFile joins with the OS separator; production is POSIX because the app runs in Docker. */
      function embeddedCover(index: number): { path: string; mime: string } | null {
        const cover = mutagenRequest(index).cover;
        return cover ? { ...cover, path: cover.path.split('\\').join('/') } : null;
      }

      it.each([
        [['ch01.mp3', 'cover.webp', 'cover.jpg']],
        [['ch01.mp3', 'cover.jpg', 'cover.webp']],
      ])('embeds the jpg, not the webp, for %j', async (entries) => {
        _readdirFiles = [...entries];

        const result = await makeService().tagBook(1, '/books/test', {
          title: 'Test', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', true);

        expect(embeddedCover(0)).toEqual({ path: '/books/test/cover.jpg', mime: 'image/jpeg' });
        expect(result.warnings.some(w => w.includes('not supported for embedding'))).toBe(false);
        expect(result.warnings.some(w => w.includes('cover image found'))).toBe(false);
      });

      // The fix narrows *when* the D4 warning fires; a webp-only folder is still the case where it
      // is unavoidable. An implementation that filtered to embeddable-only would report a missing
      // cover here instead, which is a regression rather than a fix.
      it('keeps the webp-only folder on warn-and-write (#2210 D4)', async () => {
        _readdirFiles = ['ch01.mp3', 'cover.webp'];

        const result = await makeService().tagBook(1, '/books/test', {
          title: 'Test', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', true);

        expect(embeddedCover(0)).toBeNull();
        expect(result.tagged).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.warnings).toContainEqual(
          expect.stringContaining('Cover art format not supported for embedding: .webp'),
        );
        expect(result.warnings.some(w => w.includes('cover image found'))).toBe(false);
      });

      it('treats an unreadable cover probe as no cover and still tags the audio', async () => {
        _readdirFiles = ['ch01.mp3', 'cover.jpg'];
        // Second bare readdir = findCoverFile; the first is warnUnsupportedFormats, which has no catch.
        _bareReaddirRejectOrdinal = 2;

        const result = await makeService().tagBook(1, '/books/test', {
          title: 'Test', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', true);

        expect(result.tagged).toBe(1);
        expect(embeddedCover(0)).toBeNull();
        expect(result.warnings.some(w => w.includes('cover image found'))).toBe(true);
      });
    });

    it('excludeFields strips fields from the tag payload', async () => {
      _readdirFiles = ['book.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      await service.tagBook(1, '/books/test', {
        title: 'Test Book', authorName: 'Author', narrator: 'Reader',
      }, '/usr/bin/python3', 'overwrite', false, new Set(['title']));

      expect(writtenTags(0)).toMatchObject({ artist: 'Author', album: 'Test Book' });
      expect(writtenTags(0).title).toBeUndefined();
    });

    it('excludeFields=["track"] strips both track and trackTotal from the tag payload', async () => {
      _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      await service.tagBook(1, '/books/test', {
        title: 'Test', authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', false, new Set(['track']));

      expect(writtenField('track')).toEqual([undefined, undefined]);
    });

    it('all metadata fields excluded + no cover → every file skipped', async () => {
      _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test', authorName: 'Author', narrator: 'Reader', seriesName: 'Series', seriesPosition: 1,
        asin: 'B0TEST', subtitle: 'Sub', description: 'Desc', publisher: 'Pub', publishedDate: '2010', genres: ['Fantasy'],
      }, '/usr/bin/python3', 'overwrite', false, new Set([
        'artist', 'albumArtist', 'album', 'title', 'composer', 'grouping', 'track',
        'series', 'seriesPart', 'subtitle', 'asin', 'publisher', 'description', 'date', 'genre',
      ]));

      expect(result.tagged).toBe(0);
      expect(result.skipped).toBe(2);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('all metadata fields excluded + cover present in overwrite mode → cover-only writes', async () => {
      _readdirFiles = ['ch01.mp3', 'cover.jpg'];
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      const result = await service.tagBook(1, '/books/test', {
        title: 'Test', authorName: 'Author',
      }, '/usr/bin/python3', 'overwrite', true, new Set(['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping', 'track']));

      expect(result.tagged).toBe(1);
      expect(mutagenRequest(0).ops).toEqual([]);
      // Unlike the sibling cases, this path is discovered via `findCoverFile`'s `path.join`, which
      // emits backslashes on Windows and forward slashes on Linux. Production is POSIX because the
      // app runs in Docker, so normalize the actual rather than weakening the expectation.
      const cover = mutagenRequest(0).cover as { path: string; mime: string };
      expect({ ...cover, path: cover.path.split('\\').join('/') })
        .toEqual({ path: '/books/test/cover.jpg', mime: 'image/jpeg' });
    });

    describe('per-file title (#1090)', () => {
      it('single-file book → writes title = book.title for the sole file', async () => {
        _readdirFiles = ['book.mp3'];
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'The Way of Kings', authorName: 'Brandon Sanderson',
        }, '/usr/bin/python3', 'overwrite', false);

        expect(writtenTags(0)).toMatchObject({ title: 'The Way of Kings', album: 'The Way of Kings' });
      });

      it('multi-file overwrite, every file has existing chapter title → existing titles preserved (not clobbered with book.title)', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3', 'ch03.mp3'];
        // Overwrite reads once per file in tagBook; tagFile must not read again.
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Chapter One: The Beginning' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Chapter Two: The Middle' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Chapter Three: The End' }, format: {} });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'This Inevitable Ruin', authorName: 'Will Wight',
        }, '/usr/bin/python3', 'overwrite', false);

        expect(writtenField('title')).toEqual([
          'Chapter One: The Beginning',
          'Chapter Two: The Middle',
          'Chapter Three: The End',
        ]);
        expect(writtenField('album')).toEqual([
          'This Inevitable Ruin',
          'This Inevitable Ruin',
          'This Inevitable Ruin',
        ]);
      });

      it('multi-file overwrite, files have NO existing title → per-file title derives from basename (extension stripped, never book.title)', async () => {
        _readdirFiles = ['001 - The Boy Who Lived.mp3', '002 - The Vanishing Glass.mp3'];
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: "Sorcerer's Stone", authorName: 'JK Rowling',
        }, '/usr/bin/python3', 'overwrite', false);

        expect(writtenField('title')).toEqual([
          '001 - The Boy Who Lived',
          '002 - The Vanishing Glass',
        ]);
      });

      it('multi-file populate_missing, files have existing titles → existing preserved via resolveTags (no title in the payload)', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
        // populate_missing skips tagBook's pre-read; tagFile reads once per file.
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Existing Chapter 1' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Existing Chapter 2' }, format: {} });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'populate_missing' as const },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'Book Title', authorName: 'Author',
        }, '/usr/bin/python3', 'populate_missing', false);

        expect(writtenField('title')).toEqual([undefined, undefined]);
      });

      it('multi-file populate_missing, files have NO existing title → basename-derived title written (NOT book.title)', async () => {
        _readdirFiles = ['001 - Track Name.mp3', '002 - Another Track.mp3'];
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'populate_missing' as const },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'Book Title', authorName: 'Author',
        }, '/usr/bin/python3', 'populate_missing', false);

        expect(writtenField('title')).toEqual([
          '001 - Track Name',
          '002 - Another Track',
        ]);
      });

      it('multi-file overwrite, excludeFields=["title"] → no title written for any file (existing per-file rule does not override exclude)', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Existing Title 1' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Existing Title 2' }, format: {} });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'Book Title', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', false, new Set(['title']));

        expect(writtenField('title')).toEqual([undefined, undefined]);
        expect(writtenField('album')).toEqual(['Book Title', 'Book Title']);
      });

      it('multi-file overwrite, mixed (one has title, one does not) → preserve where present, basename otherwise', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Preserved Chapter' }, format: {} })
          .mockResolvedValueOnce({ common: {}, format: {} });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'Book Title', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', false);

        expect(writtenField('title')).toEqual(['Preserved Chapter', 'ch02']);
      });

      it('multi-file overwrite preserves existing track numbering behavior', async () => {
        _readdirFiles = ['02.mp3', '01.mp3', '10.mp3'];
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        await service.tagBook(1, '/books/test', {
          title: 'Test', authorName: 'Author',
        }, '/usr/bin/python3', 'overwrite', false);

        expect(writtenField('track')).toEqual(['1/3', '2/3', '3/3']);
      });
    });
  });

  describe('planRetag', () => {
    function setupBook(overrides: Parameters<typeof makeBook>[0] = {}) {
      mockBookService.getById.mockResolvedValue(makeBook(overrides));
    }

    beforeEach(() => {
      vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
      _readdirFiles = [];
      (stat as Mock).mockResolvedValue({ size: 1000 });
    });

    function makeBook(overrides: {
      id?: number; title?: string; path?: string | null;
      authors?: { name: string }[]; narrators?: { name: string }[];
      seriesName?: string | null; seriesPosition?: number | null; coverUrl?: string | null;
      asin?: string | null; subtitle?: string | null; description?: string | null;
      publisher?: string | null; publishedDate?: string | null; genres?: string[] | null;
    } = {}) {
      return {
        id: 1,
        title: 'Test Book',
        path: '/library/test',
        authors: [],
        narrators: [],
        seriesName: null,
        seriesPosition: null,
        asin: null,
        subtitle: null,
        description: null,
        publisher: null,
        publishedDate: null,
        genres: null,
        coverUrl: null,
        ...overrides,
      };
    }

    it('returns canonical metadata derived from the book', async () => {
      _readdirFiles = ['ch01.mp3'];
      setupBook({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: [{ name: 'Michael Kramer' }],
        seriesName: 'Stormlight',
      });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);

      expect(plan.canonical).toEqual({
        artist: 'Brandon Sanderson',
        albumArtist: 'Brandon Sanderson',
        album: 'The Way of Kings',
        title: 'The Way of Kings',
        composer: 'Michael Kramer',
        grouping: 'Stormlight',
        // series survives MP3; grouping alone does not.
        series: 'Stormlight',
      });
      expect(plan.mode).toBe('overwrite');
      expect(plan.isSingleFile).toBe(true);
    });

    it('preview canonical exposes the new ABS fields + seriesPosition (#1671)', async () => {
      _readdirFiles = ['book.mp3'];
      setupBook({
        title: 'Words of Radiance', authors: [{ name: 'Brandon Sanderson' }],
        seriesName: 'Stormlight', seriesPosition: 0,
        asin: 'B0XYZ', subtitle: 'Sub', description: 'Desc', publisher: 'Tor',
        publishedDate: '2014-03-04', genres: ['Fantasy', 'Adventure'],
      });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.canonical).toMatchObject({
        series: 'Stormlight', seriesPart: '0', subtitle: 'Sub', asin: 'B0XYZ',
        publisher: 'Tor', description: 'Desc', date: '2014', genre: 'Fantasy',
      });
    });

    it('omits canonical fields when book has no author/narrator/series', async () => {
      _readdirFiles = ['book.mp3'];
      setupBook({ title: 'Solo' });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.canonical).toEqual({ album: 'Solo', title: 'Solo' });
    });

    it('multi-file book → per-file diff includes track row with sequential numbers', async () => {
      _readdirFiles = ['ch01.mp3', 'ch02.mp3', 'ch03.mp3'];
      setupBook({ title: 'Multi', authors: [{ name: 'Author' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const trackRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'track'));
      expect(trackRows.map(r => r.next)).toEqual(['1/3', '2/3', '3/3']);
      expect(plan.isSingleFile).toBe(false);
    });

    it('single-file book → no track row in diff', async () => {
      _readdirFiles = ['book.mp3'];
      setupBook({ title: 'Solo', authors: [{ name: 'Author' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const trackRow = plan.files[0]!.diff?.find(d => d.field === 'track');
      expect(trackRow).toBeUndefined();
    });

    it('overwrite mode: file with current tags reports will-tag with diff showing current vs next', async () => {
      _readdirFiles = ['book.mp3'];
      (parseFile as Mock).mockResolvedValue({
        common: { artist: 'Old Artist', album: 'Old Album', title: 'Old Title' },
        format: {},
      });
      setupBook({ title: 'New Title', authors: [{ name: 'New Artist' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const file = plan.files[0]!;
      expect(file.outcome).toBe('will-tag');
      const artistDiff = file.diff?.find(d => d.field === 'artist');
      expect(artistDiff).toEqual({ field: 'artist', current: 'Old Artist', next: 'New Artist' });
      const albumDiff = file.diff?.find(d => d.field === 'album');
      expect(albumDiff).toEqual({ field: 'album', current: 'Old Album', next: 'New Title' });
    });

    it('populate_missing mode: file with album="" reports will-tag with album current=null', async () => {
      _readdirFiles = ['book.mp3'];
      (parseFile as Mock).mockResolvedValue({
        common: { artist: 'Existing Artist', album: '', title: '' },
        format: {},
      });
      setupBook({ title: 'New Title', authors: [{ name: 'New Artist' }] });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing' },
      });
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const file = plan.files[0]!;
      expect(file.outcome).toBe('will-tag');
      expect(file.diff?.find(d => d.field === 'artist')).toBeUndefined();
      const albumDiff = file.diff?.find(d => d.field === 'album');
      expect(albumDiff).toEqual({ field: 'album', current: null, next: 'New Title' });
    });

    it('populate_missing mode: file with all fields populated reports skip-populated', async () => {
      _readdirFiles = ['book.mp3'];
      (parseFile as Mock).mockResolvedValue({
        common: {
          artist: 'A', albumartist: 'A', album: 'B', title: 'T', composer: ['C'], grouping: 'G',
          track: { no: 1 },
        },
        // music-metadata has no common series mapping; it round-trips through native TXXX.
        native: { 'ID3v2.4': [{ id: 'TXXX:series', value: 'G' }] },
        format: {},
      });
      setupBook({ title: 'B', authors: [{ name: 'A' }], narrators: [{ name: 'C' }], seriesName: 'G' });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing' },
      });
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.files[0]!.outcome).toBe('skip-populated');
    });

    it('unsupported formats appear in files[] with outcome skip-unsupported', async () => {
      _readdirFiles = ['book.flac', 'audio.mp3', 'extra.ogg'];
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const outcomes = plan.files.map(f => ({ file: f.file, outcome: f.outcome }));
      expect(outcomes).toContainEqual({ file: 'book.flac', outcome: 'skip-unsupported' });
      expect(outcomes).toContainEqual({ file: 'extra.ogg', outcome: 'skip-unsupported' });
      expect(outcomes).toContainEqual({ file: 'audio.mp3', outcome: 'will-tag' });
    });

    it('zero audio files: returns empty files[] with warning', async () => {
      _readdirFiles = [];
      setupBook({ title: 'X' });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.files).toEqual([]);
      expect(plan.warnings).toContain('No taggable audio files found');
    });

    it('unsupported-only folder: every entry surfaces as skip-unsupported (no taggable files)', async () => {
      _readdirFiles = ['book.flac', 'extra.ogg', 'side.wav'];
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const outcomes = plan.files.map(f => ({ file: f.file, outcome: f.outcome }));
      expect(outcomes).toEqual(
        expect.arrayContaining([
          { file: 'book.flac', outcome: 'skip-unsupported' },
          { file: 'extra.ogg', outcome: 'skip-unsupported' },
          { file: 'side.wav', outcome: 'skip-unsupported' },
        ]),
      );
      expect(plan.files).toHaveLength(3);
      expect(plan.files.every(f => f.outcome === 'skip-unsupported')).toBe(true);
      expect(plan.warnings).toContain('No taggable audio files found');
    });

    it('embedCover=true with no cover file: warning surfaced, hasCoverFile=false', async () => {
      _readdirFiles = ['book.mp3'];
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite', embedCover: true },
      });
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.warnings.some(w => w.includes('no cover image'))).toBe(true);
      expect(plan.hasCoverFile).toBe(false);
    });

    it('embedCover=true with cover present and file lacks embedded art: coverPending=true', async () => {
      _readdirFiles = ['book.mp3', 'cover.jpg'];
      (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing', embedCover: true },
      });
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.hasCoverFile).toBe(true);
      const mp3 = plan.files.find(f => f.file === 'book.mp3')!;
      expect(mp3.outcome).toBe('will-tag');
      expect(mp3.coverPending).toBe(true);
    });

    /**
     * RetagPlan carries no selected-cover filename — `hasCoverFile` is `!!coverPath` and
     * `coverPending` keys on path presence alone, so both read identically for a webp and a jpg.
     * These cases therefore assert only what the plan can actually observe; the filename decision
     * is proved on the pure picker, and preview/apply share it because `findCoverFile` is the one
     * caller of `pickCoverFile` and both paths route through it.
     */
    describe('cover probe with a shadowing webp (#2214)', () => {
      const embedCoverSettings = {
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing' as const, embedCover: true },
      };

      it.each([
        [['book.mp3', 'cover.webp', 'cover.jpg']],
        [['book.mp3', 'cover.webp']],
      ])('reports hasCoverFile for %j so the embed toggle stays enabled', async (entries) => {
        _readdirFiles = [...entries];
        (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
        setupBook({ title: 'X', authors: [{ name: 'A' }] });
        const settings = createMockSettingsService(embedCoverSettings);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);

        expect(plan.hasCoverFile).toBe(true);
        expect(plan.files.find(f => f.file === 'book.mp3')!.coverPending).toBe(true);
        expect(plan.warnings.some(w => w.includes('no cover image'))).toBe(false);
      });
    });

    it('embedCover=false: no cover-missing warning, hasCoverFile=false', async () => {
      _readdirFiles = ['book.mp3'];
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      expect(plan.warnings.some(w => w.includes('cover'))).toBe(false);
      expect(plan.hasCoverFile).toBe(false);
    });

    it('throws NOT_FOUND for unknown book id', async () => {
      mockBookService.getById.mockResolvedValue(null);
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      await expect(service.planRetag(999)).rejects.toThrow(RetagError);
    });

    it('throws NO_PATH when book.path is null', async () => {
      setupBook({ path: null });
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      await expect(service.planRetag(1)).rejects.toThrow(/no library path/);
    });

    it('throws PATH_MISSING when book.path is set but folder absent on disk', async () => {
      setupBook({ path: '/nonexistent' });
      (stat as Mock).mockRejectedValueOnce(new Error('ENOENT'));
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      await expect(service.planRetag(1)).rejects.toThrow(/does not exist on disk/);
    });

    it('throws MUTAGEN_NOT_CONFIGURED when no mutagen-capable interpreter resolves', async () => {
      setupBook({ title: 'X' });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite' },
      });
      const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

      mutagenState.resolves = false;
      try {
        await expect(service.planRetag(1)).rejects.toThrow(/mutagen module is not available/);
      } finally {
        mutagenState.resolves = true;
      }
    });

    describe('per-file title (#1090)', () => {
      it('multi-file overwrite, files with existing chapter titles → diff preserves them (no row claims book.title overwrite)', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
        // planRetag passes one read per file into planFile; planFile must not reread.
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Chapter One' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Chapter Two' }, format: {} });
        setupBook({ title: 'Multi Book', authors: [{ name: 'Author' }] });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);
        const titleRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'title'));
        expect(titleRows).toEqual([
          { field: 'title', current: 'Chapter One', next: 'Chapter One' },
          { field: 'title', current: 'Chapter Two', next: 'Chapter Two' },
        ]);
        const albumRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'album'));
        expect(albumRows.map(r => r.next)).toEqual(['Multi Book', 'Multi Book']);
      });

      it('multi-file overwrite, files without existing title → diff next=basename, current=null (never book.title)', async () => {
        _readdirFiles = ['001 - The Boy Who Lived.mp3', '002 - The Vanishing Glass.mp3'];
        setupBook({ title: "Sorcerer's Stone", authors: [{ name: 'JK Rowling' }] });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);
        const titleRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'title'));
        expect(titleRows).toEqual([
          { field: 'title', current: null, next: '001 - The Boy Who Lived' },
          { field: 'title', current: null, next: '002 - The Vanishing Glass' },
        ]);
        expect(titleRows.some(r => r.next === "Sorcerer's Stone")).toBe(false);
      });

      it('multi-file populate_missing, file has existing title → no title row in diff (resolveTags preserves)', async () => {
        _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
        (parseFile as Mock)
          .mockResolvedValueOnce({ common: { title: 'Existing 1' }, format: {} })
          .mockResolvedValueOnce({ common: { title: 'Existing 2' }, format: {} });
        setupBook({ title: 'Book Title', authors: [{ name: 'Author' }] });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'populate_missing' as const },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);
        const titleRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'title'));
        expect(titleRows).toEqual([]);
      });

      it('multi-file populate_missing, file lacks title → basename-derived title in diff (NOT book.title)', async () => {
        _readdirFiles = ['001 - First.mp3', '002 - Second.mp3'];
        setupBook({ title: 'Book Title', authors: [{ name: 'Author' }] });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'populate_missing' as const },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);
        const titleRows = plan.files.flatMap(f => (f.diff ?? []).filter(d => d.field === 'title'));
        expect(titleRows).toEqual([
          { field: 'title', current: null, next: '001 - First' },
          { field: 'title', current: null, next: '002 - Second' },
        ]);
      });

      it('single-file book preserves title=book.title in canonical and diff', async () => {
        _readdirFiles = ['book.mp3'];
        setupBook({ title: 'Solo Book', authors: [{ name: 'Author' }] });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);
        expect(plan.canonical.title).toBe('Solo Book');
        const titleRow = plan.files[0]!.diff?.find(d => d.field === 'title');
        expect(titleRow).toEqual({ field: 'title', current: null, next: 'Solo Book' });
      });
    });

    it('does NOT invoke ffmpeg, write disk, or write DB', async () => {
      _readdirFiles = ['ch01.mp3', 'ch02.mp3'];
      setupBook({ title: 'X', authors: [{ name: 'A' }] });
      const db = createMockDb();
      const settings = createMockSettingsService(taggingDefaults);
      const service = new TaggingService(db as never, settings as never, createMockLog() as never, mockBookService as never);

      await service.planRetag(1);

      expect(execFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    describe('runtime overrides', () => {
      it('mode override flips populate_missing setting to overwrite plan', async () => {
        _readdirFiles = ['book.mp3'];
        (parseFile as Mock).mockResolvedValue({
          common: { artist: 'Existing Artist', album: 'Existing Album', title: 'Existing Title' },
          format: {},
        });
        setupBook({ title: 'New Title', authors: [{ name: 'New Artist' }] });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'populate_missing' },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1, { mode: 'overwrite' });

        expect(plan.mode).toBe('overwrite');
        const artistDiff = plan.files[0]!.diff?.find(d => d.field === 'artist');
        expect(artistDiff?.current).toBe('Existing Artist');
        expect(artistDiff?.next).toBe('New Artist');
      });

      it('embedCover override true reports hasCoverFile + coverPending even when settings.embedCover=false', async () => {
        _readdirFiles = ['book.mp3', 'cover.jpg'];
        (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
        setupBook({ title: 'X', authors: [{ name: 'A' }] });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'overwrite', embedCover: false },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1, { embedCover: true });

        expect(plan.embedCover).toBe(true);
        expect(plan.hasCoverFile).toBe(true);
        expect(plan.files.find(f => f.file === 'book.mp3')?.coverPending).toBe(true);
      });

      it('embedCover override false suppresses coverPending even when settings.embedCover=true', async () => {
        _readdirFiles = ['book.mp3', 'cover.jpg'];
        (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
        setupBook({ title: 'X', authors: [{ name: 'A' }] });
        const settings = createMockSettingsService({
          processing: {},
          tagging: { enabled: true, mode: 'overwrite', embedCover: true },
        });
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1, { embedCover: false });

        expect(plan.embedCover).toBe(false);
        // Disk state stays visible so the modal can enable its cover checkbox.
        expect(plan.hasCoverFile).toBe(true);
        expect(plan.files.find(f => f.file === 'book.mp3')?.coverPending).toBeFalsy();
      });

      it('hasCoverFile reflects disk state when embedCover override left undefined (settings.embedCover=false default)', async () => {
        _readdirFiles = ['book.mp3', 'cover.jpg'];
        setupBook({ title: 'X', authors: [{ name: 'A' }] });
        const settings = createMockSettingsService(taggingDefaults);
        const service = new TaggingService(createMockDb() as never, settings as never, createMockLog() as never, mockBookService as never);

        const plan = await service.planRetag(1);

        expect(plan.embedCover).toBe(false);
        expect(plan.hasCoverFile).toBe(true);
      });
    });
  });

  describe('retagBook overrides', () => {
    let mockBookService: { getById: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
      (stat as Mock).mockResolvedValue({ size: 1000 });
      mockBookService = { getById: vi.fn().mockResolvedValue({
        id: 1, title: 'Test', path: '/library/test',
        authors: [{ name: 'A' }], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null,
      }) };
    });

    function createLog() {
      return {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
      };
    }

    it('mode override changes resolveTags behavior in the apply path', async () => {
      _readdirFiles = ['book.mp3'];
      (parseFile as Mock).mockResolvedValue({
        common: { artist: 'Existing', album: 'Existing', title: 'Existing' },
        format: {},
      });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing' },
      });
      const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

      await service.retagBook(1, new Set(), { mode: 'overwrite' });

      expect(writtenTags(0)).toMatchObject({ artist: 'A', album: 'Test' });
    });

    it('embedCover override true wires cover into the payload even when settings.embedCover=false', async () => {
      _readdirFiles = ['book.mp3', 'cover.jpg'];
      (parseFile as Mock).mockResolvedValue({ common: { picture: [] }, format: {} });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite', embedCover: false },
      });
      const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

      await service.retagBook(1, new Set(), { embedCover: true });

      expect(mutagenRequest(0).cover?.path).toMatch(/cover\.jpg$/);
    });

    it('embedCover override false suppresses cover even when settings.embedCover=true', async () => {
      _readdirFiles = ['book.mp3', 'cover.jpg'];
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite', embedCover: true },
      });
      const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

      await service.retagBook(1, new Set(), { embedCover: false });

      // mutagen never rewrites covr/APIC unless the request carries a cover, so a null cover is
      // exactly "the embedded picture is left alone".
      expect(mutagenRequest(0).cover).toBeNull();
    });

    it('omitting overrides falls back to settings (regression — bare retagBook call)', async () => {
      _readdirFiles = ['book.mp3'];
      (parseFile as Mock).mockResolvedValue({
        common: { artist: 'Existing', album: 'Existing', title: 'Existing' },
        format: {},
      });
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'populate_missing' },
      });
      const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

      await service.retagBook(1);

      expect(writtenTags(0).artist).toBeUndefined();
    });
  });
});

describe('TaggingService — preview/apply parity (#1086)', () => {
  function createLog() {
    return {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    };
  }

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
    mockBookService = { getById: vi.fn().mockResolvedValue({
      id: 1, title: 'Test', path: '/library/test',
      authors: [{ name: 'A' }], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null,
    }) };
  });

  // RetagResult exposes counts only, so derive per-file identity from the writer's target paths.
  function appliedTaggedFiles(): Set<string> {
    // basename handles OS-native separators produced by path.join.
    return new Set(writtenPaths().map(inputPath => basename(inputPath)));
  }

  for (const embedCover of [false, true] as const) {
    it(`preview will-tag set equals apply tagged set by file identity (embedCover ${embedCover ? 'on' : 'off'})`, async () => {
      const dirContents = embedCover ? ['ch01.mp3', 'ch02.mp3', 'bonus.ogg', 'cover.jpg'] : ['ch01.mp3', 'ch02.mp3', 'bonus.ogg'];
      _readdirFiles = [...dirContents];
      const settings = createMockSettingsService({
        processing: {},
        tagging: { enabled: true, mode: 'overwrite', embedCover },
      });
      const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

      const plan = await service.planRetag(1);
      const planWillTag = new Set(plan.files.filter(f => f.outcome === 'will-tag').map(f => f.file));
      const planSkipped = new Set(plan.files.filter(f => f.outcome !== 'will-tag').map(f => f.file));

      vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
      (stat as Mock).mockResolvedValue({ size: 1000 });
      _readdirFiles = [...dirContents];

      const applyResult = await service.retagBook(1);
      const applyTagged = appliedTaggedFiles();

      expect(planSkipped.has('bonus.ogg')).toBe(true);
      expect(applyTagged).toEqual(planWillTag);
      expect(applyResult.tagged).toBe(planWillTag.size);
    });
  }

  it('multi-file overwrite: preview per-file `title` next-values equal what apply writes (#1090 parity)', async () => {
    _readdirFiles = ['ch01.mp3', 'ch02.mp3', 'ch03.mp3'];
    mockBookService.getById.mockResolvedValue({
      id: 1, title: 'Book Title', path: '/library/test',
      authors: [{ name: 'A' }], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null,
    });
    // parseFile's queue follows sorted ch01/ch02/ch03 order.
    (parseFile as Mock)
      .mockResolvedValueOnce({ common: { title: 'Existing 1' }, format: {} })
      .mockResolvedValueOnce({ common: {}, format: {} })
      .mockResolvedValueOnce({ common: { title: 'Existing 3' }, format: {} });
    const settings = createMockSettingsService({
      processing: {},
      tagging: { enabled: true, mode: 'overwrite' as const },
    });
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    const plan = await service.planRetag(1);
    const planTitlesByFile = new Map(
      plan.files.map(f => [f.file, f.diff?.find(d => d.field === 'title')?.next ?? null] as const),
    );
    expect(planTitlesByFile.get('ch01.mp3')).toBe('Existing 1');
    expect(planTitlesByFile.get('ch02.mp3')).toBe('ch02');
    expect(planTitlesByFile.get('ch03.mp3')).toBe('Existing 3');

    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
    _readdirFiles = ['ch01.mp3', 'ch02.mp3', 'ch03.mp3'];
    (parseFile as Mock)
      .mockResolvedValueOnce({ common: { title: 'Existing 1' }, format: {} })
      .mockResolvedValueOnce({ common: {}, format: {} })
      .mockResolvedValueOnce({ common: { title: 'Existing 3' }, format: {} });

    await service.retagBook(1);

    const applyTitleByFile = new Map<string, string | undefined>();
    writtenPaths().forEach((inputPath, index) => {
      applyTitleByFile.set(basename(inputPath), writtenTags(index).title);
    });
    expect(applyTitleByFile.get('ch01.mp3')).toBe('Existing 1');
    expect(applyTitleByFile.get('ch02.mp3')).toBe('ch02');
    expect(applyTitleByFile.get('ch03.mp3')).toBe('Existing 3');
  });

  it('preview will-tag set matches apply tagged set (embedCover on with cover file)', async () => {
    _readdirFiles = ['ch01.mp3', 'cover.jpg'];
    const settings = createMockSettingsService({
      processing: {},
      tagging: { enabled: true, mode: 'overwrite', embedCover: true },
    });
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    const plan = await service.planRetag(1);
    expect(plan.files.find(f => f.file === 'ch01.mp3')?.outcome).toBe('will-tag');
    expect(plan.hasCoverFile).toBe(true);

    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
    _readdirFiles = ['ch01.mp3', 'cover.jpg'];

    const applyResult = await service.retagBook(1);
    expect(applyResult.tagged).toBe(1);
  });
});

describe('TaggingService — multi-value serialization (#71, #79)', () => {
  const taggingDefaults = {
    processing: {},
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  function createLog() {
    return {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    };
  }

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
    _readdirFiles = ['book.mp3'];
    mockBookService = { getById: vi.fn() };
  });

  function setupBook(authors: { name: string }[], narrators: { name: string }[]) {
    mockBookService.getById.mockResolvedValue({
      id: 1, title: 'Test Book', path: '/library/test',
      authors, narrators,
      seriesName: null, seriesPosition: null, coverUrl: null,
    });
  }

  it('authors ["Brandon Sanderson", "Robert Jordan"] → artist tag uses ", " delimiter', async () => {
    setupBook([{ name: 'Brandon Sanderson' }, { name: 'Robert Jordan' }], []);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    expect(writtenTags(0).artist).toBe('Brandon Sanderson, Robert Jordan');
  });

  it('narrators ["Kate Reading", "Michael Kramer"] → composer tag uses ", " delimiter', async () => {
    setupBook([{ name: 'Brandon Sanderson' }], [{ name: 'Kate Reading' }, { name: 'Michael Kramer' }]);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    expect(writtenTags(0).composer).toBe('Kate Reading, Michael Kramer');
  });

  it('single narrator → composer tag = narrator name only (no trailing ", ")', async () => {
    setupBook([{ name: 'Brandon Sanderson' }], [{ name: 'Michael Kramer' }]);
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, createLog() as never, mockBookService as never);

    await service.retagBook(1);

    expect(writtenTags(0).composer).toBe('Michael Kramer');
  });
});

describe('TaggingService.retagBook() via BookService.getById() (issue #79)', () => {
  const taggingDefaults = {
    processing: {},
    tagging: { enabled: true, mode: 'overwrite' as const },
  };

  let mockBookService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
    _readdirFiles = ['book.mp3'];
    mockBookService = { getById: vi.fn().mockResolvedValue({
      id: 7, title: 'Dune', path: '/library/dune',
      authors: [{ name: 'Frank Herbert' }],
      narrators: [{ name: 'Scott Brick' }],
      seriesName: null, seriesPosition: null, coverUrl: null,
    }) };
  });

  it('retagBook() calls BookService.getById() rather than raw junction queries', async () => {
    const db = { select: vi.fn() };
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService(db as never, settings as never, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    } as never, mockBookService as never);

    await service.retagBook(7);

    expect(mockBookService.getById).toHaveBeenCalledWith(7);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('author and narrator names passed to tagger match BookWithAuthor shape', async () => {
    const db = { select: vi.fn() };
    const settings = createMockSettingsService(taggingDefaults);
    const service = new TaggingService(db as never, settings as never, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn(),
    } as never, mockBookService as never);

    await service.retagBook(7);

    expect(writtenTags(0)).toMatchObject({ artist: 'Frank Herbert', composer: 'Scott Brick' });
  });
});

describe('tag-write serialization (#2210 AC20/D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutagenState.requests.length = 0;
    mutagenState.outcomes.length = 0;
    (stat as Mock).mockResolvedValue({ size: 1000 });
  });

  /** Hold the helper open on the first call so the second write's start is observable. */
  function armGatedHelper(): { release: () => void; started: string[] } {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    (execFile as unknown as Mock).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (...cbArgs: unknown[]) => void;
      return {
        stdin: {
          on: () => {},
          end: (data: string) => {
            const request = JSON.parse(data) as MutagenRequest;
            mutagenState.requests.push(request);
            started.push(request.ops[0]?.value ?? '');
            const verified: Record<string, string> = {};
            for (const op of request.ops) verified[op.key] = op.value;
            const respond = () => cb(null, JSON.stringify({ ok: true, verified }), '');
            if (started.length === 1) void gate.then(respond);
            else respond();
          },
        },
      };
    });

    return { release, started };
  }

  it('serializes two overlapping writes to the same file — the second waits for the first', async () => {
    const { release, started } = armGatedHelper();

    const first = tagFile('/books/file.m4b', '/usr/bin/python3', { album: 'first' }, 'overwrite');
    const second = tagFile('/books/file.m4b', '/usr/bin/python3', { album: 'second' }, 'overwrite');
    await Promise.resolve();
    await Promise.resolve();

    // The second helper must not have started while the first was still verifying.
    expect(started).toEqual(['first']);

    release();
    const results = await Promise.all([first, second]);

    expect(results.map(r => r.status)).toEqual(['tagged', 'tagged']);
    expect(started).toEqual(['first', 'second']);
    // Both executed in turn and each carried its own payload — chained, not coalesced.
    expect(writtenTags(0).album).toBe('first');
    expect(writtenTags(1).album).toBe('second');
  });

  it('does not serialize writes to different files', async () => {
    const { release, started } = armGatedHelper();

    const slow = tagFile('/books/one.m4b', '/usr/bin/python3', { album: 'one' }, 'overwrite');
    const fast = await tagFile('/books/two.m4b', '/usr/bin/python3', { album: 'two' }, 'overwrite');

    expect(fast.status).toBe('tagged');
    expect(started).toEqual(['one', 'two']);

    release();
    await slow;
  });

  it('serializes a manual retag against a post-merge retag of the same book', async () => {
    _readdirFiles = ['book.m4b'];
    const settings = createMockSettingsService({ processing: {}, tagging: { enabled: true, mode: 'overwrite' as const } });
    const bookService = { getById: vi.fn().mockResolvedValue({
      id: 1, title: 'Dune', path: '/library/dune',
      authors: [{ name: 'Frank Herbert' }], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null,
    }) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() };
    const service = new TaggingService({ select: vi.fn() } as never, settings as never, log as never, bookService as never);

    const [manual, postMerge] = await Promise.all([
      service.retagBook(1),
      service.retagBook(1, new Set(['title'])),
    ]);

    // Each reports only its own outcome; neither claims the other's work.
    expect(manual.tagged).toBe(1);
    expect(postMerge.tagged).toBe(1);
    expect(mutagenState.requests).toHaveLength(2);
    expect(writtenTags(0).title).toBe('Dune');
    expect(writtenTags(1).title).toBeUndefined();
  });

  // Without this, a callback-shape regression is indistinguishable from a legitimately skipped
  // write: no request is captured either way (execfile-mock-dual-callback-shape).
  it('mock-shape regression guard: the helper payload parses into non-null fields', async () => {
    await tagFile('/books/file.m4b', '/usr/bin/python3', { album: 'Book', artist: 'Author' }, 'overwrite');

    const request = mutagenRequest(0);
    expect(request.path).toBe('/books/file.m4b');
    expect(request.format).toBe('mp4');
    expect(request.ops.length).toBeGreaterThan(0);
    expect(request.ops.every(op => typeof op.key === 'string' && typeof op.value === 'string')).toBe(true);
  });
});
