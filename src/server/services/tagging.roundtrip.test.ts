/**
 * Real-ffmpeg round-trip tests for the embedded tag-write set (#1671).
 *
 * The main tagging suite (`tagging.service.test.ts`) fully mocks `child_process`,
 * `music-metadata`, and `fs`, so it can prove arg construction but NOT that the
 * tags actually survive a real ffmpeg write + ffprobe read. This file fills that
 * gap with a real harness: it generates tiny mp3/m4b fixtures via ffmpeg, writes
 * tags using the real `buildFfmpegArgs` output, and reads them back with ffprobe.
 *
 * The per-field survival contract is container-specific and was proven empirically
 * on ffmpeg 8.1: MP3 keeps the full set; M4B drops the freeform
 * `series`/`series-part`/`subtitle`/`asin`/`publisher` atoms (those reach ABS via
 * OPF instead) while `album`/`album_artist`/`grouping`/`date`/`genre`/`description`
 * survive. xHE-AAC / USAC decode depends on ffmpeg 8 (#1667), so the suite skips
 * when the runtime ffmpeg major is < 8 — but it MUST run in the ffmpeg-8 CI lane.
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

/** Runtime ffmpeg major, or null when ffmpeg is absent/unparseable. */
function detectFfmpegMajor(): number | null {
  try {
    const out = execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' });
    // First line is like "ffmpeg version 8.0.1-...". extractFfmpegMajor strips the
    // leading non-digit run ("ffmpeg version "/"n"/"v") before the major token.
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

/** Write tags via the production arg builder, returning the tagged output path. */
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

    // Plex path + fields that survive M4B (encode the empirical constraint per-field).
    expect(tags.album).toBe('Words of Radiance');
    expect(tags.album_artist).toBe('Brandon Sanderson');
    expect(tags.grouping).toBe('The Stormlight Archive');
    expect(tags.date).toBe('2014');
    expect(tags.genre).toBe('Fantasy');
    expect(tags.description).toBe('An epic fantasy.');

    // Dropped by the M4B container with bare -metadata (ABS-via-OPF instead).
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

    // Regression guard: the arg builder must request chapter mapping.
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

// ============================================================================
// #2078 — a tag write must not destroy the cover art it was not asked to touch,
// and a re-tag must be able to SELF-HEAL an already-merged, metadata-naked m4b.
//
// Gated on ffmpeg PRESENCE rather than the ≥8 floor above: nothing here decodes xHE-AAC, and
// the M4B survival contract these assert against (album/album_artist/artist/composer/grouping/
// date/genre/description survive; the freeform series/subtitle/asin/publisher atoms do not) is
// the same one the ffmpeg-8 block documents.
// ============================================================================

const hasAnyFfmpeg = major !== null;

/** True when the file carries a video stream flagged `attached_pic`. */
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

  /** An m4b with an embedded picture, and optionally its own chapter set. */
  function makeArtM4b(name: string, opts: { chapters?: boolean } = {}): string {
    const cover = makeCoverJpg(`${name}.src.jpg`);
    const path = join(dir, name);
    execFileSync(FFMPEG, [
      '-y', '-v', 'quiet',
      // Duration lives INSIDE the filter: a positional `-t` here would bind to the next
      // input (the cover), leaving anullsrc unbounded and the command running forever.
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

    // The exact `populate_missing` shape: `shouldEmbedCover` is false precisely BECAUSE the
    // file already has art, so `tagFile` passes no coverPath. Pre-#2078 the args were
    // `-map 0:a` alone and this remux silently dropped the picture.
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
 * AC19 / F6 — the self-heal path for the 12 already-naked production files.
 *
 * An already-merged book has exactly ONE top-level audio file, and both merge admission gates
 * reject a single-file book (`NO_TOP_LEVEL_FILES`), so a re-merge cannot recover it. The
 * existing re-tag action is the recovery path — which is why AC16 matters: before this issue a
 * `populate_missing` re-tag of a file that already had art DESTROYED that art.
 *
 * This drives the real `retagBook` end to end (canonical hydrated-book → tag projection, disk
 * cover discovery, the temp + atomic-rename write) rather than `buildFfmpegArgs` alone, so it
 * also pins AC15's multi-author/multi-narrator joins on a real read-back.
 */
describe.skipIf(!hasAnyFfmpeg)('#2078 re-tag self-heals a metadata-naked merged m4b (AC15, AC19)', () => {
  let bookDir: string;

  beforeAll(() => {
    bookDir = mkdtempSync(join(tmpdir(), 'narratorr-2078-selfheal-'));
  });

  afterAll(() => {
    if (bookDir) rmSync(bookDir, { recursive: true, force: true });
    // Restore the AMBIENT value rather than deleting the key: a runner or dev machine may have
    // its own FFMPEG_PATH configured, and unconditionally unsetting it makes every later suite
    // order-dependent on this one. Reset the resolver cache AFTER restoring, so the next caller
    // re-resolves against the restored environment rather than this suite's override.
    vi.unstubAllEnvs();
    resetFfmpegPathCache();
  });

  /** Exactly what auto-merge produced in production: chapters, no tags, no embedded art. */
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
    // The disk cover `retagBook` will find via `findCoverFile(book.path)`.
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1', '-frames:v', '1', join(bookDir, 'cover.jpg')], { stdio: 'ignore' });

    // Baseline: the reported production symptom — structural tags only, no art, chapters present.
    const before = readTags(merged);
    expect(before.artist).toBeUndefined();
    expect(before.album).toBeUndefined();
    expect(hasAttachedPic(merged)).toBe(false);
    expect(readChapterCount(merged)).toBe(2);

    // `resolveFfmpegPath` honors FFMPEG_PATH first, so the real resolver runs unmocked.
    // `stubEnv` (not a raw assignment) so `vi.unstubAllEnvs()` in afterAll puts back whatever
    // the ambient value was — including "not set at all".
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
    // AC15 — the canonical projection joins ALL authors and ALL narrators with ', '. Asserted
    // against the M4B-SURVIVING subset documented in this file's header, not the full shape.
    expect(after.artist).toBe('Brandon Sanderson, Co Author');
    expect(after.album_artist).toBe('Brandon Sanderson, Co Author');
    expect(after.composer).toBe('Michael Kramer, Kate Reading');
    expect(after.album).toBe('The Way of Kings');
    expect(after.grouping).toBe('The Stormlight Archive');
    expect(after.date).toBe('2010');
    expect(after.genre).toBe('Fantasy');
    expect(after.description).toBe('An epic fantasy.');
    // Same container contract the ffmpeg-8 block pins: the freeform atoms do not survive M4B.
    expect(after.series).toBeUndefined();
    expect(after.asin).toBeUndefined();

    // AC19 — the cover is newly embedded from disk, and the chapter set is untouched.
    expect(hasAttachedPic(merged)).toBe(true);
    expect(readChapterCount(merged)).toBe(2);
  });
});
