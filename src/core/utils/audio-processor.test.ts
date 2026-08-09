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

// Keep real resolver behavior except where a test verifies the caller trusts this seam.
vi.mock('./encode-strategy.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolveCodecArgs: vi.fn().mockImplementation(actual.resolveCodecArgs as (...args: unknown[]) => unknown),
  };
});

// ProcessingResult keeps only a message, so this spy exposes the caught value's type.
vi.mock('@shared/error-message.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getErrorMessage: vi.fn().mockImplementation(actual.getErrorMessage as (...args: unknown[]) => unknown),
  };
});

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

// clearAllMocks keeps implementations, so restore these passthrough spies between tests.
const actualEncodeStrategy = await vi.importActual<typeof import('./encode-strategy.js')>('./encode-strategy.js');
const actualErrorMessage = await vi.importActual<typeof import('@shared/error-message.js')>('@shared/error-message.js');

// execFile remains callback-based when production wraps it with promisify.
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

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function mockSpawnSuccess(): MockChildProcess {
  const child = new MockChildProcess();
  mockSpawn.mockReturnValue(child as never);
  // Defer close until production attaches listeners.
  process.nextTick(() => child.emit('close', 0));
  return child;
}

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

interface StreamInfoFixture {
  codec_name?: string;
  /** ffprobe reports bps; production floors to kbps. */
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
}

/** Missing or null entries model unreadable streams without queued mock leakage. */
let streamInfoByFile: Record<string, StreamInfoFixture | null> = {};

function setStreamInfo(map: Record<string, StreamInfoFixture | null>): void {
  // Normalize fixtures because join-built probes use backslashes on Windows.
  streamInfoByFile = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k.split('\\').join('/'), v]),
  );
}

/**
 * Preserves execFile's two callback contracts: promisified callers receive an object, while raw
 * stream probes receive positional output. Mixing them silently turns probes into null and
 * disables copy-mode coverage.
 */
function installExecFileDispatcher(opts: {
  durations?: number[];
  videoStreams?: Record<string, number>;
} = {}): void {
  let durationIdx = 0;
  const videoStreams = Object.fromEntries(
    Object.entries(opts.videoStreams ?? {}).map(([k, v]) => [k.split('\\').join('/'), v]),
  );
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') return {} as never;
    const execArgs = (args[1] as string[] | undefined) ?? [];
    const filePath = execArgs[execArgs.length - 1] ?? '';
    // Fixture keys are POSIX literals; production probes may be join-built Windows paths.
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

function streamProbeCalls(): unknown[][] {
  return mockExecFile.mock.calls.filter(
    (call) => (call[1] as string[] | undefined)?.includes('stream=codec_name,bit_rate,sample_rate,channels') ?? false,
  );
}

/** Selects the encode argv because cover handling adds other spawns. */
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
  // Isolate ambient FFMPEG_PATH so local overrides cannot reorder probes.
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
      if (file === '/bad/ffmpeg') cb(new Error('spawn ENOENT'));
      else cb(null, { stdout: 'ffmpeg version 8.0.1' });
      return {} as never;
    });
    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/bin/ffmpeg');
  });

  it('falls back to which ffmpeg when /usr/bin/ffmpeg probe fails', async () => {
    // Dispatch by command because clearAllMocks does not drain mockImplementationOnce queues.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else if (file === '/usr/local/bin/ffmpeg') cb(null, { stdout: 'ffmpeg version 8.0.1' });
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
    // `which` is not proof that the candidate can run.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else cb(new Error('spawn ENOENT'));
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
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it('coalesces concurrent callers onto ONE detection — single-flight (finding 7)', async () => {
    mockExecFileSuccess('ffmpeg version 8.0.1');
    const [a, b] = await Promise.all([resolveFfmpegPath(), resolveFfmpegPath()]);
    expect(a).toBe('/usr/bin/ffmpeg');
    expect(b).toBe('/usr/bin/ffmpeg');
    expect(mockExecFile.mock.calls.length).toBe(1);
  });

  it('holds a miss under the negative TTL — does NOT re-spawn within the window (finding 7)', async () => {
    mockExecFileFailure('spawn ENOENT');
    expect(await resolveFfmpegPath()).toBeNull();
    const callsAfterFirst = mockExecFile.mock.calls.length;
    expect(await resolveFfmpegPath()).toBeNull();
    // Avoid two subprocesses per book during degraded scans.
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-detects a miss after the negative TTL expires (finding 7)', async () => {
    vi.useFakeTimers();
    try {
      mockExecFileFailure('spawn ENOENT');
      expect(await resolveFfmpegPath()).toBeNull();
      const callsAfterFirst = mockExecFile.mock.calls.length;
      vi.advanceTimersByTime(31_000);
      expect(await resolveFfmpegPath()).toBeNull();
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('media-tool env sanitization', () => {
  // execFile and spawn place options at index 2.
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
    // Dispatch by command because clearAllMocks does not drain mockImplementationOnce queues.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
      if (file === 'which') cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
      else if (file === '/usr/local/bin/ffmpeg') cb(null, { stdout: 'ffmpeg version 8.0.1' });
      else cb(new Error('spawn ENOENT'));
      return {} as never;
    });

    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/local/bin/ffmpeg');

    // The first call probes /usr/bin; the second invokes which.
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

    expect(mockExecFile).toHaveBeenCalled();
    const { env } = optsOf(mockExecFile.mock.calls[0]!);
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).toHaveProperty('PATH');
  });
});

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

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
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

