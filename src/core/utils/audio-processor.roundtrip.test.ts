/**
 * Exercises real ffmpeg where mocked argv tests cannot prove codec acceptance or stream copy.
 * Sine-wave fixtures avoid silence's unstable bitrate, and assertions use measured rates.
 * Requires ffmpeg and ffprobe presence but no version floor.
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

/** Hashes audio packet payloads as a container-independent no-reencode oracle. */
function audioPacketDigest(inputArgs: string[]): string {
  const out = execFileSync(FFMPEG, ['-v', 'quiet', ...inputArgs, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' });
  return out.trim();
}

const CONTEXT: ProcessingContext = { author: 'Sanderson', title: 'Oathbringer' };

function keepOriginal(outputFormat: 'm4b' | 'mp3'): ProcessingConfig {
  return { ffmpegPath: FFMPEG, outputFormat };
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

  /** Uses a fresh directory because a successful merge deletes its sources. */
  function caseDir(): string {
    const dir = join(root, `case-${caseIndex++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Generates deterministic audio; tests probe its bitrate instead of trusting the request. */
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

    // Compute source-dependent oracles before the successful merge deletes its inputs.
    const listPath = concatListFor(dir, parts);
    const reference = audioPacketDigest(['-f', 'concat', '-safe', '0', '-i', listPath]);

    const result = await processAudioFiles(dir, keepOriginal('m4b'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.m4b');
    expect(audioPacketDigest(['-i', merged])).toBe(reference);

    // A default-rate re-encode would fall outside this band.
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

    // 128 kbps is legal for both encoders; this makes no general output-versus-source claim.
    const out = probeStream(outputIn(dir, '.m4b'));
    expect(out.codecName).toBe('aac');
    expect(Math.abs(out.bitRate - 128_000) / 128_000).toBeLessThan(0.1);
  });

  it('reaches the real MPEG-2 encoder for a 22.05 kHz source, where a naive 320k is re-rated', async () => {
    const dir = caseDir();
    // WAV/PCM forces encode mode; homogeneous MP3 would stream-copy and never exercise LAME.
    ['01.wav', '02.wav'].forEach((name) =>
      makePart(dir, name, { sampleRate: 22_050, codecArgs: ['-c:a', 'pcm_s16le'] }));
    const source = join(dir, '01.wav');

    // At 22.05 kHz, ffmpeg may silently rerate a naive 320k request instead of rejecting it.
    const naive = join(dir, 'naive.mp3');
    let naiveRate: number | null;
    try {
      execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', source, '-c:a', 'libmp3lame', '-b:a', '320k', naive], { stdio: 'ignore' });
      naiveRate = probeStream(naive).bitRate;
    } catch {
      naiveRate = null; // An outright rejection is the other legal failure mode.
    }
    expect(naiveRate).not.toBe(320_000);
    rmSync(naive, { force: true });

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    // The mp3-table warning proves encode mode snapped 705 kbps PCM to MPEG-2's maximum.
    expect(result.warnings!.some((w) => w.includes('705') && w.includes('160'))).toBe(true);

    const out = probeStream(outputIn(dir, '.mp3'));
    expect(out.codecName).toBe('mp3');
    // Use MP3_BITRATES_MPEG2 so table edits cannot invalidate this legality claim.
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
    expect(result.warnings!.some((w) => w.includes('705') && w.includes('512'))).toBe(true);
    // AAC may clamp further; this module promises the request and warning, not output bitrate.
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

// Mocked argv tests cannot detect ffmpeg mapping global tags from a chapter-only input;
// these cases require real output read-back.

/** Format-level tags as a lowercased-key map (ffprobe casing varies by container). */
function readFormatTags(file: string): Record<string, string> {
  const out = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8' });
  const tags = (JSON.parse(out).format?.tags ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function hasAttachedPic(file: string): boolean {
  const out = execFileSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  return ((JSON.parse(out).streams ?? []) as Array<{ disposition?: { attached_pic?: number } }>)
    .some((s) => s.disposition?.attached_pic === 1);
}

/** Probes audio because container duration can hide truncation behind chapter duration. */
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

  /** Internal chapters make ffmpeg's default chapter selection observable. */
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

  /** Uses a ±0.5s band for version-dependent codec padding while still catching one-part output. */
  function expectFullBookDuration(file: string): void {
    const total = PART_SECONDS * 3;
    const actual = audioStreamDuration(file);
    expect(actual, `audio-stream duration of ${file}`).toBeGreaterThan(total - 0.5);
    expect(actual, `audio-stream duration of ${file}`).toBeLessThan(total + 0.5);
  }

  /** Checks shared tags plus the scenario-specific title inherited from the metadata donor. */
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
    expectSourceTagsPreserved(merged, 'Part 1');
    expect(hasAttachedPic(merged)).toBe(true);
    expect(chapterTitles(merged)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    expectFullBookDuration(merged);
    expect(probeStream(merged).codecName).toBe('aac');
    expect(result.warnings ?? []).toEqual([]);
  });

  it('m4b encode mode: the same guarantees hold when the set is re-encoded (AC3, AC4)', async () => {
    const dir = caseDir();
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k']);

    // A usable explicit target forces encode mode.
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
    expectSourceTagsPreserved(merged, 'Part 1');
    expect(hasAttachedPic(merged)).toBe(false);
    // Part 01 has five internal chapters; mp3 must suppress the metadata donor's chapter set.
    expect(chapterTitles(merged)).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
  });

  it('mp3 encode mode: chapters stay suppressed, tags and full duration survive (#2083 AC4–AC6)', async () => {
    const dir = caseDir();
    // AAC/m4b inputs force the MP3 encoder; MP3 inputs would duplicate the copy-mode case.
    buildParts(dir, 'm4b', ['-c:a', 'aac', '-b:a', '128k']);

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    const merged = outputIn(dir, '.mp3');
    expect(probeStream(merged).codecName).toBe('mp3');
    expect(chapterTitles(merged)).toEqual([]);
    expectSourceTagsPreserved(merged, 'Part 1');
    expectFullBookDuration(merged);
    // Bitrate legalization warnings are valid here; chapter suppression must add none.
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
});
