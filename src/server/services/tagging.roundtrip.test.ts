/**
 * Real ffmpeg/ffprobe coverage complements the mocked tagging suite. Measured on ffmpeg 8.1:
 * MP3 retains every tag; M4B drops freeform series/subtitle/ASIN/publisher atoms but retains
 * Plex fields, date, genre, and description. xHE-AAC requires ffmpeg 8, so CI must exercise that lane.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaggingService, buildFfmpegArgs, type TagMetadata } from './tagging.service.js';
import { resetFfmpegPathCache } from '@core/utils/audio-processor.js';
import { extractFfmpegMajor } from '@core/utils/ffmpeg-version.js';

const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

function detectFfmpegMajor(): number | null {
  try {
    const out = execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' });
    const firstLine = out.split('\n')[0] ?? '';
    return extractFfmpegMajor(firstLine);
  } catch {
    return null;
  }
}

const major = detectFfmpegMajor();
const hasFfmpeg8 = major !== null && major >= 8;

/** Read format-level tags as a lowercased-key map (ffprobe casing varies by container). */
function readTags(file: string): Record<string, string> {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8' });
  const tags = (JSON.parse(out).format?.tags ?? {}) as Record<string, unknown>;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) lower[k.toLowerCase()] = String(v);
  return lower;
}

function readChapterCount(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_chapters', file], { encoding: 'utf8' });
  return ((JSON.parse(out).chapters ?? []) as unknown[]).length;
}

function writeTags(input: string, output: string, tags: TagMetadata): string {
  execFileSync(FFMPEG, buildFfmpegArgs(input, output, tags), { stdio: 'ignore' });
  return output;
}

const FULL_TAGS: TagMetadata = {
  artist: 'Brandon Sanderson',
  albumArtist: 'Brandon Sanderson',
  album: 'Words of Radiance',
  title: 'Words of Radiance',
  composer: 'Michael Kramer',
  grouping: 'The Stormlight Archive',
  series: 'The Stormlight Archive',
  seriesPart: 2,
  subtitle: 'Book Two',
  asin: 'B00ABCDEFG',
  publisher: 'Tor Books',
  description: 'An epic fantasy.',
  date: '2014',
  genre: 'Fantasy',
};

describe.skipIf(!hasFfmpeg8)('tag-write round-trip (real ffmpeg ≥ 8)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'narratorr-roundtrip-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeMp3(name: string): string {
    const path = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'libmp3lame', path], { stdio: 'ignore' });
    return path;
  }

  function makeM4b(name: string): string {
    const path = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-c:a', 'aac', path], { stdio: 'ignore' });
    return path;
  }

  function makeChapteredM4b(name: string): string {
    const base = makeM4b(`base-${name}`);
    const metaPath = join(dir, `${name}.ffmeta`);
    writeFileSync(metaPath, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=3000', 'title=Chapter 1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=3000', 'END=6000', 'title=Chapter 2',
      '',
    ].join('\n'));
    const out = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-i', base, '-i', metaPath, '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', out], { stdio: 'ignore' });
    return out;
  }

  it('MP3 keeps every field with the exact mapping-table value', () => {
    const src = makeMp3('book.mp3');
    const tagged = writeTags(src, join(dir, 'book.tagged.mp3'), FULL_TAGS);
    const tags = readTags(tagged);

    expect(tags.artist).toBe('Brandon Sanderson');
    expect(tags.album_artist).toBe('Brandon Sanderson');
    expect(tags.album).toBe('Words of Radiance');
    expect(tags.composer).toBe('Michael Kramer');
    expect(tags.grouping).toBe('The Stormlight Archive');
    expect(tags.series).toBe('The Stormlight Archive');
    expect(tags['series-part']).toBe('2');
    expect(tags.subtitle).toBe('Book Two');
    expect(tags.asin).toBe('B00ABCDEFG');
    expect(tags.publisher).toBe('Tor Books');
    expect(tags.description).toBe('An epic fantasy.');
    expect(tags.date).toBe('2014');
    expect(tags.genre).toBe('Fantasy');
  });

  it('M4B drops the freeform set but keeps Plex + survivable fields', () => {
    const src = makeM4b('book.m4b');
    const tagged = writeTags(src, join(dir, 'book.tagged.m4b'), FULL_TAGS);
    const tags = readTags(tagged);

    // Empirically surviving M4B fields.
    expect(tags.album).toBe('Words of Radiance');
    expect(tags.album_artist).toBe('Brandon Sanderson');
    expect(tags.grouping).toBe('The Stormlight Archive');
    expect(tags.date).toBe('2014');
    expect(tags.genre).toBe('Fantasy');
    expect(tags.description).toBe('An epic fantasy.');

    // Bare -metadata drops these M4B atoms; ABS receives them through OPF instead.
    expect(tags.series).toBeUndefined();
    expect(tags['series-part']).toBeUndefined();
    expect(tags.subtitle).toBeUndefined();
    expect(tags.asin).toBeUndefined();
    expect(tags.publisher).toBeUndefined();
  });

  it('series-part=0 round-trips on MP3 (!= null, not truthy)', () => {
    const src = makeMp3('zero.mp3');
    const tagged = writeTags(src, join(dir, 'zero.tagged.mp3'), { album: 'B', seriesPart: 0 });
    expect(readTags(tagged)['series-part']).toBe('0');
  });

  it('re-tagging an M4B preserves its chapters (#1671 chapter footgun)', () => {
    const chaptered = makeChapteredM4b('chaptered.m4b');
    const before = readChapterCount(chaptered);
    expect(before).toBeGreaterThanOrEqual(2);

    const args = buildFfmpegArgs(chaptered, join(dir, 'chaptered.tagged.m4b'), { album: 'Retagged' });
    expect(args).toContain('-map_chapters');

    const tagged = writeTags(chaptered, join(dir, 'chaptered.tagged.m4b'), { album: 'Retagged' });
    expect(readChapterCount(tagged)).toBe(before);
  });

  it('overwrite Plex path yields clean album + album_artist', () => {
    const src = makeMp3('plex.mp3');
    const tagged = writeTags(src, join(dir, 'plex.tagged.mp3'), {
      album: 'Words of Radiance', albumArtist: 'Brandon Sanderson',
    });
    const tags = readTags(tagged);
    expect(tags.album).toBe('Words of Radiance');
    expect(tags.album_artist).toBe('Brandon Sanderson');
  });
});