describe('#2062 fail-closed below the merge minimum', () => {
  /** Installs a success path so a missing guard fails assertions instead of hanging on a probe. */
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

    const thrown = caughtError();
    expect(thrown).toBeInstanceOf(InsufficientAudioFilesError);
    expect((thrown as InsufficientAudioFilesError).count).toBe(1);
  });

  it('refuses an EMPTY directory instead of succeeding with no output files', async () => {
    seedDirectory([]);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(result).toEqual({ success: false, error: 'Merge requires at least 2 audio files, found 0' });
    expect(caughtError()).toBeInstanceOf(InsufficientAudioFilesError);
    expectNoWork();
  });

  it('refuses a directory holding only non-audio files', async () => {
    seedDirectory(['readme.txt', 'cover.jpg']);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    expect(!result.success && result.error).toBe('Merge requires at least 2 audio files, found 0');
    expectNoWork();
  });

  it('does not count dot-prefixed audio toward the minimum', async () => {
    // Processor and eligibility must both ignore born-hidden transient audio.
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
    // Unusable-target warnings must reach merge results through resolveCodecArgs.
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

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]![0]).toBe('/usr/bin/ffmpeg');
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toContain('ffprobe');
      }
    });
  });

  describe('onProgress callback', () => {
    it('invoked with phase processing and percentage (0..1 ratio) when stdout emits out_time_us', async () => {
      setupMergeFiles([100, 100]);
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      // Emit 100 seconds of progress against the 200-second total (0.5).
      child.stdout.emit('data', Buffer.from('out_time_us=100000000\n'));
      child.emit('close', 0);

      await promise;
      expect(onProgress).toHaveBeenCalledWith('processing', 0.5);
    });

    it('percentage clamped to 0..1 when out_time_us exceeds total duration', async () => {
      setupMergeFiles([100, 100]);
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        { onProgress },
      );

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

      child.stdout.emit('data', Buffer.from('out_time_us=300000000\n'));
      child.emit('close', 0);

      await promise;
      expect(onProgress).toHaveBeenCalledWith('processing', 1);
    });

    it('percentage is 0 when totalDuration is 0 (no division by zero)', async () => {
      setupMergeFiles([0, 0]);
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
      // With zero totalDuration, onProgress is not called.
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('negative out_time_us treated as 0 percentage', async () => {
      setupMergeFiles([100, 100]);
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
      expect(mockRm).toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  describe('backward compatibility', () => {
    it('processAudioFiles works without onProgress/onStderr callbacks (optional params)', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
      expect(result.success).toBe(true);
    });
  });
});

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

    vi.advanceTimersByTime(50_000);
    child.stdout.emit('data', Buffer.from('out_time_us=100000000\n'));
    vi.advanceTimersByTime(50_000);

    expect(child.kill).not.toHaveBeenCalled();

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

    vi.advanceTimersByTime(5_000);
    child.emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

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

    // Cover pipeline order: extract, encode, reattach.
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
    expect(spawnCallCount).toBe(3);

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
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
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

    mockStat.mockResolvedValueOnce({ size: 0 } as never);

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(result.success).toBe(true);
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

    // Cover pipeline order makes index 2 the reattach.
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
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    const result = await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(3);
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
        process.nextTick(() => child.emit('close', 1));
      } else {
        process.nextTick(() => child.emit('close', 0));
      }
      return child as never;
    });

    await processAudioFiles(
      '/lib/book', defaultConfig, defaultContext,
    );

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

    for (const call of mockRm.mock.calls) {
      const path = call[0] as string;
      expect(path).not.toContain('_cover');
    }
  });

  describe('AbortSignal support', () => {
    it('kills the child process when signal is aborted during processing', async () => {
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

      const promise = processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        undefined, controller.signal,
      );

      // Let setup settle so spawnFfmpeg owns the child before aborting.
      await new Promise((r) => setTimeout(r, 50));

      controller.abort();

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Resolve the mocked process after SIGTERM.
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
      controller.abort();

      const result = await processAudioFiles(
        '/lib/book', defaultConfig, defaultContext,
        undefined, controller.signal,
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain('aborted');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    // Cover-phase aborts propagate as aborts instead of degrading into cover warnings.
    it('cancel during the cover reattach fails the merge and leaves the sources on disk', async () => {
      setupMergeFiles([120, 120]);
      mockExecFileWithStreams({ '/lib/book/01.mp3': 1, '/lib/book/02.mp3': 0 });

      const controller = new AbortController();
      let spawnCall = 0;
      let reattachChild: MockChildProcess | undefined;
      mockSpawn.mockImplementation(() => {
        spawnCall++;
        const child = new MockChildProcess();
        // Cover pipeline order: extract, encode, reattach.
        if (spawnCall === 3) {
          reattachChild = child;
          // Abort mid-reattach, then model ffmpeg closing after SIGTERM.
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

      // MergeService classifies cancellation from this failure plus its aborted controller.
      expect(result.success).toBe(false);
      expect(!result.success && result.error).not.toContain('Cover art');
      expect(reattachChild!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockUnlink).not.toHaveBeenCalled();
    });

  });
});

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
        // Detailed preset uses a conditional track-number wrapper.
        fileFormat: '{author} - {series? - }{seriesPosition:00? - }{title}{ (?edition?)}{ - ?trackNumber:000}',
        bookTokens: { series: 'The Stormlight Archive', seriesPosition: 1, edition: 'Full Cast' },
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.outputFiles).toEqual([
        join('/lib/book', 'Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast).m4b'),
      ]);
    });

    it('bare (non-conditional) per-file separator parity — residual " - " matches planFileRenames single-file output (F3)', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      const ctx: ProcessingContext = {
        author: 'Author',
        title: 'Title',
        fileFormat: '{author} - {partName} - {title}',
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Bare separators survive empty-token cleanup, matching planFileRenames.
      expect(result.outputFiles).toEqual([join('/lib/book', 'Author - - Title.m4b')]);
    });

    it('falls back to `${author} - ${title}` when fileFormat is empty', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();
      const ctx: ProcessingContext = {
        author: 'Tolkien',
        title: 'The Hobbit',
        bookTokens: { series: 'Ignored', edition: 'Ignored' },
      };

      const result = await processAudioFiles('/lib/book', defaultConfig, ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.outputFiles).toEqual([join('/lib/book', 'Tolkien - The Hobbit.m4b')]);
    });
  });
});

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
      // The donor path stays verbatim; map 0:a keeps concat as the audio source.
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
    // Assert literal -1: mappedInput cannot distinguish suppression from an omitted flag.
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('1');
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
    // Global metadata comes from source input 2; chapters remain on generated input 1.
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

  // Warnings belong to both result variants and must survive a later encode failure.
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

