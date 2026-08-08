import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeFfmpeg,
  detectFfmpegPath,
  resolveFfmpegPath,
  resetFfmpegPathCache,
  processAudioFiles,
  buildChapterMetadata,
  InsufficientAudioFilesError,
  type ProcessingConfig,
  type ProcessingContext,
} from './audio-processor.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('./chapter-resolver.js', () => ({
  readChapterSources: vi.fn(),
  resolveChapterTitle: vi.fn(),
}));

// Passthrough spy on the encode-strategy seam — real behavior by default, so only the test
// that pins "the caller does not re-derive resolver predicates" overrides it.
vi.mock('./encode-strategy.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolveCodecArgs: vi.fn().mockImplementation(actual.resolveCodecArgs as (...args: unknown[]) => unknown),
  };
});

// Passthrough spy on the error-message reducer. `processAudioFiles` swallows every throw into the
// unsuccessful `ProcessingResult`, which carries only a string — so this is the one observation
// point that can still see the THROWN VALUE's type (#2062 AC4). Behaviour is unchanged.
vi.mock('@shared/error-message.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getErrorMessage: vi.fn().mockImplementation(actual.getErrorMessage as (...args: unknown[]) => unknown),
  };
});

// Spy on naming.js — passthrough to real implementation
vi.mock('./naming.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    renderFilename: vi.fn().mockImplementation(actual.renderFilename as (...args: unknown[]) => unknown),
  };
});

import { execFile, spawn } from 'node:child_process';
import { readdir, rename, unlink, writeFile, rm, stat } from 'node:fs/promises';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';
import { renderFilename } from './naming.js';
import { resolveCodecArgs } from './encode-strategy.js';
import { getErrorMessage } from '@shared/error-message.js';

// The real implementations, re-installed on the spies in beforeEach. `vi.clearAllMocks()` clears
// call history but neither drains `*Once()` queues nor restores implementations, so an
// override in one test would otherwise leak into every test after it.
const actualEncodeStrategy = await vi.importActual<typeof import('./encode-strategy.js')>('./encode-strategy.js');
const actualErrorMessage = await vi.importActual<typeof import('@shared/error-message.js')>('@shared/error-message.js');

// execFile is callback-based; mock the promisified version (used by probeFfmpeg, detectFfmpegPath, getFileDurations)
const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

function mockExecFileSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (typeof cb === 'function') {
      cb(null, { stdout, stderr });
    }
    return {} as never;
  });
}

function mockExecFileFailure(message: string, stderr = '') {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error & { stderr?: string }) => void;
    if (typeof cb === 'function') {
      const err = new Error(message) as Error & { stderr?: string };
      err.stderr = stderr;
      cb(err);
    }
    return {} as never;
  });
}

/** Create a mock ChildProcess for spawn-based tests. */
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

/** Mock spawn to resolve successfully (exit code 0). Returns the mock child for further interaction. */
function mockSpawnSuccess(): MockChildProcess {
  const child = new MockChildProcess();
  mockSpawn.mockReturnValue(child as never);
  // Defer close so callers can attach listeners first
  process.nextTick(() => child.emit('close', 0));
  return child;
}

/** Mock spawn to fail with given exit code. */
function mockSpawnFailure(code = 1): MockChildProcess {
  const child = new MockChildProcess();
  mockSpawn.mockReturnValue(child as never);
  process.nextTick(() => child.emit('close', code));
  return child;
}

const mockReaddir = vi.mocked(readdir);
const mockUnlink = vi.mocked(unlink);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockRm = vi.mocked(rm);
const mockStat = vi.mocked(stat);
const mockReadChapterSources = vi.mocked(readChapterSources);
const mockResolveChapterTitle = vi.mocked(resolveChapterTitle);

const defaultConfig: ProcessingConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  outputFormat: 'm4b',
  bitrate: 128,
};

const defaultContext: ProcessingContext = {
  author: 'Brandon Sanderson',
  title: 'The Way of Kings',
};

/** An ffprobe `stream=codec_name,bit_rate,sample_rate,channels` payload for one source file. */
interface StreamInfoFixture {
  codec_name?: string;
  /** bps, as ffprobe reports it — the collector is what floors it to kbps. */
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
}

/**
 * Per-file stream-info fixtures for the encode-strategy probe collector, keyed by file path.
 * A missing entry (or an explicit null) makes that file's probe return null, which is what an
 * unreadable stream looks like to the resolver. Reset in beforeEach — never queued with
 * `mockResolvedValueOnce`, since `vi.clearAllMocks()` does not drain `*Once()` queues.
 */
let streamInfoByFile: Record<string, StreamInfoFixture | null> = {};

function setStreamInfo(map: Record<string, StreamInfoFixture | null>): void {
  // Fixture maps are keyed by path strings that tests write either as POSIX literals or via
  // join() (backslashes on Windows). Re-key POSIX so both styles hit on every platform.
  streamInfoByFile = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k.split('\\').join('/'), v]),
  );
}

/**
 * Install an execFile mock that dispatches on argv AND returns the callback shape each caller
 * expects.
 *
 * Two shapes, not one: the duration and cover-detection callers go through
 * `promisify(execFile)` and receive a single `{ stdout, stderr }` object, while
 * `getFFprobeStreamInfo` calls raw `execFile` and receives `(error, stdout, stderr)`
 * positionally. A dispatcher preserving only one shape either breaks the duration tests or
 * silently makes every stream probe null — which would disable the copy path without failing
 * anything. `asserts a parsed stream probe` below pins that it does not happen.
 */
function installExecFileDispatcher(opts: {
  durations?: number[];
  videoStreams?: Record<string, number>;
} = {}): void {
  let durationIdx = 0;
  // Same POSIX re-keying as setStreamInfo: callers key this map both ways.
  const videoStreams = Object.fromEntries(
    Object.entries(opts.videoStreams ?? {}).map(([k, v]) => [k.split('\\').join('/'), v]),
  );
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') return {} as never;
    const execArgs = (args[1] as string[] | undefined) ?? [];
    const filePath = execArgs[execArgs.length - 1] ?? '';
    // Production probes join()-built paths (backslashes on Windows); fixture maps are keyed
    // POSIX. Normalize at the lookup boundary or every keyed probe silently misses on Windows.
    const posixPath = filePath.split('\\').join('/');

    if (execArgs.includes('stream=codec_name,bit_rate,sample_rate,channels')) {
      const positional = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const fixture = streamInfoByFile[posixPath];
      positional(null, JSON.stringify({ streams: fixture ? [fixture] : [] }), '');
      return {} as never;
    }

    const objectCb = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (execArgs.includes('stream=codec_type')) {
      const lines = ['audio'];
      for (let i = 0; i < (videoStreams[posixPath] ?? 0); i++) lines.push('video');
      objectCb(null, { stdout: `${lines.join('\n')}\n`, stderr: '' });
    } else if (execArgs.includes('format=duration')) {
      objectCb(null, { stdout: `${opts.durations?.[durationIdx++] ?? 120}\n`, stderr: '' });
    } else {
      objectCb(null, { stdout: 'audio\n', stderr: '' });
    }
    return {} as never;
  });
}

/** The argv the encode-strategy collector probes each source file with. */
function streamProbeCalls(): unknown[][] {
  return mockExecFile.mock.calls.filter(
    (call) => (call[1] as string[] | undefined)?.includes('stream=codec_name,bit_rate,sample_rate,channels') ?? false,
  );
}

