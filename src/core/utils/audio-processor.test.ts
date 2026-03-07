import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  probeFfmpeg,
  processAudioFiles,
  buildChapterMetadata,
  type ProcessingConfig,
  type ProcessingContext,
} from './audio-processor.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
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

import { execFile } from 'node:child_process';
import { readdir, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { readChapterSources, resolveChapterTitle } from './chapter-resolver.js';

// execFile is callback-based; mock the promisified version
const mockExecFile = vi.mocked(execFile);

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

describe('processAudioFiles', () => {
  it('skips processing for single m4b input', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.m4b', isFile: () => true, isDirectory: () => false },
    ] as never);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result).toEqual({ success: true, outputFiles: [join('/lib/book', 'book.m4b')] });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns empty output for directory with no audio files', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
    ] as never);

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result).toEqual({ success: true, outputFiles: [] });
  });

  it('merges N files into single m4b with chapter metadata', async () => {
    mockReaddir.mockResolvedValue([
      { name: '01.mp3', isFile: () => true, isDirectory: () => false },
      { name: '02.mp3', isFile: () => true, isDirectory: () => false },
      { name: '03.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockReadChapterSources.mockResolvedValue([
      { filePath: '/lib/book/01.mp3', title: 'Ch 1', trackNumber: 1 },
      { filePath: '/lib/book/02.mp3', title: 'Ch 2', trackNumber: 2 },
      { filePath: '/lib/book/03.mp3', title: 'Ch 3', trackNumber: 3 },
    ]);

    mockResolveChapterTitle.mockImplementation((_s, i) => `Chapter ${i + 1}`);

    // First 3 calls are ffprobe for durations, then 1 ffmpeg merge call
    let callCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
      if (typeof cb === 'function') {
        callCount++;
        if (callCount <= 3) {
          cb(null, { stdout: '300.0\n', stderr: '' }); // 300s per file
        } else {
          cb(null, { stdout: '', stderr: '' }); // merge
        }
      }
      return {} as never;
    });

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'Brandon Sanderson - The Way of Kings.m4b')]);
    }

    // Should have written concat file and metadata file
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });

  it('converts single file format/bitrate without merge', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockExecFileSuccess('');

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'book.m4b')]);
    }
    // Should remove original after conversion
    expect(mockUnlink).toHaveBeenCalledWith(join('/lib/book', 'book.mp3'));
  });

  it('skips merge for single file when mergeBehavior is multi-file-only', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockExecFileSuccess('');

    const config: ProcessingConfig = { ...defaultConfig, mergeBehavior: 'multi-file-only' };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);
    // Should convert, not merge (no concat file written)
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('re-encodes single file when extension matches but bitrate differs', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockExecFileSuccess('');

    const config: ProcessingConfig = { ...defaultConfig, outputFormat: 'mp3', bitrate: 64 };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputFiles).toEqual([join('/lib/book', 'book.mp3')]);
    }
    // Should encode to temp file, delete original, then rename
    expect(mockExecFile).toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(join('/lib/book', 'book.mp3'));
    expect(mockRename).toHaveBeenCalledWith(
      join('/lib/book', 'book_tmp.mp3'),
      join('/lib/book', 'book.mp3'),
    );
  });

  it('omits -b:a flag when bitrate is undefined (keep original)', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockExecFileSuccess('');

    const config: ProcessingConfig = { ...defaultConfig, bitrate: undefined };
    const result = await processAudioFiles('/lib/book', config, defaultContext);
    expect(result.success).toBe(true);

    // ffmpeg should be called without -b:a
    const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(ffmpegArgs).not.toContain('-b:a');
    expect(ffmpegArgs).toContain('-c:a');
  });

  it('returns error result on non-zero ffmpeg exit', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'book.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockExecFileFailure('ffmpeg exited with code 1', 'Conversion failed: invalid input');

    const result = await processAudioFiles('/lib/book', defaultConfig, defaultContext);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('ffmpeg exited with code 1');
      expect(result.error).toContain('Conversion failed: invalid input');
    }
  });

  it('uses fileFormat template for merged output filename', async () => {
    mockReaddir.mockResolvedValue([
      { name: '01.mp3', isFile: () => true, isDirectory: () => false },
      { name: '02.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockReadChapterSources.mockResolvedValue([
      { filePath: '/lib/book/01.mp3', trackNumber: 1 },
      { filePath: '/lib/book/02.mp3', trackNumber: 2 },
    ]);
    mockResolveChapterTitle.mockImplementation((_s, i) => `Ch ${i + 1}`);

    let callCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
      if (typeof cb === 'function') {
        callCount++;
        cb(null, { stdout: callCount <= 2 ? '120.0\n' : '', stderr: '' });
      }
      return {} as never;
    });

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

    mockExecFileSuccess('');

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
  });

  it('output file named {Author} - {Title}.m4b for merged output', async () => {
    mockReaddir.mockResolvedValue([
      { name: '01.mp3', isFile: () => true, isDirectory: () => false },
      { name: '02.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    mockReadChapterSources.mockResolvedValue([
      { filePath: '/lib/book/01.mp3', trackNumber: 1 },
      { filePath: '/lib/book/02.mp3', trackNumber: 2 },
    ]);
    mockResolveChapterTitle.mockImplementation((_s, i) => `Ch ${i + 1}`);

    let callCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
      if (typeof cb === 'function') {
        callCount++;
        cb(null, { stdout: callCount <= 2 ? '120.0\n' : '', stderr: '' });
      }
      return {} as never;
    });

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