// Cover/self-heal cases need any ffmpeg: they do not decode xHE-AAC and use the same M4B contract above.
const hasAnyFfmpeg = major !== null;

function hasAttachedPic(file: string): boolean {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  return ((JSON.parse(out).streams ?? []) as Array<{ disposition?: { attached_pic?: number } }>)
    .some((s) => s.disposition?.attached_pic === 1);
}

describe.skipIf(!hasAnyFfmpeg)('#2078 cover art survives a re-tag (real ffmpeg)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'narratorr-2078-tag-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeCoverJpg(name: string): string {
    const path = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', path], { stdio: 'ignore' });
    return path;
  }

  function makeArtM4b(name: string, opts: { chapters?: boolean } = {}): string {
    const cover = makeCoverJpg(`${name}.src.jpg`);
    const path = join(dir, name);
    execFileSync(FFMPEG, [
      '-y', '-v', 'quiet',
      // Keep duration inside the filter: positional -t binds to the cover input and leaves anullsrc infinite.
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=6',
      '-i', cover,
      '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v', 'attached_pic',
      path,
    ], { stdio: 'ignore' });
    if (!opts.chapters) return path;

    const metaPath = join(dir, `${name}.ffmeta`);
    writeFileSync(metaPath, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=3000', 'title=Chapter 1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=3000', 'END=6000', 'title=Chapter 2',
      '',
    ].join('\n'));
    const out = join(dir, `chaptered-${name}`);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', path, '-i', metaPath, '-map_metadata', '0', '-map_chapters', '1', '-c', 'copy', out], { stdio: 'ignore' });
    return out;
  }

  it('a tag write with NO cover input keeps the file\'s existing picture (AC16)', () => {
    const src = makeArtM4b('has-art.m4b');
    expect(hasAttachedPic(src)).toBe(true);

    // populate_missing passes no coverPath when art exists; mapping audio alone would silently drop it.
    const tagged = writeTags(src, join(dir, 'has-art.tagged.m4b'), { album: 'Retagged' });

    expect(hasAttachedPic(tagged)).toBe(true);
    expect(readTags(tagged).album).toBe('Retagged');
  });

  it('a tag write on a file with NO picture stream still succeeds (the `?` in -map 0:v?)', () => {
    const src = join(dir, 'no-art.mp3');
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1', '-c:a', 'libmp3lame', src], { stdio: 'ignore' });
    const tagged = writeTags(src, join(dir, 'no-art.tagged.mp3'), { album: 'Retagged' });

    expect(hasAttachedPic(tagged)).toBe(false);
    expect(readTags(tagged).album).toBe('Retagged');
  });

  it('a re-tag preserves BOTH the existing picture and the chapter set (AC16 + AC17)', () => {
    const src = makeArtM4b('art-and-chapters.m4b', { chapters: true });
    const before = readChapterCount(src);
    expect(before).toBe(2);
    expect(hasAttachedPic(src)).toBe(true);

    const tagged = writeTags(src, join(dir, 'art-and-chapters.tagged.m4b'), { album: 'Retagged' });

    expect(hasAttachedPic(tagged)).toBe(true);
    expect(readChapterCount(tagged)).toBe(before);
  });
});