/** The ffmpeg encode spawn — selected by argv, since cover art adds extract/reattach spawns. */
function encodeSpawnArgs(index = 0): string[] {
  const encodes = mockSpawn.mock.calls
    .map((call) => call[1] as string[])
    .filter((args) => args.includes('-c:a'));
  const found = encodes[index];
  if (!found) throw new Error(`no encode spawn at index ${index} (saw ${encodes.length})`);
  return found;
}

/** The value `processAudioFiles`' catch actually received, before it was reduced to a string. */
function caughtError(): unknown {
  const call = vi.mocked(getErrorMessage).mock.calls.at(-1);
  if (!call) throw new Error('getErrorMessage was never called — nothing was caught');
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCodecArgs).mockImplementation(actualEncodeStrategy.resolveCodecArgs);
  vi.mocked(getErrorMessage).mockImplementation(actualErrorMessage.getErrorMessage);
  streamInfoByFile = {};
  mockUnlink.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockStat.mockResolvedValue({ size: 1024 } as never);
});

describe('probeFfmpeg', () => {
  it('returns version string on success', async () => {
    mockExecFileSuccess('ffmpeg version 6.1.1 Copyright (c) 2000-2024');
    const version = await probeFfmpeg('/usr/bin/ffmpeg');
    expect(version).toBe('6.1.1');
  });

  it('returns full first line when version pattern does not match', async () => {
    mockExecFileSuccess('some custom build v1.0');
    const version = await probeFfmpeg('/usr/bin/ffmpeg');
    expect(version).toBe('some custom build v1.0');
  });

  it('throws on non-zero exit', async () => {
    mockExecFileFailure('Command failed');
    await expect(probeFfmpeg('/bad/path')).rejects.toThrow('Command failed');
  });
});

describe('detectFfmpegPath', () => {
  // Isolate the ambient FFMPEG_PATH override: a dev box with it set would otherwise probe
  // the override first and break the '/usr/bin/ffmpeg' expectations (passes on CI, flakes locally).
  let savedFfmpegPathEnv: string | undefined;
  beforeEach(() => { savedFfmpegPathEnv = process.env.FFMPEG_PATH; delete process.env.FFMPEG_PATH; });
  afterEach(() => {
    if (savedFfmpegPathEnv === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpegPathEnv;
  });

  it('returns /usr/bin/ffmpeg when probe succeeds at known path', async () => {
    mockExecFileSuccess('ffmpeg version 6.1.1 Copyright');
    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/bin/ffmpeg');
  });

  it('honors FFMPEG_PATH when the override probes successfully', async () => {
    process.env.FFMPEG_PATH = '/custom/ffmpeg';
    mockExecFileSuccess('ffmpeg version 8.0.1');
    const result = await detectFfmpegPath();
    expect(result).toBe('/custom/ffmpeg');
  });

  it('falls THROUGH to /usr/bin/ffmpeg when FFMPEG_PATH is set but does not probe', async () => {
    process.env.FFMPEG_PATH = '/bad/ffmpeg';
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === '/bad/ffmpeg') cb(new Error('spawn ENOENT')); // override rejected
      else cb(null, { stdout: 'ffmpeg version 8.0.1' }); // /usr/bin/ffmpeg wins
      return {} as never;
    });
    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/bin/ffmpeg');
  });

  it('falls back to which ffmpeg when /usr/bin/ffmpeg probe fails', async () => {
    // Arg-keyed single implementation rather than a mockImplementationOnce queue: clearAllMocks
    // (file-level beforeEach) does not drain *Once() queues, so a leftover queued impl could leak
    // into later tests (vitest-clearallmocks-once-queue). `/usr/bin/ffmpeg` probe fails; `which` wins.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else if (file === '/usr/local/bin/ffmpeg') cb(null, { stdout: 'ffmpeg version 8.0.1' }); // which candidate probes OK
      else cb(new Error('spawn ENOENT'));
      return {} as never;
    });

    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/local/bin/ffmpeg');
  });

  it('returns null when both probe and which fail', async () => {
    mockExecFileFailure('spawn ENOENT');
    const result = await detectFfmpegPath();
    expect(result).toBeNull();
  });

  it('returns null when the `which` candidate resolves but fails to probe (finding 2)', async () => {
    // `which` finds a PATH entry, but running it as `-version` fails (broken/partial install).
    // An unprobed candidate must NOT be trusted — otherwise service gates admit work the status
    // route's fresh probe reports unavailable (the two-definitions-of-available gap).
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else cb(new Error('spawn ENOENT')); // every probe (incl the which candidate) fails
      return {} as never;
    });
    const result = await detectFfmpegPath();
    expect(result).toBeNull();
  });
});

describe('resolveFfmpegPath (memoization)', () => {
  let savedFfmpegPathEnv: string | undefined;
  beforeEach(() => { savedFfmpegPathEnv = process.env.FFMPEG_PATH; delete process.env.FFMPEG_PATH; resetFfmpegPathCache(); });
  afterEach(() => {
    resetFfmpegPathCache();
    if (savedFfmpegPathEnv === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpegPathEnv;
  });

  it('caches a successful resolution — detection runs once across two calls', async () => {
    mockExecFileSuccess('ffmpeg version 8.0.1');
    expect(await resolveFfmpegPath()).toBe('/usr/bin/ffmpeg');
    const callsAfterFirst = mockExecFile.mock.calls.length;
    expect(await resolveFfmpegPath()).toBe('/usr/bin/ffmpeg');
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst); // served from cache, no re-detect
  });

  it('coalesces concurrent callers onto ONE detection — single-flight (finding 7)', async () => {
    mockExecFileSuccess('ffmpeg version 8.0.1');
    const [a, b] = await Promise.all([resolveFfmpegPath(), resolveFfmpegPath()]);
    expect(a).toBe('/usr/bin/ffmpeg');
    expect(b).toBe('/usr/bin/ffmpeg');
    expect(mockExecFile.mock.calls.length).toBe(1); // both shared one in-flight probe
  });

  it('holds a miss under the negative TTL — does NOT re-spawn within the window (finding 7)', async () => {
    mockExecFileFailure('spawn ENOENT');
    expect(await resolveFfmpegPath()).toBeNull();
    const callsAfterFirst = mockExecFile.mock.calls.length;
    expect(await resolveFfmpegPath()).toBeNull();
    // The whole point: a degraded library scan must not re-probe `which`+`/usr/bin/ffmpeg` per book.
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-detects a miss after the negative TTL expires (finding 7)', async () => {
    vi.useFakeTimers();
    try {
      mockExecFileFailure('spawn ENOENT');
      expect(await resolveFfmpegPath()).toBeNull();
      const callsAfterFirst = mockExecFile.mock.calls.length;
      vi.advanceTimersByTime(31_000); // past FFMPEG_MISS_TTL_MS (30s)
      expect(await resolveFfmpegPath()).toBeNull();
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst); // window elapsed → re-detected
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('media-tool env sanitization', () => {
  // execFile/spawn options object is the 3rd positional arg (file, args, options[, cb]).
  const optsOf = (call: unknown[]): { env?: Record<string, string> } =>
    (call[2] ?? {}) as { env?: Record<string, string> };

  beforeEach(() => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-secret';
  });
  afterEach(() => {
    delete process.env.NARRATORR_SECRET_KEY;
  });

  it('probeFfmpeg runs ffmpeg with a sanitized env (no secret, PATH preserved)', async () => {
    mockExecFileSuccess('ffmpeg version 6.1.1 Copyright');
    await probeFfmpeg('/usr/bin/ffmpeg');

    const { env } = optsOf(mockExecFile.mock.calls[0]!);
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).toHaveProperty('PATH');
  });

  it('detectFfmpegPath passes a sanitized env to the `which ffmpeg` fallback', async () => {
    // Single arg-keyed implementation (not a mockImplementationOnce queue): the file-level
    // beforeEach uses clearAllMocks, which does NOT drain *Once() queues, so a queued impl could
    // leak into later tests if control flow changed (vitest-clearallmocks-once-queue learning).
    // Branch on the command instead: the `/usr/bin/ffmpeg` probe fails, `which ffmpeg` succeeds.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else if (file === '/usr/local/bin/ffmpeg') cb(null, { stdout: 'ffmpeg version 8.0.1' }); // which candidate probes OK
      else cb(new Error('spawn ENOENT'));
      return {} as never;
    });

    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/local/bin/ffmpeg');

    // Second call is the `which ffmpeg` invocation.
    const whichCall = mockExecFile.mock.calls[1]!;
    expect(whichCall[0]).toBe('which');
    const { env } = optsOf(whichCall);
    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).toHaveProperty('PATH');
  });

  it('spawnFfmpeg (via processAudioFiles) runs with a sanitized env', async () => {
    setupMergeFiles([300, 300]);
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', { ...defaultConfig, outputFormat: 'mp3' }, defaultContext);

    expect(mockSpawn).toHaveBeenCalled();
    const { env } = optsOf(mockSpawn.mock.calls[0]!);
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).toHaveProperty('PATH');
  });

  it('getFileDurations ffprobe calls run with a sanitized env (merge path)', async () => {
    setupMergeFiles([300, 300]);
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    // The execFile calls in the merge path are the ffprobe duration queries.
    expect(mockExecFile).toHaveBeenCalled();
    const { env } = optsOf(mockExecFile.mock.calls[0]!);
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).toHaveProperty('PATH');
  });
});

