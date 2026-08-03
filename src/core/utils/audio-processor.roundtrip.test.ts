/**
 * Real-ffmpeg round-trip tests for the #2068 encode strategy.
 *
 * `audio-processor.test.ts` mocks `node:child_process` wholesale, so it can prove what argv
 * this module CONSTRUCTS but not that ffmpeg accepts it — and the two defects this issue is
 * really about live on that boundary: whether the concat demuxer will stream-copy the set at
 * all, and whether `libmp3lame` accepts the bitrate we picked. This file fills that gap with
 * real fixtures, following the harness pattern in `src/server/services/tagging.roundtrip.test.ts`.
 *
 * It guards on ffmpeg PRESENCE (that suite's ffmpeg-8 floor is an xHE-AAC concern that does
 * not apply here). Fixtures are non-silent on purpose: `anullsrc` silence encodes to almost
 * nothing, which makes a nominal `-b:a` an unstable expectation, so every fixture is a 440 Hz
 * sine and every bitrate expectation is compared against the fixture's own MEASURED stream
 * bit_rate rather than the flag it was generated with.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, renameSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAudioFiles, type ProcessingConfig, type ProcessingContext } from './audio-processor.js';
import { MP3_BITRATES_MPEG2 } from './encode-strategy.js';

const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

function hasFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_PRESENT = hasFfmpeg();

interface StreamFacts {
  codecName: string;
  bitRate: number;
  sampleRate: number;
  channels: number;
}

function probeStream(file: string): StreamFacts {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const s = JSON.parse(out).streams?.[0] ?? {};
  return {
    codecName: String(s.codec_name),
    bitRate: Number.parseInt(String(s.bit_rate), 10),
    sampleRate: Number.parseInt(String(s.sample_rate), 10),
    channels: Number(s.channels),
  };
}

function chapterTitles(file: string): string[] {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_chapters', file], { encoding: 'utf8' });
  return ((JSON.parse(out).chapters ?? []) as Array<{ tags?: { title?: string } }>)
    .map((c) => c.tags?.title ?? '');
}

/**
 * md5 of the file's copied audio PACKETS. The md5 muxer hashes packet payloads, so this is
 * container-agnostic: two files carrying the same encoded frames digest identically, and any
 * re-encode changes it. This is the primary no-re-encode oracle.
 */