/** The ordered `-i` operands of a spawn argv — ffmpeg input N is `inputPaths(args)[N]`. */
function inputPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-i') paths.push(args[i + 1]!);
  }
  return paths;
}

/** Resolves a mapping to its file so tests avoid brittle literal input positions. */
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

    // Generated FFMETADATA1 contains chapters but no global tags.
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
    expect(args).toContain('-b:a');
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
    expect(inputPaths(args)).toEqual([CONCAT, paths[0]]);
    expect(mappedInput(args, '-map_metadata')).toBe(paths[0]);
    // Assert literal -1 because resolving it cannot distinguish suppression from omission.
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('mp3 encode mode: -map_chapters -1 survives the encode branch too (#2083 AC1)', async () => {
    const paths = setupMergeSet(['01.mp3', '02.mp3']);
    setStreamInfo(streamInfoFor(paths, {
      codec_name: 'mp3', bit_rate: '128000', sample_rate: '44100', channels: 2,
    }));
    mockSpawnSuccess();

    // A usable explicit bitrate forces encode mode.
    await processAudioFiles(
      '/lib/book', { ...defaultConfig, outputFormat: 'mp3' }, defaultContext,
    );

    const args = encodeSpawnArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('libmp3lame');
    expect(args).toContain('-b:a');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
    // Encode mode opens no chapter input.
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

    // Both inputs carry audio; resolve the map to concat rather than pinning its index.
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