/** Setup helpers for merge path tests. */
function setupMergeFiles(durations: number[] = [300, 300, 300]) {
  const fileCount = durations.length;
  const files = Array.from({ length: fileCount }, (_, i) => ({
    name: `${String(i + 1).padStart(2, '0')}.mp3`,
    isFile: () => true,
    isDirectory: () => false,
  }));
  mockReaddir.mockResolvedValue(files as never);

  const sources = Array.from({ length: fileCount }, (_, i) => ({
    filePath: `/lib/book/${String(i + 1).padStart(2, '0')}.mp3`,
    title: `Ch ${i + 1}`,
    trackNumber: i + 1,
  }));
  mockReadChapterSources.mockResolvedValue(sources);
  mockResolveChapterTitle.mockImplementation((_s, i) => `Chapter ${i + 1}`);

  installExecFileDispatcher({ durations });
}

describe('processAudioFiles', () => {
  it('merges N files into single m4b with chapter metadata', async () => {
    setupMergeFiles([300, 300, 300]);
    mockSpawnSuccess();

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Brandon Sanderson - The Way of Kings.m4b')]);
    }

    // Should have written concat file and metadata file
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    // spawn should have been called for ffmpeg (not execFile for merge)
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('returns error result on non-zero ffmpeg exit', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnFailure(1);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('ffmpeg exited with code 1');
    }
  });

  it('uses fileFormat template for merged output filename', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = {
      author: 'Tolkien',
      title: 'The Hobbit',
      fileFormat: '{title} by {author}',
    };
    const result = await processAudioFiles('/lib/book', defaultConfig, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'The Hobbit by Tolkien.m4b')]);
    }
  });

  it('renders the {edition} token from bookTokens for merged output (#1712)', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = {
      author: 'Blake Crouch',
      title: 'Dark Matter',
      fileFormat: '{title} ({edition})',
      bookTokens: { edition: 'Full Cast' },
    };
    const result = await processAudioFiles('/lib/book', defaultConfig, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Dark Matter (Full Cast).m4b')]);
    }
  });

  it('renders an empty {edition} (no stray brackets) when bookTokens.edition is null (#1712)', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = {
      author: 'Blake Crouch',
      title: 'Dark Matter',
      fileFormat: '{title} ({edition})',
      bookTokens: { edition: null },
    };
    const result = await processAudioFiles('/lib/book', defaultConfig, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Dark Matter.m4b')]);
    }
  });

  it('forwards namingOptions to renderFilename for merged output', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = {
      author: 'Tolkien',
      title: 'The Hobbit',
      fileFormat: '{author} - {title}',
      namingOptions: { separator: 'period', case: 'upper' },
    };
    await processAudioFiles('/lib/book', defaultConfig, ctx);

    expect(renderFilename).toHaveBeenCalledWith(
      '{author} - {title}',
      expect.objectContaining({ author: 'Tolkien', title: 'The Hobbit' }),
      expect.objectContaining({ separator: 'period', case: 'upper' }),
    );
  });

  it('output file named {Author} - {Title}.m4b for merged output', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = { author: 'Tolkien', title: 'The Hobbit' };
    const result = await processAudioFiles('/lib/book', defaultConfig, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Tolkien - The Hobbit.m4b')]);
    }
  });
});

// ============================================================================
// #2062 — the processor is merge-only, and fails closed below the merge minimum
// ============================================================================

describe('#2062 fail-closed below the merge minimum', () => {
  /**
   * Seed a directory whose merge would OTHERWISE succeed — chapter sources, probes and a
   * successful spawn are all installed. Installing a mock implementation is not calling it, so
   * the "touched nothing" assertions still hold; what this buys is the counterfactual. With the
   * guard deleted these cases fail on the assertions themselves rather than hanging on an
   * unmocked ffprobe, which is the difference between a red that names the defect and a timeout.
   */
  function seedDirectory(names: string[]): void {
    mockReaddir.mockResolvedValue(
      names.map((name) => ({ name, isFile: () => true, isDirectory: () => false })) as never,
    );
    mockReadChapterSources.mockResolvedValue(
      names.map((name, i) => ({ filePath: join('/lib/book', name), title: `Ch ${i + 1}`, trackNumber: i + 1 })),
    );
    mockResolveChapterTitle.mockImplementation((_s, i) => `Chapter ${i + 1}`);
    installExecFileDispatcher();
    mockSpawnSuccess();
  }

  /** Nothing downstream of the guard may run: no probe, no encode, no deletion, no output. */
  function expectNoWork(): void {
    expect(mockReadChapterSources).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  }

  it('refuses a single-file staging set, naming the count, and touches nothing', async () => {
    seedDirectory(['book.mp3']);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBe('Merge requires at least 2 audio files, found 1');
    expectNoWork();
  });

  it('throws the typed error, not a bare Error carrying the same string', async () => {
    seedDirectory(['book.mp3']);

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    // Asserted at the throw site: `getErrorMessage` flattens any Error subclass to its message,
    // so the ProcessingResult alone cannot tell this class from `new Error(sameString)`.
    const thrown = caughtError();
    expect(thrown).toBeInstanceOf(InsufficientAudioFilesError);
    expect((thrown as InsufficientAudioFilesError).count).toBe(1);
  });

  it('refuses an EMPTY directory instead of succeeding with no output files', async () => {
    // Behaviour change, not a refactor: this returned `{ success: true, outputFiles: [] }` before
    // #2062 — a success that produced nothing, on a path whose caller then deletes the originals.
    seedDirectory([]);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result).toEqual({ success: false, error: 'Merge requires at least 2 audio files, found 0' });
    expect(caughtError()).toBeInstanceOf(InsufficientAudioFilesError);
    expectNoWork();
  });

  it('refuses a directory holding only non-audio files', async () => {
    seedDirectory(['readme.txt', 'cover.jpg']);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    // collectAudioFiles filters by extension before the guard sees the set, so this is a zero.
    expect(!result.success && result.error).toBe('Merge requires at least 2 audio files, found 0');
    expectNoWork();
  });

  it('does not count dot-prefixed audio toward the minimum', async () => {
    // The premise the whole deletion rests on: the processor's collector and the eligibility
    // gate's `listTopLevelAudioFiles` share `isHiddenName`, so a born-hidden transient is not a
    // part on either side. One real file plus a dotfile is still a single-file book.
    seedDirectory(['01.mp3', '.02.tmp.mp3']);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(!result.success && result.error).toBe('Merge requires at least 2 audio files, found 1');
    expectNoWork();
  });

  it('merges at exactly two files — the inclusive edge of the guard', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result.success).toBe(true);
    expect(result.success && result.outputFiles).toEqual([
      join('/lib/book', 'Brandon Sanderson - The Way of Kings.m4b'),
    ]);
  });

  it('turns a failed directory read into an unsuccessful result, not a rejection', async () => {
    // #2062 moved collection inside the try, so a rejected readdir now lands on the same catch
    // as every other processing failure instead of rejecting out of the module.
    mockReaddir.mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain('EACCES');
    expect(caughtError()).not.toBeInstanceOf(InsufficientAudioFilesError);
    expectNoWork();
  });
});

