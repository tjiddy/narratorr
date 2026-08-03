import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { detectCoverArtSource, withCoverArtPipeline } from './cover-art.js';

// Mock at the OS boundary (node:child_process) so the env passed to ffprobe is captured.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const mockExecFile = vi.mocked(execFile);

function mockExecFileStdout(stdout: string) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    cb(null, { stdout, stderr: '' });
    return {} as never;
  });
}

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.NARRATORR_SECRET_KEY;
});

describe('detectCoverArtSource', () => {
  it('returns the first file carrying a video stream', async () => {
    mockExecFileStdout('audio\nvideo\n');
    const result = await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.m4b']);
    expect(result).toBe('/audio/book.m4b');
  });

  it('returns null when no file has a video stream', async () => {
    mockExecFileStdout('audio\n');
    const result = await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.mp3']);
    expect(result).toBeNull();
  });

  it('probes ffprobe with a sanitized env (no secret leak, PATH preserved)', async () => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-secret';
    mockExecFileStdout('audio\nvideo\n');

    await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.m4b']);

    // execFileAsync(ffprobePath, args, { env }) → options is the 3rd positional arg.
    const opts = mockExecFile.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env).toBeDefined();
    expect(opts.env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(opts.env).toHaveProperty('PATH');
  });
});

// ============================================================================
// #2078 — the extract/reattach remuxes must survive the 60 s stall timer, and
// the reattach must not undo the metadata/chapters the merge just preserved.
// ============================================================================

const FFMPEG = '/usr/bin/ffmpeg';
const TARGET_DIR = '/lib/book';
const SOURCE = join(TARGET_DIR, '01.m4b');
const OUTPUT = join(TARGET_DIR, 'Book.m4b');
const COVER = join(TARGET_DIR, '_cover.jpg');

/** Every spawn argv the pipeline issued, in call order: [extract, ...reattach]. */
function spawnArgvs(spawn: ReturnType<typeof vi.fn>): string[][] {
  return spawn.mock.calls.map((call) => call[1] as string[]);
}

/** The argv whose last operand is `output` — identifies a command without pinning call order. */
function argvWriting(spawn: ReturnType<typeof vi.fn>, output: string): string[] {
  const found = spawnArgvs(spawn).find((args) => args[args.length - 1] === output);
  if (!found) throw new Error(`no spawn wrote ${output} (saw ${JSON.stringify(spawnArgvs(spawn))})`);
  return found;
}

describe('withCoverArtPipeline (#2078)', () => {
  beforeEach(() => {
    // A source carrying an embedded picture, so the extract arm runs.
    mockExecFileStdout('audio\nvideo\n');
    vi.mocked(stat).mockResolvedValue({ size: 12_345 } as never);
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
  });

  function runPipeline(spawn: ReturnType<typeof vi.fn>, outputFormat: 'm4b' | 'mp3' = 'm4b') {
    return withCoverArtPipeline(
      FFMPEG, [SOURCE], TARGET_DIR, outputFormat, async () => [OUTPUT], spawn as never,
    );
  }

  it('feeds the stall timer: extract and reattach both request -progress pipe:1 (AC6)', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await runPipeline(spawn);
    expect(result.warnings).toEqual([]);

    // spawnFfmpeg's 60 s stall timer only resets on STDOUT activity. A `-c copy` remux of a
    // multi-GB merged audiobook emits nothing on stdout without this flag, so it was killed at
    // 60 s and the reattach silently degraded to the warning arm.
    for (const args of spawnArgvs(spawn)) {
      const idx = args.indexOf('-progress');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('pipe:1');
    }
    expect(spawnArgvs(spawn)).toHaveLength(2); // extract + reattach
  });

  it('reattach maps global metadata and chapters from the audio input (AC7)', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined);

    await runPipeline(spawn);

    // The reattach is a second remux over the just-merged file. Without these it can drop the
    // source tags Layer 1 preserved and the generated chapter set #2068 pinned.
    const reattach = spawnArgvs(spawn).find((args) => args.includes('-disposition:v:0'))!;
    expect(reattach).toBeDefined();
    const inputs = reattach.reduce<string[]>((acc, a, i) => (a === '-i' ? [...acc, reattach[i + 1]!] : acc), []);
    expect(inputs[0]).toBe(OUTPUT);
    expect(reattach[reattach.indexOf('-map_metadata') + 1]).toBe('0');
    expect(reattach[reattach.indexOf('-map_chapters') + 1]).toBe('0');
  });

  it('extraction failure degrades with its own warning and never throws', async () => {
    const spawn = vi.fn().mockRejectedValue(new Error('ffmpeg stalled: no progress for 60s'));

    const result = await runPipeline(spawn);

    expect(result.outputFiles).toEqual([OUTPUT]);
    expect(result.warnings).toEqual(['Cover art extraction failed — output will not contain embedded cover art']);
  });

  it('reattach failure degrades with its own distinct warning and never throws', async () => {
    // Extract succeeds, reattach fails — the production symptom this issue diagnosed.
    const spawn = vi.fn()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('ffmpeg stalled: no progress for 60s')));

    const result = await runPipeline(spawn);

    expect(result.outputFiles).toEqual([OUTPUT]);
    expect(result.warnings).toEqual(['Cover art reattach failed — output will not contain embedded cover art']);
    expect(rm).toHaveBeenCalledWith(COVER, { force: true });
  });

  it('mp3 output extracts but never reattaches — the deliberate AC8b gap', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined);

    const result = await runPipeline(spawn, 'mp3');

    expect(spawnArgvs(spawn)).toHaveLength(1);
    expect(argvWriting(spawn, COVER)).toContain('-an');
    expect(result.warnings).toEqual([]);
  });
});
