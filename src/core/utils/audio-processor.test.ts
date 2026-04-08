import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeFfmpeg,
  detectFfmpegPath,
  processAudioFiles,
  buildChapterMetadata,
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

  it('convertFiles uses positional i+1 for trackNumber, ignoring metadata trackNumber', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'ch01.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'ch02.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    // Metadata has track numbers 5 and 10, but positional should be 1 and 2
    mockReadChapterSources.mockResolvedValue([
      { filePath: join('/lib/book', 'ch01.mp3'), trackNumber: 5, title: 'Ch A' },
      { filePath: join('/lib/book', 'ch02.mp3'), trackNumber: 10, title: 'Ch B' },
    ]);
    mockResolveChapterTitle
      .mockReturnValueOnce('Ch A')
      .mockReturnValueOnce('Ch B');

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const ctx: ProcessingContext = {
      author: 'Author',
      title: 'Book',
      fileFormat: '{trackNumber:00} - {partName}',
    };
    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'never' };
    const result = await processAudioFiles('/lib/book', config, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      // Should use positional 1,2 not metadata 5,10
      expect(result.outputFiles).toEqual([
        join('/lib/book', '01 - Ch A.m4b'),
        join('/lib/book', '02 - Ch B.m4b'),
      ]);
    }
  });

  it('convertFiles with multi-disc metadata — positional produces 1,2,3,4 not 1,2,1,2', async () => {
    // Simulates 4 files from 2 discs, already sorted by disc+track by readChapterSources
    mockReaddir.mockResolvedValue([
      { name: '001.mp3', isFile: () => true, isDirectory: () => false },
      { name: '002.mp3', isFile: () => true, isDirectory: () => false },
      { name: '003.mp3', isFile: () => true, isDirectory: () => false },
      { name: '004.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    // Metadata still has per-disc track numbers (1,2 for disc 1 and 1,2 for disc 2)
    mockReadChapterSources.mockResolvedValue([
      { filePath: join('/lib/book', '001.mp3'), trackNumber: 1, discNumber: 1, title: 'D1T1' },
      { filePath: join('/lib/book', '002.mp3'), trackNumber: 2, discNumber: 1, title: 'D1T2' },
      { filePath: join('/lib/book', '003.mp3'), trackNumber: 1, discNumber: 2, title: 'D2T1' },
      { filePath: join('/lib/book', '004.mp3'), trackNumber: 2, discNumber: 2, title: 'D2T2' },
    ]);
    mockResolveChapterTitle
      .mockReturnValueOnce('D1T1')
      .mockReturnValueOnce('D1T2')
      .mockReturnValueOnce('D2T1')
      .mockReturnValueOnce('D2T2');

    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      process.nextTick(() => child.emit('close', 0));
      return child as never;
    });

    const ctx: ProcessingContext = {
      author: 'Author',
      title: 'Book',
      fileFormat: '{trackNumber:00} - {partName}',
    };
    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'never' };
    const result = await processAudioFiles('/lib/book', config, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      // Positional: 1,2,3,4 — NOT metadata's 1,2,1,2
      expect(result.outputFiles).toEqual([
        join('/lib/book', '01 - D1T1.m4b'),
        join('/lib/book', '02 - D1T2.m4b'),
        join('/lib/book', '03 - D2T1.m4b'),
        join('/lib/book', '04 - D2T2.m4b'),
      ]);
    }
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

// ============================================================================
// #424 — M4B merge: embedded cover art muxer overflow fix
// ============================================================================

describe('#424 stream mapping — unconditional -vn flag', () => {
  it('mergeFiles includes -vn flag in ffmpeg args', async () => {
    setupMergeFiles([120, 120]);
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('-vn');
  });

  it('convertFiles includes -vn flag in ffmpeg args', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('-vn');
  });

  it('-vn is present even when source files have no embedded cover art', async () => {
    // Default setup has no cover art detection — -vn should still be there
    setupConvertFile();
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('-vn');
  });
});

describe('#424 convertFiles — progress output', () => {
  it('convertFiles includes -progress pipe:1 in ffmpeg args', async () => {
    setupConvertFile();
    mockSpawnSuccess();

    await processAudioFiles('/lib/book', defaultConfig, defaultContext);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('-progress');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnArgs[idx + 1]).toBe('pipe:1');
  });

  it('convert-path stall timeout kills process after 60s with no progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setupConvertFile();
    const child = new MockChildProcess();
    child.kill = vi.fn().mockImplementation(() => {
      process.nextTick(() => child.emit('close', null));
    });
    mockSpawn.mockReturnValue(child as never);

    const promise = processAudioFiles('/lib/book', defaultConfig, defaultContext);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    vi.advanceTimersByTime(61_000);

    const result = await promise;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('ffmpeg stalled');
    }
    vi.useRealTimers();
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
    setupConvertFile();
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
    setupConvertFile();
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
    setupConvertFile();
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
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (typeof cb !== 'function') return {} as never;

    const execArgs = args[1] as string[];
    // Detect if this is a stream-detection ffprobe call (has -show_entries stream=codec_type)
    if (execArgs?.includes('stream=codec_type')) {
      const filePath = execArgs[execArgs.length - 1];
      const videoCount = fileStreamMap[filePath] ?? 0;
      const lines = ['audio'];
      for (let i = 0; i < videoCount; i++) lines.push('video');
      cb(null, { stdout: lines.join('\n') + '\n', stderr: '' });
    } else if (execArgs?.includes('format=duration')) {
      // Duration probe
      cb(null, { stdout: '120\n', stderr: '' });
    } else {
      // Default (version probe etc.)
      cb(null, { stdout: 'ffmpeg version 6.1.1\n', stderr: '' });
    }
    return {} as never;
  });
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
    );
    expect(result.success).toBe(true);
    // 3 spawn calls: extract + encode + reattach
    expect(spawnCallCount).toBe(3);

    // First spawn call should be cover extraction
    const extractArgs = mockSpawn.mock.calls[0][1] as string[];
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
    );
    expect(result.success).toBe(true);

    // First spawn call = extraction, should reference second file
    const extractArgs = mockSpawn.mock.calls[0][1] as string[];
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
    );

    const extractArgs = mockSpawn.mock.calls[0][1] as string[];
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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

    // No callbacks — simulates import/bulk-convert callers
    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
    );

    // Third spawn call = reattach
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    const reattachArgs = mockSpawn.mock.calls[2][1] as string[];
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
    );

    const reattachArgs = mockSpawn.mock.calls[2][1] as string[];
    const cIdx = reattachArgs.indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    expect(reattachArgs[cIdx + 1]).toBe('copy');
  });

  it('no cover reattach for MP3 output format', async () => {
    setupConvertFile();
    mockExecFileWithStreams({
      [join('/lib/book', 'book.mp3')]: 1,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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

    // No callbacks — simulates import/bulk-convert callers
    const result = await processAudioFiles(
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
      '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
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
        '/lib/book', { ...defaultConfig, mergeBehavior: 'always' }, defaultContext,
        undefined, controller.signal,
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain('aborted');
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