describe('#2062 the notices the deleted keep-original short circuit used to carry', () => {
  it('surfaces the unusable-target notice on a merge set', async () => {
    // The single-m4b early return was the only direct `noticeMessages` call site. The merge path
    // has to deliver the same notice through `resolveCodecArgs`.
    setupMergeSet(['01.m4b', '02.m4b']);
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, bitrate: Number.NaN }, defaultContext,
    );

    expect(result.success).toBe(true);
    expect(result.warnings!.some((w) => w.includes('NaN'))).toBe(true);
  });
});

describe('buildChapterMetadata', () => {
  it('generates FFMETADATA1 format with chapter markers', () => {
    mockResolveChapterTitle
      .mockReturnValueOnce('Introduction')
      .mockReturnValueOnce('The Journey Begins');

    const sources = [
      { filePath: '/a/01.mp3', title: 'Introduction' },
      { filePath: '/a/02.mp3', title: 'The Journey Begins' },
    ];
    const durations = [300, 600]; // 5min, 10min

    const metadata = buildChapterMetadata(sources, durations);

    expect(metadata).toContain(';FFMETADATA1');
    expect(metadata).toContain('[CHAPTER]');
    expect(metadata).toContain('START=0');
    expect(metadata).toContain('END=300000');
    expect(metadata).toContain('title=Introduction');
    expect(metadata).toContain('START=300000');
    expect(metadata).toContain('END=900000');
    expect(metadata).toContain('title=The Journey Begins');
  });
});

describe('bitrate capping — sourceBitrateKbps', () => {
  beforeEach(() => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();
  });

  it('uses source bitrate when lower than target', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 64 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('64k');
  });

  it('uses target bitrate when lower than source', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 64, sourceBitrateKbps: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('64k');
  });

  it('uses either value when source equals target exactly (boundary)', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('128k');
  });

  it('uses target bitrate as-is when sourceBitrateKbps is undefined', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('128k');
  });

  it('still emits an explicit -b:a when config.bitrate is undefined (keep original, ineligible)', async () => {
    const { bitrate: _bitrate, ...configWithoutBitrate } = defaultConfig;
    const config: ProcessingConfig = { ...configWithoutBitrate, sourceBitrateKbps: 64 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = encodeSpawnArgs();
    expect(spawnArgs[spawnArgs.indexOf('-c:a') + 1]).toBe('aac');
    expect(spawnArgs[spawnArgs.indexOf('-b:a') + 1]).toBe('64k');
  });

  it('never emits -b:a 0k for a zero sourceBitrateKbps', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 0 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = encodeSpawnArgs();
    expect(spawnArgs).not.toContain('0k');
    expect(spawnArgs[spawnArgs.indexOf('-b:a') + 1]).toBe('128k');
  });
});

// ============================================================================
// #257 — Merge observability: spawn migration, progress callbacks, ffmpeg args
// ============================================================================