function audioPacketDigest(inputArgs: string[]): string {
  const out = execFileSync(FFMPEG, ['-v', 'quiet', ...inputArgs, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' });
  return out.trim();
}

const CONTEXT: ProcessingContext = { author: 'Sanderson', title: 'Oathbringer' };

function keepOriginal(outputFormat: 'm4b' | 'mp3'): ProcessingConfig {
  return { ffmpegPath: FFMPEG, outputFormat, mergeBehavior: 'always' };
}

describe.skipIf(!FFMPEG_PRESENT)('#2068 encode strategy round-trip (real ffmpeg)', () => {
  let root: string;
  let caseIndex = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'narratorr-encode-strategy-'));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A fresh per-test directory, since mergeFiles deletes its sources on success. */
  function caseDir(): string {
    const dir = join(root, `case-${caseIndex++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Generate one deterministic, non-silent part. `extraArgs` sets the codec and any bitrate;
   * the caller reads back the MEASURED bit_rate rather than trusting the flag.
   */
  function makePart(dir: string, name: string, opts: {
    seconds?: number;
    sampleRate?: number;
    channels?: number;
    codecArgs: string[];
  }): string {
    const path = join(dir, name);
    const { seconds = 4, sampleRate = 44_100, channels = 2 } = opts;
    execFileSync(FFMPEG, [
      '-y', '-v', 'quiet',
      '-f', 'lavfi',
      '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`,
      '-ac', String(channels),
      ...opts.codecArgs,
      path,
    ], { stdio: 'ignore' });
    return path;
  }

  function outputIn(dir: string, ext: string): string {
    const found = readdirSync(dir).find((f) => f.toLowerCase().endsWith(ext));
    if (!found) throw new Error(`no ${ext} output in ${dir} (saw ${readdirSync(dir).join(', ')})`);
    return join(dir, found);
  }

  function concatListFor(dir: string, files: string[]): string {
    const listPath = join(dir, 'reference-concat.txt');
    writeFileSync(listPath, files.map((f) => `file '${f}'`).join('\n'), 'utf-8');
    return listPath;
  }

  it('stream-copies a homogeneous 256 kbps AAC set and keeps the generated chapters', async () => {
    const dir = caseDir();
    const parts = ['01.m4b', '02.m4b', '03.m4b'].map((name) =>
      makePart(dir, name, { codecArgs: ['-c:a', 'aac', '-b:a', '256k'] }));
    const measured = probeStream(parts[0]!);

    // Both computed BEFORE the run — mergeFiles deletes its sources on success.
    const listPath = concatListFor(dir, parts);
    const reference = audioPacketDigest(['-f', 'concat', '-safe', '0', '-i', listPath]);

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.m4b');
    // Primary oracle: identical packets ⇒ no re-encode happened.
    expect(audioPacketDigest(['-i', merged])).toBe(reference);

    // Secondary, readable: a re-encode at ffmpeg's implicit ~128k default would blow this band.
    const out = probeStream(merged);
    expect(out.codecName).toBe('aac');
    expect(Math.abs(out.bitRate - measured.bitRate) / measured.bitRate).toBeLessThan(0.1);

    expect(chapterTitles(merged)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  });

  it('re-encodes homogeneous 128 kbps MP3 parts into m4b at a comparable rate', async () => {
    const dir = caseDir();
    ['01.mp3', '02.mp3'].forEach((name) =>
      makePart(dir, name, { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '128k'] }));

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);

    // A well-conditioned case on purpose: 128 is comfortably inside both encoders' legal
    // domains, so the observed rate is a stable expectation. This is NOT a general
    // "output >= source" claim — no such claim is made anywhere.
    const out = probeStream(outputIn(dir, '.m4b'));
    expect(out.codecName).toBe('aac');
    expect(Math.abs(out.bitRate - 128_000) / 128_000).toBeLessThan(0.1);
  });

  it('reaches the real MPEG-2 encoder for a 22.05 kHz source, where a naive 320k is re-rated', async () => {
    const dir = caseDir();
    // The sources must be INELIGIBLE for a stream copy, or this proves nothing about the
    // encoder command: a homogeneous 22.05 kHz `.mp3`/mp3 set into mp3 output is copy-eligible,
    // so it would take `-c:a copy` and the read-back would only observe the fixture's own rate.
    // `.wav`/pcm_s16le can never copy into mp3, so the production call genuinely reaches
    // libmp3lame — which is the boundary AC8a exists to defend.
    ['01.wav', '02.wav'].forEach((name) =>
      makePart(dir, name, { sampleRate: 22_050, codecArgs: ['-c:a', 'pcm_s16le'] }));
    const source = join(dir, '01.wav');

    // Counterfactual first, while the sources still exist: at 22.05 kHz LAME does not deliver
    // the MPEG-1 answer. Observed on ffmpeg 6.0, it silently re-rates 320k down to 160k rather
    // than failing — silent re-rating is exactly why the target is snapped before it is emitted.
    const naive = join(dir, 'naive.mp3');
    let naiveRate: number | null;
    try {
      execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', source, '-c:a', 'libmp3lame', '-b:a', '320k', naive], { stdio: 'ignore' });
      naiveRate = probeStream(naive).bitRate;
    } catch {
      naiveRate = null; // an outright rejection is the other legal way for the naive path to break
    }
    expect(naiveRate).not.toBe(320_000);
    rmSync(naive, { force: true });

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    // Proves the ENCODE branch was taken, not the copy branch: only an encode records an
    // `mp3-table` step, and 705 kbps is the PCM source rate snapped to the MPEG-2 maximum.
    expect(result.warnings!.some((w) => w.includes('705') && w.includes('160'))).toBe(true);

    const out = probeStream(outputIn(dir, '.mp3'));
    // A pcm_s16le source cannot yield an mp3 stream without a real encode.
    expect(out.codecName).toBe('mp3');
    // Asserted against the constant table rather than a hand-typed literal, so a future edit
    // to MP3_BITRATES_MPEG2 cannot silently make the "legal at this rate" claim false.
    expect(MP3_BITRATES_MPEG2.map((k) => k * 1000)).toContain(out.bitRate);
    expect(out.bitRate).toBeLessThanOrEqual(160_000);
    expect(out.sampleRate).toBe(22_050);
  });

  it('legalizes an explicit 512 kbps mp3 target down to 320 kbps at 44.1 kHz', async () => {
    const dir = caseDir();
    ['01.mp3', '02.mp3'].forEach((name) =>
      makePart(dir, name, { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'] }));

    const result = await processAudioFiles(dir, { ...keepOriginal('mp3'), bitrate: 512 }, CONTEXT);
    expect(result.success).toBe(true);
    expect(probeStream(outputIn(dir, '.mp3')).bitRate).toBe(320_000);
  });

  it('raises a sub-table request to the 32 kbps MPEG-1 minimum rather than emitting it', async () => {
    const dir = caseDir();
    ['01.mp3', '02.mp3'].forEach((name) =>
      makePart(dir, name, { codecArgs: ['-c:a', 'libmp3lame', '-b:a', '8k'] }));

    const result = await processAudioFiles(dir, { ...keepOriginal('mp3'), bitrate: 8 }, CONTEXT);
    expect(result.success).toBe(true);
    expect(probeStream(outputIn(dir, '.mp3')).bitRate).toBe(32_000);
  });

  it('emits no -ar, so a 48 kHz source keeps its sample rate through an mp3 encode', async () => {
    const dir = caseDir();
    ['01.m4a', '02.m4a'].forEach((name) =>
      makePart(dir, name, { sampleRate: 48_000, codecArgs: ['-c:a', 'aac', '-b:a', '128k'] }));

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);
    expect(probeStream(outputIn(dir, '.mp3')).sampleRate).toBe(48_000);
  });

  it('is honest about a lossless source: it succeeds, discloses the cap, and claims nothing about the output', async () => {
    const dir = caseDir();
    ['01.wav', '02.wav'].forEach((name) =>
      makePart(dir, name, { channels: 1, codecArgs: ['-c:a', 'pcm_s16le'] }));

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);
    // 44.1 kHz mono PCM is 705 kbps; we request the 512 cap and say so.
    expect(result.warnings!.some((w) => w.includes('705') && w.includes('512'))).toBe(true);
    // Deliberately NO assertion relating the output bitrate to the request or to the source:
    // FFmpeg's AAC encoder clamps to its per-frame limit (~265 kbps here), and this module
    // neither predicts nor claims that.
    expect(probeStream(outputIn(dir, '.m4b')).codecName).toBe('aac');
  });

  it('caps the same lossless source at 320 kbps for mp3, with the same disclosure', async () => {
    const dir = caseDir();
    ['01.wav', '02.wav'].forEach((name) =>
      makePart(dir, name, { channels: 1, codecArgs: ['-c:a', 'pcm_s16le'] }));

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);
    expect(result.warnings!.some((w) => w.includes('705') && w.includes('320'))).toBe(true);
    expect(probeStream(outputIn(dir, '.mp3')).bitRate).toBeLessThanOrEqual(320_000);
  });
});

