import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  probeFfmpeg,
  detectFfmpegPath,
  processAudioFiles,
  buildChapterMetadata,
  type ProcessingConfig,
  type ProcessingContext,
  type ProcessingCallbacks,
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
}));

vi.mock('./chapter-resolver.js', () => ({
  readChapterSources: vi.fn(),
  resolveChapterTitle: vi.fn(),
}));

// Spy on naming.js — passthrough to real implementation
vi.mock('./naming.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    renderFilename: vi.fn().mockImplementation(actual.renderFilename as (...args: unknown[]) => unknown),
  };
});

import { execFile, spawn } from 'node:child_process';
import { readdir, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';
import { renderFilename } from './naming.js';

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
const mockReadChapterSources = vi.mocked(readChapterSources);
const mockResolveChapterTitle = vi.mocked(resolveChapterTitle);

const defaultConfig: ProcessingConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  outputFormat: 'm4b',
  bitrate: 128,
  mergeBehavior: 'multi-file-only',
};

const defaultContext: ProcessingContext = {
  author: 'Brandon Sanderson',
  title: 'The Way of Kings',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUnlink.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
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
  it('returns /usr/bin/ffmpeg when probe succeeds at known path', async () => {
    mockExecFileSuccess('ffmpeg version 6.1.1 Copyright');
    const result = await detectFfmpegPath();
    expect(result).toBe('/usr/bin/ffmpeg');
  });

  it('falls back to which ffmpeg when /usr/bin/ffmpeg probe fails', async () => {
    mockExecFile
      .mockImplementationOnce((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error) => void;
        cb(new Error('spawn ENOENT'));
        return {} as never;
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: null, result: { stdout: string }) => void;
        cb(null, { stdout: '/usr/local/bin/ffmpeg\n' });
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

  // ffprobe calls for durations (still use execFile)
  let callIdx = 0;
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (typeof cb === 'function') {
      cb(null, { stdout: `${durations[callIdx++] ?? 0}\n`, stderr: '' });
    }
    return {} as never;
  });
}