describe('#257 merge observability — audio-processor', () => {
  describe('mergeFiles() ffmpeg args', () => {
    it('passes -max_muxing_queue_size 4096 in ffmpeg args', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', defaultConfig, defaultContext);

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      const idx = spawnArgs.indexOf('-max_muxing_queue_size');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('4096');
    });

    it('passes -progress pipe:1 in ffmpeg args', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', defaultConfig, defaultContext);

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
      const idx = spawnArgs.indexOf('-progress');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('pipe:1');
    });

    it('uses spawn instead of execFile for ffmpeg invocation', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', defaultConfig, defaultContext);

      // spawn called once for ffmpeg merge, execFile only for ffprobe
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]![0]).toBe('/usr/bin/ffmpeg');
      // execFile calls should all be ffprobe (duration probing)
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toContain('ffprobe');
      }
    });
  });

  describe('onProgress callback', () => {
    it('invoked with phase processing and percentage (0..1 ratio) when stdout emits out_time_us', async () => {
      setupMergeFiles([100, 100]); // 200s total
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      // Wait for spawn to be called
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      // Emit progress on stdout (100s out of 200s = 0.5)
      child.stdout.emit('data', Buffer.from('out_time_us=100000000\n'));
      child.emit('close', 0);

      await promise;
      expect(onProgress).toHaveBeenCalledWith('processing', 0.5);
    });

    it('percentage clamped to 0..1 when out_time_us exceeds total duration', async () => {
      setupMergeFiles([100, 100]); // 200s total
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      // Emit progress beyond total (300s out of 200s)
      child.stdout.emit('data', Buffer.from('out_time_us=300000000\n'));
      child.emit('close', 0);

      await promise;
      expect(onProgress).toHaveBeenCalledWith('processing', 1);
    });

    it('percentage is 0 when totalDuration is 0 (no division by zero)', async () => {
      setupMergeFiles([0, 0]); // 0s total
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      child.stdout.emit('data', Buffer.from('out_time_us=50000000\n'));
      child.emit('close', 0);

      await promise;
      // With 0 totalDuration, onProgress should not be called (guard check)
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('negative out_time_us treated as 0 percentage', async () => {
      setupMergeFiles([100, 100]); // 200s total
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      child.stdout.emit('data', Buffer.from('out_time_us=-1000\n'));
      child.emit('close', 0);

      await promise;
      expect(onProgress).toHaveBeenCalledWith('processing', 0);
    });
  });

  describe('onStderr callback', () => {
    it('invoked for each stderr line from ffmpeg', async () => {
      setupMergeFiles([120, 120]);
      const onStderr = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onStderr },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      child.stderr.emit('data', Buffer.from('frame= 100\nsize=    200kB\n'));
      child.emit('close', 0);

      await promise;
      expect(onStderr).toHaveBeenCalledWith('frame= 100');
      expect(onStderr).toHaveBeenCalledWith('size=    200kB');
    });
  });

  describe('failure handling', () => {
    it('onProgress not called after spawn exits with error', async () => {
      setupMergeFiles([100, 100]);
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      child.emit('close', 1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('temp files cleaned up on merge failure, source files preserved', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnFailure(1);

      const result = await processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
      );

      expect(result.success).toBe(false);
      // Temp files cleaned up
      expect(mockRm).toHaveBeenCalled();
      // Source files NOT removed (unlink not called for source files)
      expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  describe('backward compatibility', () => {
    it('processAudioFiles works without onProgress/onStderr callbacks (optional params)', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      // Call without callbacks (3-arg form)
      const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// #424 — M4B merge: embedded cover art muxer overflow fix
// ============================================================================

describe('#424 stream mapping — unconditional -vn flag', () => {
  it('mergeFiles includes -vn flag in ffmpeg args', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0]![1] as string[];
    expect(spawnArgs).toContain('-vn');
  });
});

describe('#424 spawnFfmpeg — stall timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills ffmpeg process after 60s with no progress output', async () => {
    setupMergeFiles([120, 120]);
    const child = new MockChildProcess();
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child as never);

    const promise = processAudioFiles('/lib/book', defaultConfig, defaultContext);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Advance past 60s stall timeout
    vi.advanceTimersByTime(61_000);

    const result = await promise;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.success).toBe(false);
  });

  it('rejects with descriptive error message including ffmpeg stalled', async () => {
    setupMergeFiles([120, 120]);
    const child = new MockChildProcess();
    child.kill = vi.fn().mockImplementation(() => {
      process.nextTick(() => child.emit('close', null));
    });
    mockSpawn.mockReturnValue(child as never);

    const promise = processAudioFiles('/lib/book', defaultConfig, defaultContext);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    vi.advanceTimersByTime(61_000);

    const result = await promise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('ffmpeg stalled');
    }
  });

  it('progress output resets the 60s timeout clock', async () => {
    setupMergeFiles([200, 200]);
    const child = new MockChildProcess();
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child as never);

    const promise = processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Advance 50s — not yet timed out
    vi.advanceTimersByTime(50_000);
    // Emit progress to reset the clock
    child.stdout.emit('data', Buffer.from('out_time_us=100000000\n'));
    // Advance another 50s — would be 100s total without reset, but only 50s since last progress
    vi.advanceTimersByTime(50_000);

    expect(child.kill).not.toHaveBeenCalled();

    // Complete normally
    child.emit('close', 0);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it('normal completion within timeout resolves successfully', async () => {
    setupMergeFiles([120, 120]);
    const child = new MockChildProcess();
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child as never);

    const promise = processAudioFiles('/lib/book', defaultConfig, defaultContext);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Complete well before timeout
    vi.advanceTimersByTime(5_000);
    child.emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

/**
 * Mock execFile to handle ffprobe calls with stream detection.
 * For each file path, returns ffprobe output with the specified number of video streams.
 */
function mockExecFileWithStreams(fileStreamMap: Record<string, number>) {
  installExecFileDispatcher({ videoStreams: fileStreamMap });
}

describe('#424 cover art detection and extraction', () => {
  it('detects video stream via ffprobe and extracts cover from first file with art', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    // spawn called: 1=extract, 2=encode, 3=reattach
    let spawnCallCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCallCount++;
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
    // 3 spawn calls: extract + encode + reattach
    expect(spawnCallCount).toBe(3);

    // First spawn call should be cover extraction
    const extractArgs = mockSpawn.mock.calls[0]![1] as string[];
    expect(extractArgs).toContain('-an');
    expect(extractArgs).toContain('-vcodec');
    expect(extractArgs).toContain('copy');
    expect(extractArgs).toContain('/lib/book/01.mp3');
  });

  it('extracts cover from second file when first file has no art', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 0,
      '/lib/book/02.mp3': 1,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);

    // First spawn call = extraction, should reference second file
    const extractArgs = mockSpawn.mock.calls[0]![1] as string[];
    expect(extractArgs).toContain('/lib/book/02.mp3');
    expect(extractArgs).toContain('-an');
  });

  it('skips extraction when no files have video streams', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 0,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
    // Only 1 spawn call: encode (no extract, no reattach)
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('cover extraction uses -an -vcodec copy ffmpeg args', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    const extractArgs = mockSpawn.mock.calls[0]![1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['-y', '-i', '/lib/book/01.mp3', '-an', '-vcodec', 'copy']));
  });

  it('cover extraction failure does not fail the merge — graceful degradation', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 1) {
        // Extraction fails
        process.nextTick(() => child.emit('close', 1));
      } else {
        // Encode succeeds
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    // Merge still succeeds despite extraction failure
    expect(result.success).toBe(true);
    // Only 2 calls: extract (failed) + encode (no reattach since no cover)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('emits warning via onStderr when cover extraction fails', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 1) {
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const onStderr = vi.fn();
    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
      { onStderr },
    );

    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('Cover art extraction failed'),
    );
  });

  it('returns warnings in ProcessingResult when extraction fails (no callbacks needed)', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 1) {
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    // No callbacks — exercises the optional-callback path
    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Cover art extraction failed')]),
      );
    }
  });

  it('zero-byte extracted cover skips reattach', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    // Override stat to return 0 bytes for extracted cover
    mockStat.mockResolvedValueOnce({ size: 0 } as never);

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
    // Only 2 calls: extract + encode (no reattach for zero-byte cover)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('#424 cover art reattach (M4B only)', () => {
  it('reattach step runs after M4B encode with correct ffmpeg args', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    // Third spawn call = reattach
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    const reattachArgs = mockSpawn.mock.calls[2]![1] as string[];
    expect(reattachArgs).toContain('-disposition:v:0');
    expect(reattachArgs).toContain('attached_pic');
    expect(reattachArgs).toContain('-c');
    expect(reattachArgs).toContain('copy');
  });

  it('reattach uses -c copy (no re-encode)', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    const reattachArgs = mockSpawn.mock.calls[2]![1] as string[];
    const cIdx = reattachArgs.indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    expect(reattachArgs[cIdx + 1]).toBe('copy');
  });

  it('no cover reattach for MP3 output format', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3' }, defaultContext,
    );

    // 2 calls: extract + encode. No reattach for MP3.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('reattach failure preserves audio-only M4B as final output', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 3) {
        // Reattach fails
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    // 3 spawn calls happened: extract + encode + reattach (failed)
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    // Merge still succeeds — audio-only M4B is the output
    expect(result.success).toBe(true);
  });

  it('emits warning via onStderr when cover reattach fails', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 3) {
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const onStderr = vi.fn();
    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
      { onStderr },
    );

    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('Cover art reattach failed'),
    );
  });

  it('returns warnings in ProcessingResult when reattach fails (no callbacks needed)', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 3) {
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    // No callbacks — exercises the optional-callback path
    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Cover art reattach failed')]),
      );
    }
  });
});

