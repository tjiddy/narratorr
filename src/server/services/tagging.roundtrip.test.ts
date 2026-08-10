/**
 * Real-file coverage for the mutagen tag writer (#2210), complementing the mocked tagging suite.
 *
 * TWO capabilities gate this file: ffmpeg/ffprobe (to BUILD fixtures and to probe chapters, audio
 * duration and decodability) and a Python that can `import mutagen` (to WRITE and to read back).
 * Both are absent on CI, so a green `pnpm verify` is not evidence for anything proved only here —
 * run the file explicitly and read the EXECUTED count (round-trip-fixture-discipline).
 *
 * **ffprobe cannot see the movement atoms.** After mutagen writes `©mvn`/`©mvi`, ffprobe's tag dump
 * shows nothing, so any ffprobe-based assertion of this feature passes whether or not the write
 * happened. Every tag assertion below goes through `readExistingTags` (the production observable)
 * or a raw mutagen dump; ffprobe is used only for chapters, stream duration and decodability.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaggingService, tagFile, type TagMetadata } from './tagging.service.js';
import { readExistingTags } from './retag-plan.js';
import { resetMutagenPythonCache } from '@core/utils/mutagen-resolver.js';

const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

function detectFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Detection and use must agree: a Python without mutagen is a miss, exactly as production treats it. */
function detectMutagenPython(): string | null {
  for (const candidate of [process.env.MUTAGEN_PYTHON?.trim(), '/usr/bin/python3', 'python3']) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['-c', 'import mutagen'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const HAS_FFMPEG = detectFfmpeg();
const PYTHON = detectMutagenPython();
const CAN_RUN = HAS_FFMPEG && PYTHON !== null;

/** Raw mutagen dump — the only observable that can see `©mvn`/`©mvi`/`MVNM`/`MVIN` at all. */
const DUMP_PROGRAM = `
import json, sys
path = sys.argv[1]
out = {}
if path.lower().endswith('.mp3'):
    from mutagen.id3 import ID3, ID3NoHeaderError
    try:
        tag = ID3(path)
    except ID3NoHeaderError:
        tag = None
    if tag is not None:
        for key, frame in tag.items():
            if key.startswith('APIC'):
                out[key] = 'picture:' + str(len(frame.data))
            elif getattr(frame, 'text', None):
                out[key] = str(frame.text[0])
else:
    from mutagen.mp4 import MP4
    for key, value in MP4(path).items():
        first = value[0]
        if key == 'covr':
            out[key] = 'picture:' + str(len(bytes(first)))
        elif isinstance(first, bytes):
            out[key] = first.decode('utf-8')
        elif isinstance(first, tuple):
            out[key] = '/'.join(str(part) for part in first)
        else:
            out[key] = str(first)
sys.stdout.write(json.dumps(out))
`;

function dumpTags(file: string): Record<string, string> {
  const stdout = execFileSync(PYTHON!, ['-c', DUMP_PROGRAM, file], { encoding: 'utf8' });
  return JSON.parse(stdout) as Record<string, string>;
}

function readChapterCount(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_chapters', file], { encoding: 'utf8' });
  return ((JSON.parse(out).chapters ?? []) as unknown[]).length;
}

/**
 * The AUDIO stream's duration, never the container's: an m4b's `format=duration` is the max track
 * duration, so the chapter text track keeps it at full length even when the audio was truncated.
 */
function audioStreamDuration(file: string): number {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  return Number((JSON.parse(out).streams?.[0]?.duration ?? '0'));
}

/**
 * The section selector must be `stream_disposition`, not `stream=disposition`: the latter yields an
 * empty object per stream (measured on ffprobe 7.0.2), so the helper would report "no cover" for
 * every file, including ones that plainly carry one.
 */
function hasAttachedPic(file: string): boolean {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const streams = (JSON.parse(out).streams ?? []) as { disposition?: { attached_pic?: number } }[];
  return streams.some(s => s.disposition?.attached_pic === 1);
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
  track: 1,
  trackTotal: 3,
};

describe.skipIf(!CAN_RUN)('mutagen tag-write round-trip (real ffmpeg + real mutagen)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'narratorr-mutagen-roundtrip-'));
  });

  afterAll(() => {
    // Windows keeps handles open; a leaked tmpdir is cheaper than a red suite.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tolerated */ }
  });

  function makeAudio(name: string, seconds = 6): string {
    const path = join(dir, name);
    const codec = name.endsWith('.mp3') ? 'libmp3lame' : 'aac';
    // Duration lives inside the filter: a positional -t binds to the NEXT -i, not the previous one.
    execFileSync(FFMPEG, [
      '-y', '-v', 'quiet', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', codec, path,
    ], { stdio: 'ignore' });
    return path;
  }

  function makeChapteredM4b(name: string): string {
    const base = makeAudio(`base-${name}`);
    const metaPath = join(dir, `${name}.ffmeta`);
    writeFileSync(metaPath, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=3000', 'title=Chapter 1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=3000', 'END=6000', 'title=Chapter 2',
      '',
    ].join('\n'));
    const out = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', base, '-i', metaPath, '-map_chapters', '1', '-c', 'copy', out], { stdio: 'ignore' });
    return out;
  }

  function makeCover(name: string, colour: string, size: string): string {
    const path = join(dir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:d=1`, '-frames:v', '1', path], { stdio: 'ignore' });
    return path;
  }

  async function write(file: string, tags: TagMetadata, coverPath?: string) {
    return tagFile(file, PYTHON!, tags, 'overwrite', coverPath);
  }

  describe('every field round-trips through readExistingTags (AC2/AC8)', () => {
    it.each([
      ['M4B', 'full.m4b'],
      ['M4A', 'full.m4a'],
      ['MP3', 'full.mp3'],
    ])('%s writes and reads back the whole tag set', async (_label, name) => {
      const file = makeAudio(name);

      const result = await write(file, FULL_TAGS);
      expect(result.status).toBe('tagged');

      // readExistingTags is what populate_missing and the retag-preview diff actually consult.
      expect(await readExistingTags(file)).toMatchObject({
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
        track: 1,
        trackTotal: 3,
      });
    });

    it('M4B carries the four atoms ffmpeg silently discarded', async () => {
      const file = makeAudio('dropped-set.m4b');
      await write(file, FULL_TAGS);

      const raw = dumpTags(file);
      expect(raw['----:com.apple.iTunes:SERIES']).toBe('The Stormlight Archive');
      expect(raw['----:com.apple.iTunes:SUBTITLE']).toBe('Book Two');
      expect(raw['----:com.apple.iTunes:ASIN']).toBe('B00ABCDEFG');
      expect(raw['----:com.apple.iTunes:PUBLISHER']).toBe('Tor Books');
    });
  });

  describe('series channels (AC3/AC4/AC5)', () => {
    it('M4B writes ©mvn + ©mvi alongside the lossless freeform', async () => {
      const file = makeAudio('series.m4b');
      await write(file, FULL_TAGS);

      const raw = dumpTags(file);
      expect(raw['©mvn']).toBe('The Stormlight Archive');
      expect(raw['©mvi']).toBe('2');
      expect(raw['----:com.apple.iTunes:SERIES-PART']).toBe('2');
      // The series book count is not on the retag input, so ©mvc is never written (D3).
      expect(raw['©mvc']).toBeUndefined();
    });

    it('MP3 writes genuine MVNM/MVIN frames, not TXXX freeform only', async () => {
      const file = makeAudio('series.mp3');
      await write(file, FULL_TAGS);

      const raw = dumpTags(file);
      expect(raw.MVNM).toBe('The Stormlight Archive');
      expect(raw.MVIN).toBe('2');
      expect(raw['TXXX:series']).toBe('The Stormlight Archive');
    });

    it('a fractional position writes no ©mvi, still succeeds, and round-trips exactly', async () => {
      const file = makeAudio('fractional.m4b');

      const result = await write(file, { album: 'Novella', series: 'The Stormlight Archive', seriesPart: 2.5 });

      expect(result.status).toBe('tagged');
      expect(dumpTags(file)['©mvi']).toBeUndefined();
      expect(dumpTags(file)['----:com.apple.iTunes:SERIES-PART']).toBe('2.5');
      expect((await readExistingTags(file)).seriesPart).toBe(2.5);
    });

    it('position zero writes ©mvi = 0 and round-trips', async () => {
      const file = makeAudio('zero.m4b');

      await write(file, { album: 'Prequel', series: 'S', seriesPart: 0 });

      expect(dumpTags(file)['©mvi']).toBe('0');
      expect((await readExistingTags(file)).seriesPart).toBe(0);
    });

    it('no seriesPosition writes no movement atoms and still succeeds', async () => {
      const file = makeAudio('no-position.m4b');

      const result = await write(file, { album: 'Standalone', series: 'S' });

      expect(result.status).toBe('tagged');
      const raw = dumpTags(file);
      expect(raw['©mvn']).toBe('S');
      expect(raw['©mvi']).toBeUndefined();
      expect(raw['----:com.apple.iTunes:SERIES-PART']).toBeUndefined();
    });
  });

  describe('track pairing', () => {
    it.each([
      ['track without trackTotal', { track: 1 } as TagMetadata],
      ['trackTotal without track', { trackTotal: 3 } as TagMetadata],
    ])('%s writes no half-populated trkn', async (label, partial) => {
      const file = makeAudio(`${label.replace(/[^a-z]/gi, '-')}.m4b`);

      await write(file, { album: 'Book', ...partial });

      expect(dumpTags(file).trkn).toBeUndefined();
    });

    it('a complete pair writes trkn and reads back as track + trackTotal', async () => {
      const file = makeAudio('track-pair.m4b');

      await write(file, { album: 'Book', track: 2, trackTotal: 5 });

      expect(dumpTags(file).trkn).toBe('2/5');
      expect(await readExistingTags(file)).toMatchObject({ track: 2, trackTotal: 5 });
    });
  });

  describe('integrity (AC6/AC7/AC12)', () => {
    it('a retag leaves chapters, audio duration and decodability untouched', async () => {
      const file = makeChapteredM4b('chaptered.m4b');
      const chaptersBefore = readChapterCount(file);
      const durationBefore = audioStreamDuration(file);
      expect(chaptersBefore).toBe(2);

      await write(file, FULL_TAGS);

      expect(readChapterCount(file)).toBe(chaptersBefore);
      const durationAfter = audioStreamDuration(file);
      // A band, not toBeCloseTo: AAC priming/padding is version- and bitrate-dependent.
      expect(durationAfter).toBeGreaterThan(durationBefore - 0.5);
      expect(durationAfter).toBeLessThan(durationBefore + 0.5);

      // Decode the whole stream: a non-zero exit here would mean a truncated or corrupt payload.
      expect(() => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: 'ignore' })).not.toThrow();
    });

    it('leaves an M4A decodable with its audio duration intact', async () => {
      // .m4a rides the same MP4 branch as .m4b but has no chapter track, so it needs its own case.
      const file = makeAudio('preserved.m4a');
      const durationBefore = audioStreamDuration(file);

      const result = await write(file, FULL_TAGS);

      expect(result.status).toBe('tagged');
      const durationAfter = audioStreamDuration(file);
      expect(durationAfter).toBeGreaterThan(durationBefore - 0.5);
      expect(durationAfter).toBeLessThan(durationBefore + 0.5);
      expect(() => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: 'ignore' })).not.toThrow();
    });

    it('does not rewrite the audio payload — the delta is metadata-scale (AC7)', async () => {
      // No cover on either side, so metadata is the ONLY thing that can change.
      const file = makeAudio('no-remux.m4b', 30);
      const sizeBefore = statSync(file).size;

      const result = await write(file, FULL_TAGS);
      const sizeAfter = statSync(file).size;

      expect(result.sizeBefore).toBe(sizeBefore);
      expect(result.sizeAfter).toBe(sizeAfter);
      // A remux would reproduce the whole payload; a header patch cannot approach 10% of it.
      expect(Math.abs(sizeAfter - sizeBefore)).toBeLessThan(sizeBefore * 0.1);
      expect(sizeBefore).toBeGreaterThan(100_000);
    });

    it('an overwrite that SHRINKS the file still reports tagged (AC12)', async () => {
      const file = makeAudio('shrink.m4b');
      const bigCover = makeCover('big-cover.png', 'red', '1200x1200');
      const smallCover = makeCover('small-cover.jpg', 'blue', '32x32');

      await write(file, { album: 'Book', description: 'x'.repeat(20_000) }, bigCover);
      const sizeBefore = statSync(file).size;

      const result = await write(file, { album: 'Book', description: 'short' }, smallCover);

      expect(statSync(file).size).toBeLessThan(sizeBefore);
      // The predicate is read-back, never size: a smaller replacement cover is a legitimate shrink.
      expect(result.status).toBe('tagged');
      expect((await readExistingTags(file)).description).toBe('short');
    });
  });

  describe('cover art (AC10)', () => {
    it.each([
      ['JPEG', 'cover-jpeg.jpg', 'jpeg.m4b'],
      ['PNG', 'cover-png.png', 'png.m4b'],
    ])('embeds a %s cover on M4B', async (_label, coverName, audioName) => {
      const file = makeAudio(audioName);
      const cover = makeCover(coverName, 'green', '64x64');

      const result = await write(file, { album: 'Book' }, cover);

      expect(result.status).toBe('tagged');
      expect(dumpTags(file).covr).toMatch(/^picture:\d+$/);
    });

    it('embeds a JPEG cover on MP3 as an APIC frame', async () => {
      const file = makeAudio('cover.mp3');
      const cover = makeCover('mp3-cover.jpg', 'green', '64x64');

      await write(file, { album: 'Book' }, cover);

      const raw = dumpTags(file);
      expect(Object.keys(raw).some(key => key.startsWith('APIC'))).toBe(true);
    });

    it('warns but still writes every other field for a .webp cover (D4)', async () => {
      const file = makeAudio('webp.m4b');
      const cover = makeCover('cover.webp', 'green', '64x64');

      const result = await write(file, FULL_TAGS, cover);

      expect(result.status).toBe('tagged');
      expect(result.warnings).toEqual(['Cover art format not supported for embedding: .webp']);
      expect(dumpTags(file).covr).toBeUndefined();
      expect((await readExistingTags(file)).asin).toBe('B00ABCDEFG');
    });

    it('leaves an existing embedded picture untouched when no cover is supplied (AC10)', async () => {
      const file = makeAudio('keeps-art.m4b');
      await write(file, { album: 'First' }, makeCover('keep-cover.jpg', 'red', '64x64'));
      const before = dumpTags(file).covr;
      expect(before).toMatch(/^picture:\d+$/);

      await write(file, { album: 'Second' });

      expect(dumpTags(file).covr).toBe(before);
      expect(hasAttachedPic(file)).toBe(true);
    });
  });

  describe('value shapes', () => {
    it('non-ASCII values round-trip byte-exact on both formats (AC17)', async () => {
      const awkward: TagMetadata = {
        artist: 'Ana Gutiérrez',
        album: 'The Reader’s Companion',
        title: '漢字のタイトル',
        description: 'Ünïcödé — em dash, curly ’quote’, 中文.',
      };

      for (const name of ['unicode.m4b', 'unicode.mp3']) {
        const file = makeAudio(name);
        await write(file, awkward);
        expect(await readExistingTags(file)).toMatchObject(awkward);
      }
    });

    it('a description over 64 KB survives the stdin boundary', async () => {
      const file = makeAudio('long-description.m4b');
      const description = 'x'.repeat(70_000);

      const result = await write(file, { album: 'Book', description });

      expect(result.status).toBe('tagged');
      expect((await readExistingTags(file)).description).toBe(description);
    });

    it('a book with no author, narrator, series, ASIN, publisher or genre writes only what it has', async () => {
      const file = makeAudio('sparse.m4b');

      const result = await write(file, { album: 'Just A Title', title: 'Just A Title' });

      expect(result.status).toBe('tagged');
      const tags = await readExistingTags(file);
      expect(tags).toMatchObject({ album: 'Just A Title', title: 'Just A Title' });
      expect(tags.artist).toBeUndefined();
      expect(tags.series).toBeUndefined();
    });

    it('an unparseable file reads back as {} rather than throwing', async () => {
      const notAudio = join(dir, 'garbage.m4b');
      writeFileSync(notAudio, 'this is not an mp4 at all');

      expect(await readExistingTags(notAudio)).toEqual({});
    });
  });

  describe('populate_missing (AC8 parity)', () => {
    it('a second consecutive populate_missing pass rewrites nothing', async () => {
      const file = makeAudio('populate.m4b');

      const first = await tagFile(file, PYTHON!, FULL_TAGS, 'populate_missing');
      expect(first.status).toBe('tagged');

      const second = await tagFile(file, PYTHON!, FULL_TAGS, 'populate_missing');

      // Publisher used to make this impossible: common.publisher was never populated, so every
      // pass saw current=null and rewrote it.
      expect(second.status).toBe('skipped');
      expect(second.reason).toBe('All tags already populated');
    });
  });

  describe('backward compatibility with the pre-mutagen ffmpeg path (AC9)', () => {
    /** Reproduce the exact `-metadata` shape the removed buildFfmpegArgs used to emit. */
    function writeLegacyTags(name: string): string {
      const src = makeAudio(`legacy-src-${name}`);
      const out = join(dir, name);
      execFileSync(FFMPEG, [
        '-y', '-v', 'quiet', '-i', src, '-c:a', 'copy', '-map_chapters', '0',
        '-metadata', 'album=Legacy Book',
        '-metadata', 'series=The Stormlight Archive',
        '-metadata', 'series-part=3',
        out,
      ], { stdio: 'ignore' });
      return out;
    }

    it.each(['legacy.mp3', 'legacy.m4b'])('still reads series/seriesPart from a %s tagged by ffmpeg', async (name) => {
      const file = writeLegacyTags(name);

      const tags = await readExistingTags(file);

      expect(tags.album).toBe('Legacy Book');
      if (name.endsWith('.mp3')) {
        // On M4B ffmpeg dropped these outright, which is the defect; on MP3 they must still read.
        expect(tags.series).toBe('The Stormlight Archive');
        expect(tags.seriesPart).toBe(3);
      }
    });

    it('populate_missing over a legacy-tagged MP3 does not rewrite what it can already see', async () => {
      const file = writeLegacyTags('legacy-populate.mp3');

      const result = await tagFile(file, PYTHON!, {
        album: 'Different Book', series: 'Different Series', seriesPart: 9,
      }, 'populate_missing');

      expect(result.status).toBe('skipped');
      const tags = await readExistingTags(file);
      expect(tags.series).toBe('The Stormlight Archive');
      expect(tags.seriesPart).toBe(3);
    });
  });

  describe('concurrency against one real file (AC20)', () => {
    it('two overlapping writes serialize and the file ends with the second payload in full', async () => {
      const file = makeAudio('concurrent.m4b');

      const [first, second] = await Promise.all([
        tagFile(file, PYTHON!, { album: 'First Album', artist: 'First Artist', asin: 'FIRSTASIN1' }, 'overwrite'),
        tagFile(file, PYTHON!, { album: 'Second Album', artist: 'Second Artist', asin: 'SECONDASIN' }, 'overwrite'),
      ]);

      expect([first.status, second.status]).toEqual(['tagged', 'tagged']);
      const tags = await readExistingTags(file);
      // No field from the first write may survive in a slot the second one wrote.
      expect(tags).toMatchObject({ album: 'Second Album', artist: 'Second Artist', asin: 'SECONDASIN' });
    });

    it('a reader concurrent with a write never throws', async () => {
      const file = makeAudio('reader-during-write.m4b');

      const [, tags] = await Promise.all([
        tagFile(file, PYTHON!, FULL_TAGS, 'overwrite'),
        readExistingTags(file),
      ]);

      // Per D7 readers are deliberately unlocked: {} or a complete read, but never a throw.
      expect(typeof tags).toBe('object');
    });
  });

  describe('unsupported input', () => {
    it('short-circuits an .ogg to skipped before spawning anything', async () => {
      const file = join(dir, 'book.ogg');
      writeFileSync(file, 'placeholder');

      const result = await tagFile(file, PYTHON!, FULL_TAGS, 'overwrite');

      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('.ogg');
    });
  });
});

/**
 * A single-file merged book cannot re-enter merge, so retag is its recovery path. This is the
 * headline #2210 proof: the four fields the pre-mutagen writer asserted as `undefined` here are
 * now present in the file itself.
 */
describe.skipIf(!CAN_RUN)('#2078 re-tag self-heals a metadata-naked merged m4b, now including the dropped set', () => {
  let bookDir: string;

  beforeAll(() => {
    bookDir = mkdtempSync(join(tmpdir(), 'narratorr-2078-selfheal-'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    resetMutagenPythonCache();
    try { rmSync(bookDir, { recursive: true, force: true }); } catch { /* tolerated */ }
  });

  beforeEach(() => {
    // Stub rather than assign so afterAll restores the ambient value.
    vi.stubEnv('MUTAGEN_PYTHON', PYTHON!);
    resetMutagenPythonCache();
  });

  function makeNakedMergedM4b(name: string): string {
    const base = join(bookDir, `base-${name}`);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', base], { stdio: 'ignore' });

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

  function makeService(path: string) {
    const bookService = {
      getById: async () => ({
        id: 1, title: 'The Way of Kings', path,
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
    return new TaggingService(null as never, settingsService as never, log as never, bookService as never);
  }

  it('restores the canonical set INCLUDING series, subtitle, ASIN and publisher', async () => {
    const merged = makeNakedMergedM4b('The Way of Kings.m4b');
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1', '-frames:v', '1', join(bookDir, 'cover.jpg')], { stdio: 'ignore' });

    const before = await readExistingTags(merged);
    expect(before.artist).toBeUndefined();
    expect(before.album).toBeUndefined();
    expect(hasAttachedPic(merged)).toBe(false);
    expect(readChapterCount(merged)).toBe(2);

    const result = await makeService(bookDir).retagBook(1);
    expect(result.failed).toBe(0);
    expect(result.tagged).toBe(1);

    const after = await readExistingTags(merged);
    expect(after.artist).toBe('Brandon Sanderson, Co Author');
    expect(after.albumArtist).toBe('Brandon Sanderson, Co Author');
    expect(after.composer).toBe('Michael Kramer, Kate Reading');
    expect(after.album).toBe('The Way of Kings');
    expect(after.grouping).toBe('The Stormlight Archive');
    expect(after.date).toBe('2010');
    expect(after.genre).toBe('Fantasy');
    expect(after.description).toBe('An epic fantasy.');

    // The whole point of #2210: these four were asserted `undefined` under the ffmpeg writer.
    expect(after.series).toBe('The Stormlight Archive');
    expect(after.subtitle).toBe('Book One');
    expect(after.asin).toBe('B00ABCDEFG');
    expect(after.publisher).toBe('Tor Books');

    expect(hasAttachedPic(merged)).toBe(true);
    expect(readChapterCount(merged)).toBe(2);
  });

  it('an import-path pass leaves the full set on disk with chapters intact', async () => {
    const importDir = mkdtempSync(join(tmpdir(), 'narratorr-2210-import-'));
    try {
      const merged = makeNakedMergedM4b('Import Book.m4b');
      const target = join(importDir, 'Import Book.m4b');
      copyFileSync(merged, target);

      const { embedTagsForImport } = await import('../utils/import-steps.js');
      await embedTagsForImport({
        taggingService: makeService(importDir),
        taggingEnabled: true,
        taggingMode: 'overwrite',
        embedCover: false,
        bookId: 1,
        targetPath: importDir,
        book: {
          title: 'The Way of Kings', authorName: 'Brandon Sanderson', narrator: 'Michael Kramer',
          seriesName: 'The Stormlight Archive', seriesPosition: 1, asin: 'B00ABCDEFG',
          subtitle: 'Book One', publisher: 'Tor Books', coverUrl: null,
        },
        log: { info: () => {}, warn: () => {}, debug: () => {} } as never,
      });

      expect(await readExistingTags(target)).toMatchObject({
        album: 'The Way of Kings', series: 'The Stormlight Archive',
        asin: 'B00ABCDEFG', subtitle: 'Book One', publisher: 'Tor Books',
      });
      expect(readChapterCount(target)).toBe(2);
    } finally {
      try { rmSync(importDir, { recursive: true, force: true }); } catch { /* tolerated */ }
    }
  });
});