/** Setup helpers for convert path tests. */
function setupConvertFile() {
  mockReaddir.mockResolvedValue([
    { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
  ] as never);
}

describe('processAudioFiles', () => {
  it('skips processing for single m4b input', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.m4b', isFile: () => true, isDirectory: () => false },
    ] as never);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result).toEqual({ success: true, outputFiles: [join('/lib/book', 'book.m4b')] });
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns empty output for directory with no audio files', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
    ] as never);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result).toEqual({ success: true, outputFiles: [] });
  });

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

  it('converts single file format/bitrate without merge', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'book.m4b')]);
    }
    // Should remove original after conversion
    expect(mockUnlink).toHaveBeenCalledWith(join('/lib/book', 'book.mp3'));
  });

  it('skips merge for single file when mergeBehavior is multi-file-only', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'multi-file-only' };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);
    // Should convert, not merge (no concat file written)
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('re-encodes single file when extension matches but bitrate differs', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    const config: ProcessingConfig = { ...defaultConfig, outputFormat: 'mp3', bitrate: 64 };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'book.mp3')]);
    }
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(join('/lib/book', 'book.mp3'));
    expect(mockRename).toHaveBeenCalledWith(
      join('/lib/book', 'book_tmp.mp3'),
      join('/lib/book', 'book.mp3'),
    );
  });

  it('omits -b:a flag when bitrate is undefined (keep original)', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    const config: ProcessingConfig = { ...defaultConfig, bitrate: undefined };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);

    // spawn should be called — check args
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('-b:a');
    expect(spawnArgs).toContain('-c:a');
  });

  it('returns error result on non-zero ffmpeg exit', async () => {
    setupConvertFile();
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
    const result = await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'The Hobbit by Tolkien.m4b')]);
    }
  });

  it('uses fileFormat template for converted output filenames', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'ch01.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'ch02.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockReadChapterSources.mockResolvedValue([
      { filePath: join('/lib/book', 'ch01.mp3'), trackNumber: 1, title: 'Introduction' },
      { filePath: join('/lib/book', 'ch02.mp3'), trackNumber: 2, title: 'The Journey' },
    ]);
    mockResolveChapterTitle
      .mockReturnValueOnce('Introduction')
      .mockReturnValueOnce('The Journey');

    // spawn called once per file (2 convert calls)
    let spawnCallCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCallCount++;
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const ctx: ProcessingContext = {
      author: 'Tolkien',
      title: 'The Hobbit',
      fileFormat: '{trackNumber:00} - {partName}',
    };
    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'never' };
    const result = await processAudioFiles('/lib/book', config, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([
        join('/lib/book', '01 - Introduction.m4b'),
        join('/lib/book', '02 - The Journey.m4b'),
      ]);
    }
    expect(spawnCallCount).toBe(2);
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
    await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, ctx);

    expect(renderFilename).toHaveBeenCalledWith(
      '{author} - {title}',
      expect.objectContaining({ author: 'Tolkien', title: 'The Hobbit' }),
      expect.objectContaining({ separator: 'period', case: 'upper' }),
    );
  });

  it('forwards namingOptions to renderFilename for converted (non-merge) output', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'ch01.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'ch02.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockReadChapterSources.mockResolvedValue([
      { filePath: join('/lib/book', 'ch01.mp3'), trackNumber: 1, title: 'Introduction' },
      { filePath: join('/lib/book', 'ch02.mp3'), trackNumber: 2, title: 'The Journey' },
    ]);
    mockResolveChapterTitle
      .mockReturnValueOnce('Introduction')
      .mockReturnValueOnce('The Journey');

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const ctx: ProcessingContext = {
      author: 'Tolkien',
      title: 'The Hobbit',
      fileFormat: '{trackNumber:00} - {partName}',
      namingOptions: { separator: 'period', case: 'upper' },
    };
    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'never' };
    await processAudioFiles('/lib/book', config, ctx);

    expect(renderFilename).toHaveBeenCalledWith(
      '{trackNumber:00} - {partName}',
      expect.objectContaining({ author: 'Tolkien', title: 'The Hobbit' }),
      expect.objectContaining({ separator: 'period', case: 'upper' }),
    );
  });

  it('output file named {Author} - {Title}.m4b for merged output', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    const ctx: ProcessingContext = { author: 'Tolkien', title: 'The Hobbit' };
    const result = await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Tolkien - The Hobbit.m4b')]);
    }
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
    // Single file setup for convert path tests
    setupConvertFile();
    mockSpawnSuccess();
  });

  it('uses source bitrate when lower than target (convert path)', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 64 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('64k');
  });

  it('uses source bitrate when lower than target (merge path)', async () => {
    setupMergeFiles([120, 120]);
    // Reset the spawn mock since beforeEach already set one
    mockSpawnSuccess();

    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 64, mergeBehavior: 'always' };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('64k');
  });

  it('uses target bitrate when lower than source', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 64, sourceBitrateKbps: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('64k');
  });

  it('uses either value when source equals target exactly (boundary)', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128, sourceBitrateKbps: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('128k');
  });

  it('uses target bitrate as-is when sourceBitrateKbps is undefined', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: 128 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const bitrateIdx = spawnArgs.indexOf('-b:a');
    expect(bitrateIdx).toBeGreaterThan(-1);
    expect(spawnArgs[bitrateIdx + 1]).toBe('128k');
  });

  it('omits -b:a flag when config.bitrate is undefined regardless of sourceBitrateKbps', async () => {
    const config: ProcessingConfig = { ...defaultConfig, bitrate: undefined, sourceBitrateKbps: 64 };
    await processAudioFiles('/lib/book', config, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('-b:a');
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

      await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext);

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('-max_muxing_queue_size');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('4096');
    });

    it('passes -progress pipe:1 in ffmpeg args', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext);

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('-progress');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('pipe:1');
    });

    it('uses spawn instead of execFile for ffmpeg invocation', async () => {
      setupMergeFiles([120, 120]);
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext);

      // spawn called once for ffmpeg merge, execFile only for ffprobe
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][0]).toBe('/usr/bin/ffmpeg');
      // execFile calls should all be ffprobe (duration probing)
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toContain('ffprobe');
      }
    });
  });

  describe('convertFiles() ffmpeg args', () => {
    it('passes -max_muxing_queue_size 4096 in ffmpeg args', async () => {
      setupConvertFile();
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', defaultConfig, defaultContext);

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('-max_muxing_queue_size');
      const idx = spawnArgs.indexOf('-max_muxing_queue_size');
      expect(spawnArgs[idx + 1]).toBe('4096');
    });

    it('uses spawn instead of execFile for ffmpeg invocation', async () => {
      setupConvertFile();
      mockSpawnSuccess();

      await processAudioFiles('/lib/book', defaultConfig, defaultContext);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][0]).toBe('/usr/bin/ffmpeg');
    });
  });

  describe('onProgress callback', () => {
    it('invoked with phase processing and percentage (0..1 ratio) when stdout emits out_time_us', async () => {
      setupMergeFiles([100, 100]); // 200s total
      const onProgress = vi.fn();

      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as never);

      const promise = processAudioFiles(
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      setupConvertFile();
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      setupConvertFile();
      mockSpawnSuccess();

      // Call without callbacks (3-arg form)
      const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
      expect(result.success).toBe(true);
    });
  });
});