describe('#424 cover art temp file cleanup', () => {
  it('temp cover file removed after successful reattach', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    // rm called for temp cover file
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('_cover'),
      expect.objectContaining({ force: true }),
    );
  });

  it('temp cover file removed when reattach fails (finally block)', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 3) {
        // Reattach fails
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    // rm still called for temp cover file despite reattach failure
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('_cover'),
      expect.objectContaining({ force: true }),
    );
  });

  it('temp cover file cleaned up when encode fails (finally block)', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 1,
      '/lib/book/02.mp3': 0,
    });

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      const child = new MockChildProcess();
      if (callIdx === 2) {
        // Encode step fails (after successful extraction)
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(false);

    // Cover temp file still cleaned up despite encode failure
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('_cover'),
      expect.objectContaining({ force: true }),
    );
  });

  it('no temp file created when no cover art detected', async () => {
    setupMergeFiles([120, 120]);
    mockExecFileWithStreams({
      '/lib/book/01.mp3': 0,
      '/lib/book/02.mp3': 0,
    });

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

    // rm should only be called for concat/metadata temp files, not cover
    for (const call of mockRm.mock.calls) {
      const path = call[0] as string;
      expect(path).not.toContain('_cover');
    }
  });

  describe('AbortSignal support', () => {
    it('kills the child process when signal is aborted during processing', async () => {
      // Setup: 2 files so merge path is taken
      mockReaddir.mockResolvedValue([
        { name: '01.mp3', isFile: () => true, isDirectory: () => false },
        { name: '02.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(readChapterSources).mockResolvedValue([
        { filePath: '/lib/book/01.mp3', title: 'Ch 1' },
        { filePath: '/lib/book/02.mp3', title: 'Ch 2' },
      ]);
      mockExecFileSuccess('30.0');

      const controller = new AbortController();
      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      // Start processAudioFiles — it will await spawnFfmpeg
      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        undefined, controller.signal,
      );

      // Let setup (readdir, readChapterSources, getFileDurations, writeFile) settle
      await new Promise((r) => setTimeout(r, 50));

      // Abort while ffmpeg is running
      controller.abort();

      // The child process should be killed
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exit after kill
      child.emit('close', 1);

      const result = await promise;
      expect(result.success).toBe(false);
    });

    it('does not spawn process when signal is already aborted before spawn', async () => {
      mockReaddir.mockResolvedValue([
        { name: '01.mp3', isFile: () => true, isDirectory: () => false },
        { name: '02.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(readChapterSources).mockResolvedValue([
        { filePath: '/lib/book/01.mp3', title: 'Ch 1' },
        { filePath: '/lib/book/02.mp3', title: 'Ch 2' },
      ]);
      mockExecFileSuccess('30.0');

      const controller = new AbortController();
      controller.abort(); // Abort before calling

      const result = await processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        undefined, controller.signal,
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain('aborted');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    // #2080 — the cover phases now take the same signal as the encode, and an abort there
    // propagates AS an abort rather than degrading into a cover warning.
    it('cancel during the cover reattach fails the merge and leaves the sources on disk', async () => {
      setupMergeFiles([120, 120]);
      mockExecFileWithStreams({ '/lib/book/01.mp3': 1, '/lib/book/02.mp3': 0 });

      const controller = new AbortController();
      let spawnCall = 0;
      let reattachChild: MockChildProcess | undefined;
      mockSpawn.mockImplementation(() => {
        spawnCall++;
        const child = new MockChildProcess();
        // Spawn order on the merge path: 1 = cover extract, 2 = encode, 3 = cover reattach.
        if (spawnCall === 3) {
          reattachChild = child;
          // The operator hits Cancel mid-reattach: SIGTERM, then ffmpeg closes with a null code.
          process.nextTick(() => { controller.abort(); child.emit('close', null); });
        } else {
          process.nextTick(() => child.emit('close', 0));
        }
        return child as never;
      });

      const result = await processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        undefined, controller.signal,
      );

      // Never throws out of the module — MergeService's cancelled classification keys on the
      // unsuccessful result plus its own aborted controller.
      expect(result.success).toBe(false);
      expect(!result.success && result.error).not.toContain('Cover art');
      expect(reattachChild!.kill).toHaveBeenCalledWith('SIGTERM');
      // The throw routes through mergeFiles' catch, which never reaches removeSourceFiles.
      expect(mockUnlink).not.toHaveBeenCalled();
    });

  });
});

// #1720 — the merged output renders the configured fileFormat + book-level tokens. (#1720's
// convert-side stem disambiguation went with the convert path itself in #2062; `disambiguateStems`
// is now pinned only through its surviving consumer, `planFileRenames`.)
describe('processAudioFiles — fileFormat token threading (#1720)', () => {
  describe('merge book-level token rendering', () => {
    it('renders {series}/{seriesPosition}/{edition} into the collapsed merged filename', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      const ctx: ProcessingContext = {
        author: 'Brandon Sanderson',
        title: 'The Way of Kings',
        fileFormat: '{author} - {series} - {seriesPosition:00} - {title} ({edition})',
        bookTokens: { series: 'The Stormlight Archive', seriesPosition: 1, edition: 'Full Cast' },
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.outputFiles).toEqual([
        join('/lib/book', 'Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast).m4b'),
      ]);
    });

    it('drops the absent per-file token cleanly under the Detailed preset (no trailing " - ", no empty "()")', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      const ctx: ProcessingContext = {
        author: 'Brandon Sanderson',
        title: 'The Way of Kings',
        // Detailed preset (#1829): conditional per-file `{ - ?trackNumber:000}` wrapper.
        fileFormat: '{author} - {series? - }{seriesPosition:00? - }{title}{ (?edition?)}{ - ?trackNumber:000}',
        bookTokens: { series: 'The Stormlight Archive', seriesPosition: 1, edition: 'Full Cast' },
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The absent trackNumber wrapper disappears — no ' - ' artifact, no empty parens.
      expect(result.outputFiles).toEqual([
        join('/lib/book', 'Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast).m4b'),
      ]);
    });

    it('bare (non-conditional) per-file separator parity — residual " - " matches planFileRenames single-file output (F3)', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      // Hand-written non-conditional per-file separator: partName absent → residual ' - '.
      const ctx: ProcessingContext = {
        author: 'Author',
        title: 'Title',
        fileFormat: '{author} - {partName} - {title}',
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // stripEmptyWrappers collapses the doubled space but keeps the bare ' - ' literals —
      // byte-for-byte what planFileRenames produces for the same single-file book (not a defect here).
      expect(result.outputFiles).toEqual([join('/lib/book', 'Author - - Title.m4b')]);
    });

    it('falls back to `${author} - ${title}` when fileFormat is empty', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      const ctx: ProcessingContext = {
        author: 'Tolkien',
        title: 'The Hobbit',
        bookTokens: { series: 'Ignored', edition: 'Ignored' }, // present but unused on the fallback path
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.outputFiles).toEqual([join('/lib/book', 'Tolkien - The Hobbit.m4b')]);
    });
  });
});

// ============================================================================
// #2068 — keepOriginalBitrate: stream copy, and an explicit -b:a on every encode
// ============================================================================

/** Merge-path setup with explicit file names, so extension-sensitive cases are constructible. */
function setupMergeSet(names: string[], durations?: number[]): string[] {
  mockReaddir.mockResolvedValue(
    names.map((name) => ({ name, isFile: () => true, isDirectory: () => false })) as never,
  );
  const sources = names.map((name, i) => ({
    filePath: `/lib/book/${name}`, title: `Ch ${i + 1}`, trackNumber: i + 1,
  }));
  mockReadChapterSources.mockResolvedValue(sources);
  mockResolveChapterTitle.mockImplementation((_s, i) => `Chapter ${i + 1}`);
  installExecFileDispatcher({ durations: durations ?? names.map(() => 120) });
  return sources.map((s) => s.filePath);
}

function streamInfoFor(paths: string[], fixture: StreamInfoFixture): Record<string, StreamInfoFixture> {
  return Object.fromEntries(paths.map((p) => [p, fixture]));
}

const KEEP_ORIGINAL = (() => {
  const { bitrate: _bitrate, ...rest } = defaultConfig;
  return rest;
})();
const MERGED_M4B = join('/lib/book', 'Brandon Sanderson - The Way of Kings.m4b');
const MERGED_MP3 = join('/lib/book', 'Brandon Sanderson - The Way of Kings.mp3');

