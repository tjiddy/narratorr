import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { detectCoverArtSource, withCoverArtPipeline } from './cover-art.js';

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

    // execFile options are the third positional argument.
    const opts = mockExecFile.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env).toBeDefined();
    expect(opts.env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(opts.env).toHaveProperty('PATH');
  });
});

const FFMPEG = '/usr/bin/ffmpeg';
const TARGET_DIR = '/lib/book';
const SOURCE = join(TARGET_DIR, '01.m4b');
const SOURCE_2 = join(TARGET_DIR, '02.m4b');
const OUTPUT = join(TARGET_DIR, 'Book.m4b');
const OUTPUT_2 = join(TARGET_DIR, 'Book Part 2.m4b');
const COVER = join(TARGET_DIR, '_cover.jpg');
const MERGED = join(TARGET_DIR, '_cover_merged.m4b');

function spawnArgvs(spawn: ReturnType<typeof vi.fn>): string[][] {
  return spawn.mock.calls.map((call) => call[1] as string[]);
}

function spawnCallWriting(spawn: ReturnType<typeof vi.fn>, output: string): unknown[] {
  const found = spawn.mock.calls.find((call) => {
    const args = call[1] as string[];
    return args[args.length - 1] === output;
  });
  if (!found) throw new Error(`no spawn wrote ${output} (saw ${JSON.stringify(spawnArgvs(spawn))})`);
  return found as unknown[];
}

function argvWriting(spawn: ReturnType<typeof vi.fn>, output: string): string[] {
  return spawnCallWriting(spawn, output)[1] as string[];
}

describe('withCoverArtPipeline (#2078)', () => {
  beforeEach(() => {
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

    for (const args of spawnArgvs(spawn)) {
      const idx = args.indexOf('-progress');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('pipe:1');
    }
    expect(spawnArgvs(spawn)).toHaveLength(2);
  });

  it('reattach maps global metadata and chapters from the audio input (AC7)', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined);

    await runPipeline(spawn);

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

describe('withCoverArtPipeline — cancellation (#2080)', () => {
  beforeEach(() => {
    mockExecFileStdout('audio\nvideo\n');
    vi.mocked(stat).mockResolvedValue({ size: 12_345 } as never);
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
  });

  function runPipeline(
    spawn: ReturnType<typeof vi.fn>,
    signal: AbortSignal,
    outputs: string[] = [OUTPUT],
    processFn: () => Promise<string[]> = async () => outputs,
  ) {
    return withCoverArtPipeline(
      FFMPEG, [SOURCE], TARGET_DIR, 'm4b', processFn, spawn as never, { signal },
    );
  }

  /**
   * Aborts and rejects when a command writes `target`; matching output avoids dependence on call order.
   */
  function spawnAbortingOn(controller: AbortController, target: string, error: Error) {
    return vi.fn().mockImplementation(async (_ffmpegPath: string, args: string[]) => {
      if (args[args.length - 1] === target) {
        controller.abort();
        throw error;
      }
    });
  }

  it('threads the pipeline signal into the extract and reattach spawns (AC1, AC2, AC4)', async () => {
    const controller = new AbortController();
    const spawn = vi.fn().mockResolvedValue(undefined);

    await runPipeline(spawn, controller.signal);

    for (const target of [COVER, MERGED]) {
      const options = spawnCallWriting(spawn, target)[2] as { signal?: AbortSignal } | undefined;
      expect(options?.signal).toBe(controller.signal);
    }
  });

  it('an abort during detection rejects and stops probing the remaining files (AC3, AC8)', async () => {
    const controller = new AbortController();
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      controller.abort();
      const err = new Error('The operation was aborted') as Error & { code?: string };
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      cb(err);
      return {} as never;
    });
    const spawn = vi.fn().mockResolvedValue(undefined);

    await expect(withCoverArtPipeline(
      FFMPEG, [SOURCE, SOURCE_2], TARGET_DIR, 'm4b', async () => [OUTPUT], spawn as never,
      { signal: controller.signal },
    )).rejects.toThrow('The operation was aborted');

    const opts = mockExecFile.mock.calls[0]![2] as { signal?: AbortSignal; env?: Record<string, string> };
    expect(opts.signal).toBe(controller.signal);
    expect(opts.env).toBeDefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('an abort during extraction rejects instead of degrading to a cover warning (AC5, AC6)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, COVER, new Error('ffmpeg exited with code null'));
    const processFn = vi.fn().mockResolvedValue([OUTPUT]);

    await expect(runPipeline(spawn, controller.signal, [OUTPUT], processFn))
      .rejects.toThrow('ffmpeg exited with code null');

    expect(processFn).not.toHaveBeenCalled();
    expect(spawnArgvs(spawn)).toHaveLength(1);
  });

  it('an abort during reattachment rejects instead of returning a degraded success (AC5, AC6)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error('ffmpeg exited with code null'));

    await expect(runPipeline(spawn, controller.signal)).rejects.toThrow('ffmpeg exited with code null');
  });

  it('an abort on the first reattach stops the loop over the remaining outputs (AC9)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error('ffmpeg exited with code null'));

    await expect(runPipeline(spawn, controller.signal, [OUTPUT, OUTPUT_2])).rejects.toThrow();

    const reattaches = spawnArgvs(spawn).filter((args) => args.includes('-disposition:v:0'));
    expect(reattaches).toHaveLength(1);
    expect(reattaches[0]).toContain(OUTPUT);
  });

  it('cleans the partial temp files before a reattach abort surfaces (AC11)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error('ffmpeg exited with code null'));

    await expect(runPipeline(spawn, controller.signal)).rejects.toThrow();

    expect(rm).toHaveBeenCalledWith(MERGED, { force: true }); // reattach catch
    expect(rm).toHaveBeenCalledWith(COVER, { force: true }); // pipeline finally
  });

  it('cleans the partial cover before an extraction abort surfaces (AC11)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, COVER, new Error('ffmpeg exited with code null'));

    await expect(runPipeline(spawn, controller.signal)).rejects.toThrow();

    // Extraction throws before returning coverPath, so only extractCoverArt performs this cleanup.
    expect(rm).toHaveBeenCalledWith(COVER, { force: true });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pre-spawn', 'Processing aborted'],
    ['post-SIGTERM close', 'ffmpeg exited with code null'],
  ])('propagates a %s cancellation — the verdict is signal.aborted, not the message (AC7)', async (_shape, message) => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error(message));

    await expect(runPipeline(spawn, controller.signal)).rejects.toThrow(message);
  });

  it('a genuine failure under a live (un-aborted) signal still degrades (AC10)', async () => {
    const controller = new AbortController();
    const spawn = vi.fn()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('ffmpeg stalled: no progress for 60s')));

    const result = await runPipeline(spawn, controller.signal);

    expect(result.outputFiles).toEqual([OUTPUT]);
    expect(result.warnings).toEqual(['Cover art reattach failed — output will not contain embedded cover art']);
  });
});