// ============================================================================
// #2078 — a merge must not destroy the metadata and cover art its sources had.
//
// The mocked suite can only prove what argv this module CONSTRUCTS. The production defect was
// downstream of that: `-map_metadata 1` pointed at the generated FFMETADATA1 file, which has
// only [CHAPTER] blocks, so ffmpeg wrote an EMPTY global tag set and every auto-merged m4b came
// out carrying nothing but `major_brand`/`encoder`. Only a real read-back can see that.
//
// Gated on ffmpeg PRESENCE, like the block above: nothing here needs the ffmpeg-8 xHE-AAC floor.
// ============================================================================

/** Format-level tags as a lowercased-key map (ffprobe casing varies by container). */
function readFormatTags(file: string): Record<string, string> {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8' });
  const tags = (JSON.parse(out).format?.tags ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/** True when the file carries a video stream flagged `attached_pic` (an embedded cover). */
function hasAttachedPic(file: string): boolean {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  return ((JSON.parse(out).streams ?? []) as Array<{ disposition?: { attached_pic?: number } }>)
    .some((s) => s.disposition?.attached_pic === 1);
}

/**
 * The AUDIO STREAM's duration — deliberately NOT `format=duration`.
 *
 * In an m4b the chapter track counts toward the container duration, so `format=duration` reads
 * the full 9 s even when only the 3 s first part was muxed: it CANNOT see the truncation
 * `-map 0:a` exists to prevent. The audio stream's own duration can.
 */
function audioStreamDuration(file: string): number {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  return Number.parseFloat(String(JSON.parse(out).streams?.[0]?.duration));
}

/** The tags every fixture part carries, so a naked output is unambiguous. */
const SOURCE_TAGS: Record<string, string> = {
  artist: 'Brandon Sanderson',
  album_artist: 'Brandon Sanderson',
  album: 'Oathbringer',
  date: '2017',
  genre: 'Fantasy',
};

const PART_SECONDS = 3;

describe.skipIf(!FFMPEG_PRESENT)('#2078 merge preserves source metadata and cover art (real ffmpeg)', () => {
  let root: string;
  let caseIndex = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'narratorr-2078-'));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function caseDir(): string {
    const dir = join(root, `case-${caseIndex++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeCover(dir: string): string {
    const path = join(dir, 'art.jpg');
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', path], { stdio: 'ignore' });
    return path;
  }

  /**
   * One tagged, non-silent part. `cover` embeds an attached picture; `internalChapters` gives
   * the part its OWN chapter set, which is what makes the `-map_chapters` assertion real —
   * ffmpeg's default picks the input with the MOST chapters, so a part carrying more chapters
   * than the generated set would win without the explicit map.
   */
  function makeTaggedPart(dir: string, name: string, opts: {
    codecArgs: string[];
    title: string;
    cover?: string | undefined;
    internalChapters?: number | undefined;
  }): string {
    const path = join(dir, name);
    const metadataArgs = Object.entries({ ...SOURCE_TAGS, title: opts.title })
      .flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

    execFileSync(FFMPEG, [
      '-y', '-v', 'quiet',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${PART_SECONDS}`,
      ...(opts.cover ? ['-i', opts.cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
      ...opts.codecArgs,
      ...metadataArgs,
      path,
    ], { stdio: 'ignore' });

    if (!opts.internalChapters) return path;

    const metaPath = join(dir, `${name}.internal.ffmeta`);
    const slice = Math.floor((PART_SECONDS * 1000) / opts.internalChapters);
    writeFileSync(metaPath, [';FFMETADATA1', ...Array.from({ length: opts.internalChapters }, (_, i) =>
      ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${i * slice}`, `END=${(i + 1) * slice}`, `title=Source Chapter ${i + 1}`].join('\n'),
    )].join('\n') + '\n', 'utf-8');

    const withChapters = join(dir, `chaptered-${name}`);
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', path, '-i', metaPath, '-map_metadata', '0', '-map_chapters', '1', '-c', 'copy', withChapters], { stdio: 'ignore' });
    rmSync(path);
    rmSync(metaPath);
    renameSync(withChapters, path);
    return path;
  }

  function outputIn(dir: string, ext: string): string {
    const found = readdirSync(dir).find((f) => f.toLowerCase().endsWith(ext));
    if (!found) throw new Error(`no ${ext} output in ${dir} (saw ${readdirSync(dir).join(', ')})`);
    return join(dir, found);
  }

  /**
   * The output must carry the WHOLE book, not just the metadata donor's single part.
   *
   * A band rather than `toBeCloseTo`: an AAC re-encode adds encoder priming/padding that
   * differs by ffmpeg version (~24 ms on copy, ~42 ms at 64 kbps here), which would sit right
   * on `toBeCloseTo(…, 0)`'s 0.05 edge. Half a second still separates the 9 s whole from a
   * truncated 3 s first part by a factor the assertion can never confuse.
   */
  function expectFullBookDuration(file: string): void {
    const total = PART_SECONDS * 3;
    const actual = audioStreamDuration(file);
    expect(actual, `audio-stream duration of ${file}`).toBeGreaterThan(total - 0.5);
    expect(actual, `audio-stream duration of ${file}`).toBeLessThan(total + 0.5);
  }

  /**
   * Every tag the sources carried, INCLUDING the global `title`.
   *
   * `title` is passed per scenario rather than folded into SOURCE_TAGS because it is the one
   * field whose expected value differs by fixture: a merge inherits the metadata DONOR's title
   * (part 01's `Part 1`), while a convert keeps the single file's own. Leaving it out of the
   * shared set is exactly how a merge or convert could silently drop or overwrite the global
   * title with the whole real-ffmpeg suite still green.
   */
  function expectSourceTagsPreserved(file: string, expectedTitle: string): void {
    const tags = readFormatTags(file);
    for (const [key, value] of Object.entries(SOURCE_TAGS)) {
      expect(tags[key], `tag "${key}" on ${file}`).toBe(value);
    }
    expect(tags.title, `tag "title" on ${file}`).toBe(expectedTitle);
  }

  /** Build a tagged, chaptered, cover-bearing 3-part set. Part 01 carries 5 internal chapters. */
  function buildParts(dir: string, ext: string, codecArgs: string[], opts: { cover?: boolean } = {}): string[] {
    const cover = opts.cover === false ? undefined : makeCover(dir);
    return ['01', '02', '03'].map((n, i) => makeTaggedPart(dir, `${n}.${ext}`, {
      codecArgs, title: `Part ${i + 1}`, cover,
      ...(i === 0 && { internalChapters: 5 }),
    }));
  }

  it('m4b stream-copy: keeps the source tags, the cover, the generated chapters and the full duration', async () => {
    const dir = caseDir();
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k']);

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.m4b');
    // AC1/AC5 — pre-#2078 this read `{major_brand, minor_version, compatible_brands, encoder}`.
    expectSourceTagsPreserved(merged, 'Part 1');
    // AC8 — the extract/reattach lifecycle survives the 60 s stall timer and lands the picture.
    expect(hasAttachedPic(merged)).toBe(true);
    // AC3/F5 — the generated set (3, from the parts' title tags) beats part 01's competing 5.
    expect(chapterTitles(merged)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    // AC2 — the whole book, not just the metadata donor's 3 s.
    expectFullBookDuration(merged);
    // AC4 — the extra input forced no re-encode.
    expect(probeStream(merged).codecName).toBe('aac');
    expect(result.warnings ?? []).toEqual([]);
  });

  it('m4b encode mode: the same guarantees hold when the set is re-encoded (AC3, AC4)', async () => {
    const dir = caseDir();
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k']);

    // A usable explicit target always re-encodes, whatever the source codec.
    const result = await processAudioFiles(dir, { ...keepOriginal('m4b'), bitrate: 64 }, CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.m4b');
    expectSourceTagsPreserved(merged, 'Part 1');
    expect(hasAttachedPic(merged)).toBe(true);
    expect(chapterTitles(merged)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    expectFullBookDuration(merged);
  });

  it('mp3 output: global tags survive, and there is deliberately NO embedded cover (AC8b)', async () => {
    const dir = caseDir();
    buildParts(dir, 'mp3', ['-c:a', 'libmp3lame', '-b:a', '128k']);

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.mp3');
    // The mp3 merge path has no generated-chapter input, so the first source is input 1.
    expectSourceTagsPreserved(merged, 'Part 1');
    // Pinned, not implied: `withCoverArtPipeline` gains no MP3 reattach arm in this issue.
    expect(hasAttachedPic(merged)).toBe(false);
    // #2083 AC3 — the missing observation point. Part 01 is built with 5 internal CHAP chapters
    // and is opened as the metadata donor, so before the `-map_chapters -1` fix ffmpeg's default
    // chapter mapping copied all 5 onto a 9 s output where they spanned the first 3 s.
    expect(chapterTitles(merged)).toEqual([]);
    // #2083 AC7 — the suppression introduces no new warning on the copy path.
    expect(result.warnings ?? []).toEqual([]);
  });

  it('mp3 encode mode: chapters stay suppressed, tags and full duration survive (#2083 AC4–AC6)', async () => {
    const dir = caseDir();
    // aac/`.m4b` sources are structurally copy-ineligible for an mp3 output, so `libmp3lame`
    // genuinely runs. Building mp3/libmp3lame parts and ASSUMING the encode branch would leave
    // this case silently duplicating the copy-mode one above.
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k']);

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.mp3');
    expect(probeStream(merged).codecName).toBe('mp3'); // the encode branch really ran
    expect(chapterTitles(merged)).toEqual([]);         // AC4
    expectSourceTagsPreserved(merged, 'Part 1');       // AC5
    expectFullBookDuration(merged);                    // AC6
    // Deliberately NOT `toEqual([])`: an encode legitimately emits bitrate-legalization
    // notices here, which are pre-existing #2068 behaviour, not something this fix introduced.
    expect((result.warnings ?? []).filter((w) => /chapter/i.test(w))).toEqual([]);
  });

  it('sources with no embedded art merge cleanly, with no spurious cover warning', async () => {
    const dir = caseDir();
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k'], { cover: false });

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.m4b');
    expectSourceTagsPreserved(merged, 'Part 1');
    expect(hasAttachedPic(merged)).toBe(false);
    expect(result.warnings ?? []).toEqual([]);
  });

  it('convert path: a per-file convert keeps its tags and its cover (AC18)', async () => {
    const dir = caseDir();
    const cover = makeCover(dir);
    makeTaggedPart(dir, 'book.m4b', { codecArgs: ['-c:a', 'aac', '-b:a', '128k'], title: 'Oathbringer', cover });
    rmSync(cover);

    // An explicit target defeats the single-m4b keep-original short-circuit, so this really
    // runs `convertFiles` — which emits no `-map_metadata` at all and relies on ffmpeg's default.
    const result = await processAudioFiles(dir, { ...keepOriginal('m4b'), bitrate: 64 }, CONTEXT);
    expect(result.success).toBe(true);

    const converted = outputIn(dir, '.m4b');
    expectSourceTagsPreserved(converted, 'Oathbringer');
    expect(hasAttachedPic(converted)).toBe(true);
  });
});