describe('#2068 stream-copy path (AC1–AC4)', () => {
  it('copies an eligible AAC/m4b set, preserving every other arg in position', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b', '03.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '251000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    const result = await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);
    expect(result.success).toBe(true);

    expect(encodeSpawnArgs()).toEqual([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', join('/lib/book', '_concat.txt'),
      '-i', join('/lib/book', '_metadata.txt'),
      // #2078: the first source is opened as an extra input purely so its global tags can be
      // mapped forward. `-map 0:a` keeps the concat input the only audio source.
      // The donor input is audioFiles[0] passed VERBATIM (a POSIX fixture literal), not a
      // join()-built path — asserting join() here fails on Windows.
      '-i', '/lib/book/01.m4b',
      '-map', '0:a',
      '-map_metadata', '2',
      '-map_chapters', '1',
      '-c:a', 'copy',
      '-vn',
      '-max_muxing_queue_size', '4096',
      '-f', 'mp4',
      '-progress', 'pipe:1',
      MERGED_M4B,
    ]);
    expect(encodeSpawnArgs()).not.toContain('-b:a');
    expect(encodeSpawnArgs()).not.toContain('aac');
    expect(encodeSpawnArgs()).not.toContain('libmp3lame');
  });

  it('parses the stream probe into non-null technical fields (mock-shape regression)', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '251000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    // A dispatcher returning the wrong callback shape makes every probe null, which silently
    // disables the copy path — the copy decision below is only reachable from parsed fields.
    expect(streamProbeCalls()).toHaveLength(2);
    expect(encodeSpawnArgs()).toContain('copy');
  });

  it('copies an eligible .mp3 set into mp3, with no chapter input and -map_chapters -1 (#2083)', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext,
    );
    expect(result.success).toBe(true);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    // #2083: this assertion was `not.toContain('-map_chapters')` until the metadata donor's
    // internal chapters started landing on the merged mp3. Asserted as the LITERAL `-1` and
    // deliberately NOT through `mappedInput()`: the suppression sentinel is not an input index,
    // so mappedInput would return `undefined` — indistinguishable from the flag being absent,
    // i.e. from the exact pre-fix state this assertion exists to detect.
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
    // #2078: mp3 has no generated-chapter input, so the first source is input 1 and carries
    // the global tags forward. `-map_metadata` is now present on this path — pointed at the
    // SOURCE, never at a chapter file (there isn't one here).
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('1');
    // Verbatim donor path (POSIX fixture literal), never join()-built — see the m4b twin above.
    expect(args[args.indexOf('-i', args.indexOf('-i') + 1) + 1]).toBe('/lib/book/01.mp3');
    expect(args[args.length - 1]).toBe(MERGED_MP3);
  });

  it('emits -map_chapters 1 in encode mode on the m4b path too (AC3)', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-i', args.indexOf('-i') + 1) + 1]).toBe(join('/lib/book', '_metadata.txt'));
    // #2078 moved global metadata onto the first source (input 2); chapters stay on the
    // generated ffmetadata input (1), which is the #2068 guarantee.
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('2');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('1');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args).toContain('-b:a');
  });
});

describe('#2068 explicit -b:a on every encode (AC5–AC11)', () => {
  it('re-encodes an all-MP3 set to m4b at the probed maximum', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo({
      [paths[0]!]: { codec_name: 'mp3', bit_rate: '251000', sample_rate: '44100', channels: 2 },
      [paths[1]!]: { codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2 },
    });
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-b:a') + 1]).toBe('251k');
  });

  it('falls back to 192k for m4b with no usable probe or hint, reporting it once', async () => {
    setupMergeSet(['01.mp3', '02.mp3']);
    mockSpawnSuccess();

    const result = await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('192k');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('192');
  });

  it('reports both the fallback and its MP3 legalization for unknown rates', async () => {
    setupMergeSet(['01.mp3', '02.mp3']);
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext,
    );

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('160k');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings![0]).toContain('192');
    expect(result.warnings![1]).toMatch(/192.*160/);
  });

  it('legalizes a 1411 kbps 44.1 kHz PCM set to 320k for mp3, and shapes nothing', async () => {
    const paths = setupMergeSet(['01.wav', '02.wav']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'pcm_s16le', bit_rate: '1411000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext,
    );

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('libmp3lame');
    expect(args[args.indexOf('-b:a') + 1]).toBe('320k');
    expect(args).not.toContain('-ar');
    expect(result.warnings!.some((w) => w.includes('1411') && w.includes('320'))).toBe(true);
  });

  it('caps a 22.05 kHz set at the MPEG-2 table maximum, never 320k', async () => {
    const paths = setupMergeSet(['01.wav', '02.wav']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'pcm_s16le', bit_rate: '705000', sample_rate: '22050', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-b:a') + 1]).toBe('160k');
    expect(args).not.toContain('320k');
    expect(args).not.toContain('-ar');
  });

  it('uses the rate-agnostic table when a probed sample rate is absent, without resampling', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, { codec_name: 'mp3', bit_rate: '256000', channels: 2 }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-b:a') + 1]).toBe('160k');
    expect(args).not.toContain('-ar');
  });

  it.each(['m4b', 'mp3'] as const)(
    'emits neither -ar nor -ac for an 11024 Hz 6-channel source (%s output)',
    async (outputFormat) => {
      const paths = setupMergeSet(['01.wav', '02.wav']);
      setStreamInfo(streamInfoFor(paths, {
        codec_name: 'pcm_s16le', bit_rate: '128000', sample_rate: '11024', channels: 6,
      }));
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', { ...KEEP_ORIGINAL, outputFormat }, defaultContext);

      const args = encodeSpawnArgs();
      expect(args).not.toContain('-ar');
      expect(args).not.toContain('-ac');
      expect(args).toContain('-b:a');
    },
  );

  it.each([
    ['44100', '320k'],
    ['22050', '160k'],
  ])('legalizes an explicit 512 kbps mp3 target at %s Hz to %s', async (sampleRate, expected) => {
    const paths = setupMergeSet(['01.wav', '02.wav']);
    setStreamInfo(streamInfoFor(paths, { codec_name: 'pcm_s16le', sample_rate: sampleRate, channels: 2 }));
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3', bitrate: 512 }, defaultContext,
    );

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe(expected);
    expect(result.warnings!.some((w) => w.includes('512'))).toBe(true);
  });

  it('tells the operator when their explicit 200 kbps became 192 kbps', async () => {
    const paths = setupMergeSet(['01.wav', '02.wav']);
    setStreamInfo(streamInfoFor(paths, { codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2 }));
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3', bitrate: 200 }, defaultContext,
    );

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('192k');
    expect(result.warnings!.some((w) => w.includes('200') && w.includes('192'))).toBe(true);
  });

  it('records one evidence-cap notice when the source caps the operator target', async () => {
    setupMergeSet(['01.mp3', '02.mp3']);
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 64 }, defaultContext,
    );

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('64k');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toMatch(/128.*64/);
  });

  it('records nothing when min() returns the operator target unchanged', async () => {
    setupMergeSet(['01.mp3', '02.mp3']);
    mockSpawnSuccess();

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 251 }, defaultContext,
    );

    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('128k');
    expect(result.warnings).toBeUndefined();
  });
});

describe('#2068 probe cost and notice preservation (AC12)', () => {
  it('probes each source exactly once on the keep-original merge path', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3', '03.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const probed = streamProbeCalls().map((call) => (call[1] as string[]).at(-1));
    expect(probed).toHaveLength(3);
    expect(new Set(probed).size).toBe(3);
  });

  it('probes on the explicit-target path too — AC8 needs the source sample rates', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', { ...defaultConfig, bitrate: 320 }, defaultContext);

    expect(streamProbeCalls()).toHaveLength(2);
  });

  // The convert path's `keeps earlier notices when a later convert command fails` case died with
  // it (#2062). This is the same contract on the surviving path: `warnings` is on BOTH
  // ProcessingResult variants, so an adjustment made before the encode failed is still reported.
  it('keeps the resolver notices when the merge encode fails', async () => {
    const paths = setupMergeSet(['01.wav', '02.wav']);
    setStreamInfo(streamInfoFor(paths, { codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2 }));
    mockSpawnFailure(1);

    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3', bitrate: 200 }, defaultContext,
    );

    expect(result.success).toBe(false);
    expect(result.warnings!.some((w) => w.includes('200') && w.includes('192'))).toBe(true);
  });
});