/**
 * A single-file merged book cannot re-enter merge, so retag is its recovery path. Exercise real
 * projection, cover discovery, atomic replacement, and multi-author/narrator read-back end to end.
 */
describe.skipIf(!hasAnyFfmpeg)('#2078 re-tag self-heals a metadata-naked merged m4b (AC15, AC19)', () => {
  let bookDir: string;

  beforeAll(() => {
    bookDir = mkdtempSync(join(tmpdir(), 'narratorr-2078-selfheal-'));
  });

  afterAll(() => {
    if (bookDir) rmSync(bookDir, { recursive: true, force: true });
    // Restore ambient FFMPEG_PATH before resetting the cache or later suites become order-dependent.
    vi.unstubAllEnvs();
    resetFfmpegPathCache();
  });

  function makeNakedMergedM4b(name: string): string {
    const base = join(bookDir, `base-${name}`);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=6', '-c:a', 'aac', base], { stdio: 'ignore' });

    const metaPath = join(bookDir, `${name}.ffmeta`);
    writeFileSync(metaPath, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=3000', 'title=Chapter 1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=3000', 'END=6000', 'title=Chapter 2',
      '',
    ].join('\n'));

    const out = join(bookDir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', base, '-i', metaPath, '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', out], { stdio: 'ignore' });
    rmSync(base);
    rmSync(metaPath);
    return out;
  }

  it('restores the canonical tag set, embeds the disk cover, and leaves chapters intact', async () => {
    const merged = makeNakedMergedM4b('The Way of Kings.m4b');
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1', '-frames:v', '1', join(bookDir, 'cover.jpg')], { stdio: 'ignore' });

    const before = readTags(merged);
    expect(before.artist).toBeUndefined();
    expect(before.album).toBeUndefined();
    expect(hasAttachedPic(merged)).toBe(false);
    expect(readChapterCount(merged)).toBe(2);

    // Stub rather than assign so afterAll restores the ambient FFMPEG_PATH.
    vi.stubEnv('FFMPEG_PATH', FFMPEG);
    resetFfmpegPathCache();

    const bookService = {
      getById: async () => ({
        id: 1, title: 'The Way of Kings', path: bookDir,
        authors: [{ name: 'Brandon Sanderson' }, { name: 'Co Author' }],
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
        seriesName: 'The Stormlight Archive', seriesPosition: 1,
        asin: 'B00ABCDEFG', subtitle: 'Book One', description: 'An epic fantasy.',
        publisher: 'Tor Books', publishedDate: '2010-08-31', genres: ['Fantasy', 'Epic'],
        coverUrl: null,
      }),
    };
    const settingsService = { get: async () => ({ mode: 'overwrite' as const, embedCover: true }) };
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    const service = new TaggingService(
      null as never, settingsService as never, log as never, bookService as never,
    );

    const result = await service.retagBook(1);
    expect(result.failed).toBe(0);
    expect(result.tagged).toBe(1);

    const after = readTags(merged);
    // Assert joined authors/narrators only through the M4B-surviving subset documented above.
    expect(after.artist).toBe('Brandon Sanderson, Co Author');
    expect(after.album_artist).toBe('Brandon Sanderson, Co Author');
    expect(after.composer).toBe('Michael Kramer, Kate Reading');
    expect(after.album).toBe('The Way of Kings');
    expect(after.grouping).toBe('The Stormlight Archive');
    expect(after.date).toBe('2010');
    expect(after.genre).toBe('Fantasy');
    expect(after.description).toBe('An epic fantasy.');
    expect(after.series).toBeUndefined();
    expect(after.asin).toBeUndefined();

    expect(hasAttachedPic(merged)).toBe(true);
    expect(readChapterCount(merged)).toBe(2);
  });
});
