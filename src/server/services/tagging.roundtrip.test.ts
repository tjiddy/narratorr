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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFfmpegArgs, type TagMetadata } from './tagging.service.js';
import { extractFfmpegMajor } from '../../core/utils/ffmpeg-version.js';

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