describe('#2068 invariant — an encoder token never appears without -b:a (AC5)', () => {
  const CONFIGS: Array<Partial<ProcessingConfig>> = [
    {},
    { bitrate: 128 },
    { bitrate: 320, sourceBitrateKbps: 64 },
    { bitrate: Number.NaN },
    { bitrate: 0 },
    { bitrate: -1 },
    { bitrate: 7 },
    { bitrate: 128.5 },
    { sourceBitrateKbps: 0 },
    { sourceBitrateKbps: 827 / 1000 },
    { sourceBitrateKbps: 1411 },
  ];
  const PROBES: Array<StreamInfoFixture | null> = [
    null,
    { codec_name: 'aac', bit_rate: '251000', sample_rate: '44100', channels: 2 },
    { codec_name: 'mp3', bit_rate: '64000', sample_rate: '22050', channels: 1 },
    { codec_name: 'mp3' },
  ];

  it.each(['m4b', 'mp3'] as const)('holds for every config shape (%s output)', async (outputFormat) => {
    for (const overrides of CONFIGS) {
      for (const probe of PROBES) {
        vi.clearAllMocks();
        const paths = setupMergeSet(['01.m4b', '02.m4b']);
        setStreamInfo(probe ? streamInfoFor(paths, probe) : {});
        mockSpawnSuccess();

        const { bitrate: _drop, ...base } = defaultConfig;
        await processAudioFiles('/lib/book', { ...base, outputFormat, ...overrides }, defaultContext);

        const args = encodeSpawnArgs();
        const codec = args[args.indexOf('-c:a') + 1]!;
        if (codec === 'copy') {
          expect(args).not.toContain('-b:a');
          continue;
        }
        expect(['aac', 'libmp3lame']).toContain(codec);
        const value = args[args.indexOf('-b:a') + 1]!;
        const parsed = Number.parseInt(value.replace(/k$/, ''), 10);
        expect(value).toMatch(/^\d+k$/);
        expect(Number.isFinite(parsed)).toBe(true);
        expect(parsed).toBeGreaterThan(0);
      }
    }
  });
});

describe('#2068 the caller delivers the resolver notices verbatim (AC14)', () => {
  it('surfaces exactly the notices the resolver produced, re-deriving no predicate', async () => {
    setupMergeSet(['01.mp3', '02.mp3']);
    mockSpawnSuccess();

    const stubbed = ['first stubbed notice', 'second stubbed notice'];
    vi.mocked(resolveCodecArgs).mockImplementation(async (_config, _paths, warnings) => {
      warnings.push(...stubbed);
      return ['-c:a', 'aac', '-b:a', '96k'];
    });

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(stubbed);
    expect(encodeSpawnArgs()[encodeSpawnArgs().indexOf('-b:a') + 1]).toBe('96k');
  });
});

// ============================================================================
// #2078 — merge carries the source parts' global tags into the output
// ============================================================================

/** The ordered `-i` operands of a spawn argv — ffmpeg input N is `inputPaths(args)[N]`. */
function inputPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-i') paths.push(args[i + 1]!);
  }
  return paths;
}

/**
 * Resolve a `-map_metadata` / `-map_chapters` operand back to the FILE it points at.
 *
 * The index is computed by production, so asserting the literal digit would pin a
 * position rather than the mapping. Reading the operand back through the input list
 * asserts the property the AC is actually about: which file the flag resolves to.
 */
function mappedInput(args: string[], flag: '-map_metadata' | '-map_chapters'): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return inputPaths(args)[Number(args[idx + 1])];
}

describe('#2078 merge preserves the source files\' global tags (AC1–AC4)', () => {
  const CONCAT = join('/lib/book', '_concat.txt');
  const FFMETADATA = join('/lib/book', '_metadata.txt');

  it('m4b: opens the first source as an extra input and maps global metadata from it', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b', '03.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(inputPaths(args)).toEqual([CONCAT, FFMETADATA, paths[0]]);
    expect(mappedInput(args, '-map_metadata')).toBe(paths[0]);
  });

  it('m4b: -map_metadata never resolves to the generated chapter ffmetadata file', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    // The pre-#2078 defect exactly: input 1 is the generated FFMETADATA1 file, which carries
    // only [CHAPTER] blocks, so mapping global metadata from it wrote an EMPTY tag set.
    expect(mappedInput(encodeSpawnArgs(), '-map_metadata')).not.toBe(FFMETADATA);
  });

  it('m4b: -map_chapters still resolves to the generated ffmetadata input (#2068, AC3)', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(mappedInput(args, '-map_chapters')).toBe(FFMETADATA);
    expect(args).toContain('-b:a'); // encode mode, not copy
  });

  it('m4b: -map_chapters resolves to the generated ffmetadata input in copy mode too (AC3)', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(mappedInput(args, '-map_chapters')).toBe(FFMETADATA);
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('mp3: opens the first source as input 1, maps metadata from it, and suppresses its chapters', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles(
      '/lib/book', { ...KEEP_ORIGINAL, outputFormat: 'mp3' }, defaultContext,
    );

    const args = encodeSpawnArgs();
    // These two pin that #2083's fix added no input and moved no mapping.
    expect(inputPaths(args)).toEqual([CONCAT, paths[0]]);
    expect(mappedInput(args, '-map_metadata')).toBe(paths[0]);
    // #2083 — literal sentinel, not `mappedInput()`: `-1` resolves to no input at all, so
    // reading it back through the input list cannot tell suppression from omission.
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('mp3 encode mode: -map_chapters -1 survives the encode branch too (#2083 AC1)', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    // A usable explicit bitrate always re-encodes: defaultConfig keeps `bitrate`, KEEP_ORIGINAL drops it.
    await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3' }, defaultContext,
    );

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('libmp3lame');
    expect(args).toContain('-b:a');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
    // Still exactly the copy-mode input layout: the encode branch opens no chapter input.
    expect(inputPaths(args)).toEqual([CONCAT, paths[0]]);
    expect(args[args.length - 1]).toBe(MERGED_MP3);
  });

  it('emits an explicit -map 0:a so the concat input is the only audio source (AC2)', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    // Two audio-bearing inputs are now open (concat + the first source). Without an explicit
    // map, ffmpeg picks the "best" audio stream across ALL inputs, which can silently emit the
    // first part alone. Assert the operand resolves to the concat input, not its position.
    const args = encodeSpawnArgs();
    const mapIdx = args.indexOf('-map');
    expect(mapIdx).toBeGreaterThan(-1);
    const [inputIndex, specifier] = args[mapIdx + 1]!.split(':');
    expect(inputPaths(args)[Number(inputIndex)]).toBe(CONCAT);
    expect(specifier).toBe('a');
  });

  it('a copy-eligible set still copies, with no -b:a, despite the extra input (AC4)', async () => {
    const paths = setupMergeSet(['01.m4b', '02.m4b', '03.m4b']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'aac', bit_rate: '251000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', KEEP_ORIGINAL, defaultContext);

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).not.toContain('-b:a');
    expect(args).not.toContain('aac');
  });

});
