import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { AUDIO_EXTENSIONS } from './audio-constants.js';
import { collectAudioFilePaths } from './collect-audio-files.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { readdir } = await import('node:fs/promises');
const mockReaddir = vi.mocked(readdir);

function makeDirent(name: string, isFile: boolean, isDirectory: boolean) {
  return { name, isFile: () => isFile, isDirectory: () => isDirectory } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('collectAudioFilePaths', () => {
  describe('core behavior', () => {
    it('returns audio file paths for a flat directory with mixed file types', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track1.mp3', true, false),
        makeDirent('readme.txt', true, false),
        makeDirent('track2.m4b', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/books/mybook');

      expect(result).toEqual(expect.arrayContaining([
        join('/books/mybook', 'track1.mp3'),
        join('/books/mybook', 'track2.m4b'),
      ]));
      expect(result).toHaveLength(2);
    });

    it('filters by default AUDIO_EXTENSIONS when no extensions option provided', async () => {
      const audioEntries = [...AUDIO_EXTENSIONS].map(ext =>
        makeDirent(`file${ext}`, true, false),
      );
      mockReaddir.mockResolvedValueOnce(audioEntries as never);

      const result = await collectAudioFilePaths('/dir');

      expect(result).toHaveLength(AUDIO_EXTENSIONS.size);
    });

    it('filters by custom extension set when provided', async () => {
      const customExtensions = new Set(['.mp3', '.m4a']);
      mockReaddir.mockResolvedValueOnce([
        makeDirent('a.mp3', true, false),
        makeDirent('b.flac', true, false),
        makeDirent('c.m4a', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/dir', { extensions: customExtensions });

      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([
        join('/dir', 'a.mp3'),
        join('/dir', 'c.m4a'),
      ]));
    });

    it('returns empty array for empty directory', async () => {
      mockReaddir.mockResolvedValueOnce([] as never);

      const result = await collectAudioFilePaths('/empty');

      expect(result).toEqual([]);
    });

    it('returns empty array for directory with no matching audio files', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('readme.md', true, false),
        makeDirent('cover.jpg', true, false),
      ] as never);

      const result = await collectAudioFilePaths('/noaudio');

      expect(result).toEqual([]);
    });
  });

  describe('recursive mode', () => {
    it('descends into subdirectories and returns nested audio file paths', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('track1.mp3', true, false),
          makeDirent('disc1', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track2.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/books/mybook', { recursive: true });

      expect(result).toEqual(expect.arrayContaining([
        join('/books/mybook', 'track1.mp3'),
        join('/books/mybook', 'disc1', 'track2.mp3'),
      ]));
      expect(result).toHaveLength(2);
    });

    it('returns files from all levels of nesting', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('level1', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('level2', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('deep.flac', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/root', { recursive: true });

      expect(result).toEqual([join('/root', 'level1', 'level2', 'deep.flac')]);
    });
  });

  describe('hidden directory skipping', () => {
    it('skips entries starting with . when skipHidden is true', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('.hidden', false, true),
          makeDirent('visible', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/dir', { recursive: true, skipHidden: true });

      expect(result).toEqual([join('/dir', 'visible', 'track.mp3')]);
      expect(mockReaddir).toHaveBeenCalledTimes(2); // root + visible only
    });

    it('includes hidden entries when skipHidden is false (default)', async () => {
      mockReaddir
        .mockResolvedValueOnce([
          makeDirent('.hidden', false, true),
        ] as never)
        .mockResolvedValueOnce([
          makeDirent('track.mp3', true, false),
        ] as never);

      const result = await collectAudioFilePaths('/dir', { recursive: true });

      expect(result).toEqual([join('/dir', '.hidden', 'track.mp3')]);
    });
  });

  describe('non-recursive mode (default)', () => {
    it('returns only direct children, ignoring subdirectories', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('track.mp3', true, false),
        makeDirent('subdir', false, true),
      ] as never);

      const result = await collectAudioFilePaths('/dir');

      expect(result).toEqual([join('/dir', 'track.mp3')]);
      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });
  });
});
