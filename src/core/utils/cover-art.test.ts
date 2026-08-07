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
const SOURCE_2 = join(TARGET_DIR, '02.m4b');
const OUTPUT = join(TARGET_DIR, 'Book.m4b');
const OUTPUT_2 = join(TARGET_DIR, 'Book Part 2.m4b');
const COVER = join(TARGET_DIR, '_cover.jpg');
const MERGED = join(TARGET_DIR, '_cover_merged.m4b');

/** Every spawn argv the pipeline issued, in call order: [extract, ...reattach]. */
function spawnArgvs(spawn: ReturnType<typeof vi.fn>): string[][] {
  return spawn.mock.calls.map((call) => call[1] as string[]);
}

/** The whole call (ffmpegPath, argv, options) whose last operand is `output`. */
function spawnCallWriting(spawn: ReturnType<typeof vi.fn>, output: string): unknown[] {
  const found = spawn.mock.calls.find((call) => {
    const args = call[1] as string[];
    return args[args.length - 1] === output;
  });
  if (!found) throw new Error(`no spawn wrote ${output} (saw ${JSON.stringify(spawnArgvs(spawn))})`);
  return found as unknown[];
}

/** The argv whose last operand is `output` — identifies a command without pinning call order. */
function argvWriting(spawn: ReturnType<typeof vi.fn>, output: string): string[] {
  return spawnCallWriting(spawn, output)[1] as string[];
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

// ============================================================================
// #2080 — Cancel must actually cancel. The three cover phases take the merge's
// AbortSignal, and an abort propagates AS an abort rather than degrading into a
// best-effort cover warning (which, on the reattach arm, was a *successful*
// return for an operation the operator cancelled).
// ============================================================================

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
   * A spawn double standing in for the real cancellation sequence: the operator aborts while
   * this command is in flight, so the controller trips and the command rejects. Keyed on the
   * argv's output operand rather than a call index — extract and reattach are the same double.
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

    // spawnFfmpeg's own abort listener sends the SIGTERM — it can only do that if it is
    // handed the signal, so this is the observation point for "Cancel kills the child".
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

    // execFileAsync(ffprobePath, args, { env, signal }) → options is the 3rd positional arg.
    const opts = mockExecFile.mock.calls[0]![2] as { signal?: AbortSignal; env?: Record<string, string> };
    expect(opts.signal).toBe(controller.signal);
    expect(opts.env).toBeDefined(); // the sanitized env survives the new option
    // The per-file catch treats an unprobeable file as "no cover here" and moves on. Under an
    // aborted signal that reads cancellation as "no cover art" and lets the merge proceed.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('an abort during extraction rejects instead of degrading to a cover warning (AC5, AC6)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, COVER, new Error('ffmpeg exited with code null'));
    const processFn = vi.fn().mockResolvedValue([OUTPUT]);

    await expect(runPipeline(spawn, controller.signal, [OUTPUT], processFn))
      .rejects.toThrow('ffmpeg exited with code null');

    // No result object exists at all, so the extraction warning cannot reach the operator —
    // and the encode the cancel was meant to stop never started.
    expect(processFn).not.toHaveBeenCalled();
    expect(spawnArgvs(spawn)).toHaveLength(1);
  });

  it('an abort during reattachment rejects instead of returning a degraded success (AC5, AC6)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error('ffmpeg exited with code null'));

    // The exact scenario the non-abort test above resolves with a warning now takes the
    // opposite branch: a cancelled reattach must not walk into removeSourceFiles.
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

  it('cleans the partial temp files before the abort surfaces (AC11)', async () => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error('ffmpeg exited with code null'));

    await expect(runPipeline(spawn, controller.signal)).rejects.toThrow();

    expect(rm).toHaveBeenCalledWith(MERGED, { force: true }); // reattach catch
    expect(rm).toHaveBeenCalledWith(COVER, { force: true }); // pipeline finally
  });

  it.each([
    ['pre-spawn', 'Processing aborted'],
    ['post-SIGTERM close', 'ffmpeg exited with code null'],
  ])('propagates a %s cancellation — the verdict is signal.aborted, not the message (AC7)', async (_shape, message) => {
    const controller = new AbortController();
    const spawn = spawnAbortingOn(controller, MERGED, new Error(message));

    // One cancellation, three error shapes: only the pre-spawn one is recognisable by text.
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
