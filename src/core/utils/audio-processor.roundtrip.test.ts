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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAudioFiles, type ProcessingConfig, type ProcessingContext } from './audio-processor.js';

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

  it('keeps a 22.05 kHz source inside the MPEG-2 table, where a naive 320k fails', async () => {
    const dir = caseDir();
    ['01.mp3', '02.mp3'].forEach((name) =>
      makePart(dir, name, { sampleRate: 22_050, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '160k'] }));
    const source = join(dir, '01.mp3');

    // Counterfactual first, while the sources still exist: the naive MPEG-1 answer is not
    // reachable at this sample rate — LAME re-rates it rather than honoring 320k.
    const naive = join(dir, 'naive.mp3');
    execFileSync(FFMPEG, ['-y', '-v', 'quiet', '-i', source, '-c:a', 'libmp3lame', '-b:a', '320k', naive], { stdio: 'ignore' });
    expect(probeStream(naive).bitRate).toBeLessThanOrEqual(160_000);
    rmSync(naive);

    const result = await processAudioFiles(dir, keepOriginal('mp3'), CONTEXT);
    expect(result.success).toBe(true);

    const out = probeStream(outputIn(dir, '.mp3'));
    expect(out.codecName).toBe('mp3');
    expect(out.bitRate).toBeLessThanOrEqual(160_000);
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
