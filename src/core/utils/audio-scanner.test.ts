import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanAudioDirectory, getFFprobeDuration } from './audio-scanner.js';

// Mock music-metadata
vi.mock('music-metadata', () => ({
  parseFile: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { parseFile } from 'music-metadata';
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockParseFile = vi.mocked(parseFile);
const mockExecFile = vi.mocked(execFile);

function makeDirent(name: string, isFile: boolean) {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '/audiobooks/test',
    parentPath: '/audiobooks/test',
  };
}

function makeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    format: {
      codec: 'MPEG 1 Layer 3',
      bitrate: 128000,
      sampleRate: 44100,
      numberOfChannels: 2,
      duration: 3600,
      container: 'MPEG',
      codecProfile: 'CBR',
      ...((overrides.format as Record<string, unknown>) ?? {}),
    },
    common: {
      title: 'Test Book',
      artist: 'Test Author',
      albumartist: 'Test Author',
      composer: ['Test Narrator'],
      grouping: 'Test Series',
      year: 2020,
      label: ['Test Publisher'],
      track: { no: 1, of: 10 },
      picture: undefined,
      comment: undefined,
      ...((overrides.common as Record<string, unknown>) ?? {}),
    },
    native: {},
    ...overrides,
  };
}

describe('scanAudioDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for empty directory', async () => {
    mockReaddir.mockResolvedValue([] as never);
    const result = await scanAudioDirectory('/audiobooks/empty');
    expect(result).toBeNull();
  });

  it('returns null for directory with no audio files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('readme.txt', true),
      makeDirent('cover.jpg', true),
    ] as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result).toBeNull();
  });

  it('extracts technical info from audio files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('chapter1.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 50_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata() as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result).not.toBeNull();
    expect(result!.codec).toBe('MPEG 1 Layer 3');
    expect(result!.bitrate).toBe(128000);
    expect(result!.sampleRate).toBe(44100);
    expect(result!.channels).toBe(2);
    expect(result!.fileFormat).toBe('mp3');
    expect(result!.fileCount).toBe(1);
    expect(result!.totalSize).toBe(50_000_000);
    expect(result!.totalDuration).toBe(3600);
  });

  it('extracts tag metadata', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('chapter1.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata() as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result!.tagTitle).toBe('Test Book');
    expect(result!.tagAuthor).toBe('Test Author');
    expect(result!.tagNarrator).toBe('Test Narrator');
    expect(result!.tagSeries).toBe('Test Series');
    expect(result!.tagYear).toBe('2020');
    expect(result!.tagPublisher).toBe('Test Publisher');
  });

  it('aggregates duration across multiple files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('chapter1.mp3', true),
      makeDirent('chapter2.mp3', true),
      makeDirent('chapter3.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      format: { codec: 'MPEG 1 Layer 3', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1200 },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result!.totalDuration).toBe(3600); // 3 x 1200
    expect(result!.fileCount).toBe(3);
    expect(result!.totalSize).toBe(30_000_000); // 3 x 10M
  });

  it('handles corrupt files gracefully', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('corrupt.mp3', true),
      makeDirent('good.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile
      .mockRejectedValueOnce(new Error('Invalid file'))
      .mockResolvedValueOnce(makeMetadata() as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    // Should still return results from the good file
    expect(result).not.toBeNull();
    expect(result!.codec).toBe('MPEG 1 Layer 3');
  });

  it('recurses into subdirectories', async () => {
    // Root has a subdirectory
    mockReaddir
      .mockResolvedValueOnce([
        makeDirent('disc1', false),
      ] as never)
      // Subdirectory has audio files
      .mockResolvedValueOnce([
        makeDirent('track1.m4b', true),
      ] as never);

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 100_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      format: { codec: 'AAC', bitrate: 256000, sampleRate: 44100, numberOfChannels: 2, duration: 7200, container: 'MPEG-4' },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result).not.toBeNull();
    expect(result!.codec).toBe('AAC');
    expect(result!.fileFormat).toBe('m4b');
  });

  it('extracts cover art when present', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('book.m4b', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 500_000_000 } as never);

    const coverData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Test',
        artist: 'Author',
        picture: [{ data: coverData, format: 'image/png' }],
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result!.coverImage).toBeInstanceOf(Buffer);
    expect(result!.coverMimeType).toBe('image/png');
  });

  it('detects VBR bitrate mode', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      format: {
        codec: 'MPEG 1 Layer 3',
        bitrate: 192000,
        sampleRate: 44100,
        numberOfChannels: 2,
        duration: 600,
        codecProfile: 'V0 VBR',
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.bitrateMode).toBe('vbr');
  });

  it('returns null when no files can be parsed', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('bad.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 1000 } as never);
    mockParseFile.mockRejectedValue(new Error('Cannot parse'));

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result).toBeNull();
  });

  it('extracts narrator from native narrator tag (Audible M4B)', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('book.m4b', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Test Book',
        artist: 'Test Author',
        albumartist: 'Test Author',
        composer: undefined,
      },
      native: {
        iTunes: [
          { id: '©nrt', value: 'Ray Porter' },
        ],
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.tagNarrator).toBe('Ray Porter');
  });

  it('extracts narrator from comment "read by" pattern', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Test Book',
        artist: 'Test Author',
        albumartist: 'Test Author',
        composer: undefined,
        comment: [{ text: 'Read by Steven Pacey' }],
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.tagNarrator).toBe('Steven Pacey');
  });

  it('falls back to artist when different from albumartist', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Test Book',
        artist: 'Tim Gerard Reynolds',
        albumartist: 'Michael J. Sullivan',
        composer: undefined,
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.tagNarrator).toBe('Tim Gerard Reynolds');
  });

  it('does not use artist as narrator when same as albumartist', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Test Book',
        artist: 'Same Person',
        albumartist: 'Same Person',
        composer: undefined,
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.tagNarrator).toBeUndefined();
  });

  it('extracts tags even without title (uses album fallback)', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: undefined,
        album: 'Album Title',
        artist: 'Narrator Name',
        albumartist: 'Author Name',
        composer: undefined,
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result!.tagTitle).toBe('Album Title');
    expect(result!.tagNarrator).toBe('Narrator Name');
  });

  describe('tagAuthor comma-split (#984)', () => {
    it('splits comma-separated albumartist into tagAuthor + tagAdditionalArtists', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Leviathan Wakes',
          albumartist: 'James S. A. Corey, Jefferson Mays',
          composer: undefined,
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAuthor).toBe('James S. A. Corey');
      expect(result!.tagAdditionalArtists).toBe('Jefferson Mays');
    });

    it('splits semicolon and ampersand delimiters', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Book',
          albumartist: 'Author One; Narrator A & Narrator B',
          composer: undefined,
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAuthor).toBe('Author One');
      expect(result!.tagAdditionalArtists).toBe('Narrator A, Narrator B');
    });

    it('does not set tagAdditionalArtists when only one author', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Book',
          albumartist: 'Solo Author',
          composer: undefined,
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAuthor).toBe('Solo Author');
      expect(result!.tagAdditionalArtists).toBeUndefined();
    });

    it('populates tagAdditionalArtists independently of tagNarrator (AC9)', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      // composer populates tagNarrator; albumartist comma-list still surfaces tagAdditionalArtists
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Book',
          albumartist: 'Author A, Narrator B, Narrator C',
          composer: ['Bel Powley'],
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAuthor).toBe('Author A');
      expect(result!.tagAdditionalArtists).toBe('Narrator B, Narrator C');
      expect(result!.tagNarrator).toBe('Bel Powley');
    });

    it('drops empty entries from comma-split', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Book',
          albumartist: 'Author One,, , Narrator',
          composer: undefined,
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAuthor).toBe('Author One');
      expect(result!.tagAdditionalArtists).toBe('Narrator');
    });
  });

  describe('multi-file album consistency (#984 AC8)', () => {
    function setupMultiFileScan(perFileCommon: Array<Record<string, unknown>>) {
      const dirents = perFileCommon.map((_, i) => makeDirent(`ch${i + 1}.mp3`, true));
      mockReaddir.mockResolvedValue(dirents as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);

      let call = 0;
      mockParseFile.mockImplementation(async () => {
        const common = perFileCommon[call++];
        return makeMetadata({ common }) as never;
      });
    }

    it('uses consistent non-disc album as tagTitle', async () => {
      setupMultiFileScan([
        { title: 'Chapter 1', album: 'Harry Potter', albumartist: 'J.K. Rowling', composer: undefined },
        { title: 'Chapter 2', album: 'Harry Potter', albumartist: 'J.K. Rowling', composer: undefined },
        { title: 'Chapter 3', album: 'Harry Potter', albumartist: 'J.K. Rowling', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/HP');
      expect(result!.tagTitle).toBe('Harry Potter');
      expect(result!.tagAuthor).toBe('J.K. Rowling');
    });

    it('leaves tagTitle undefined when one file has missing album (chapter common.title is NOT used)', async () => {
      setupMultiFileScan([
        { title: 'Chapter 1', album: 'Harry Potter', albumartist: 'J.K. Rowling', composer: undefined },
        { title: 'Chapter 2', album: undefined, albumartist: 'J.K. Rowling', composer: undefined },
        { title: 'Chapter 3', album: 'Harry Potter', albumartist: 'J.K. Rowling', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/HP');
      expect(result!.tagTitle).toBeUndefined();
      // tagAuthor still derived from albumartist of the first tagged file
      expect(result!.tagAuthor).toBe('J.K. Rowling');
    });

    it('leaves tagTitle undefined when files disagree on album', async () => {
      setupMultiFileScan([
        { title: 'Ch 1', album: 'Album A', albumartist: 'Author', composer: undefined },
        { title: 'Ch 2', album: 'Album A', albumartist: 'Author', composer: undefined },
        { title: 'Ch 3', album: 'Album B', albumartist: 'Author', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagTitle).toBeUndefined();
    });

    it('leaves tagTitle undefined when consistent album matches disc-pattern', async () => {
      setupMultiFileScan([
        { title: 'Track 1', album: 'Disc 1', albumartist: 'Author', composer: undefined },
        { title: 'Track 2', album: 'Disc 1', albumartist: 'Author', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagTitle).toBeUndefined();
    });

    it('leaves tagTitle undefined when consistent album matches CD-pattern (case-insensitive)', async () => {
      setupMultiFileScan([
        { title: 'Track 1', album: 'cd 02', albumartist: 'Author', composer: undefined },
        { title: 'Track 2', album: 'cd 02', albumartist: 'Author', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagTitle).toBeUndefined();
    });

    it('uses album even when every file has chapter-name common.title', async () => {
      // Album wins; common.title (chapter names) is never used as fallback for multi-file.
      setupMultiFileScan([
        { title: 'Same Chapter', album: 'The Real Book', albumartist: 'Author', composer: undefined },
        { title: 'Same Chapter', album: 'The Real Book', albumartist: 'Author', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagTitle).toBe('The Real Book');
    });
  });

  describe('tagAlbum (#1036 AC2)', () => {
    function setupMultiFileScan(perFileCommon: Array<Record<string, unknown>>) {
      const dirents = perFileCommon.map((_, i) => makeDirent(`ch${i + 1}.mp3`, true));
      mockReaddir.mockResolvedValue(dirents as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      let call = 0;
      mockParseFile.mockImplementation(async () => {
        const common = perFileCommon[call++];
        return makeMetadata({ common }) as never;
      });
    }

    it('single-file: populates tagAlbum from common.album when title differs (Dark Forest case)', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'The Dark Forest: The Three-Body Problem, Book 2',
          album: 'The Dark Forest (Unabridged)',
          albumartist: 'Cixin Liu',
          composer: undefined,
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/dark-forest');
      expect(result!.tagTitle).toBe('The Dark Forest: The Three-Body Problem, Book 2');
      expect(result!.tagAlbum).toBe('The Dark Forest (Unabridged)');
    });

    it('single-file: tagAlbum undefined when album matches disc-pattern', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: { title: 'Real Title', album: 'Disc 1', albumartist: 'Author', composer: undefined },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAlbum).toBeUndefined();
    });

    it('single-file: tagAlbum undefined when album is empty', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: { title: 'Real Title', album: '   ', albumartist: 'Author', composer: undefined },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAlbum).toBeUndefined();
    });

    it('single-file: tagAlbum undefined when album is missing', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: { title: 'Real Title', album: undefined, albumartist: 'Author', composer: undefined },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAlbum).toBeUndefined();
    });

    it('multi-file: populates tagAlbum from cross-file consensus', async () => {
      setupMultiFileScan([
        { title: 'Ch 1', album: 'Imagine Me - Shatter Me Series, Book 6', albumartist: 'Tahereh Mafi', composer: undefined },
        { title: 'Ch 2', album: 'Imagine Me - Shatter Me Series, Book 6', albumartist: 'Tahereh Mafi', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/imagine-me');
      expect(result!.tagAlbum).toBe('Imagine Me - Shatter Me Series, Book 6');
      expect(result!.tagTitle).toBe('Imagine Me - Shatter Me Series, Book 6');
    });

    it('multi-file: tagAlbum undefined when files disagree', async () => {
      setupMultiFileScan([
        { title: 'Ch 1', album: 'Album A', albumartist: 'Author', composer: undefined },
        { title: 'Ch 2', album: 'Album B', albumartist: 'Author', composer: undefined },
      ]);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAlbum).toBeUndefined();
    });
  });

  describe('tagAsin (#1036 AC3)', () => {
    it('extracts ASIN from MP4 iTunes:ASIN atom', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: { title: 'Test', albumartist: 'Author', composer: undefined },
        native: {
          iTunes: [{ id: '----:com.apple.iTunes:ASIN', value: 'B07ABCDEFG' }],
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAsin).toBe('B07ABCDEFG');
    });

    it('extracts ASIN from ID3v2 comment frame text', async () => {
      mockReaddir.mockResolvedValue([makeDirent('track.mp3', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Test',
          albumartist: 'Author',
          composer: undefined,
          comment: [{ text: 'Audible ASIN: B0XXXXXXXX. Some other text.' }],
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAsin).toBe('B0XXXXXXXX');
    });

    it('uppercase-normalizes lowercase ASIN values', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: { title: 'Test', albumartist: 'Author', composer: undefined },
        native: {
          iTunes: [{ id: 'asin', value: 'b08abcdefg' }],
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAsin).toBe('B08ABCDEFG');
    });

    it('returns undefined when no ASIN-matching content is present', async () => {
      mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
      mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata({
        common: {
          title: 'Test',
          albumartist: 'Author',
          composer: undefined,
          comment: [{ text: 'just a generic comment' }],
        },
      }) as never);

      const result = await scanAudioDirectory('/audiobooks/test');
      expect(result!.tagAsin).toBeUndefined();
    });
  });

  it('handles missing optional tags', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
    mockParseFile.mockResolvedValue(makeMetadata({
      common: {
        title: 'Only Title',
        // No artist, composer, grouping, etc.
      },
    }) as never);

    const result = await scanAudioDirectory('/audiobooks/test');

    expect(result!.tagTitle).toBe('Only Title');
    expect(result!.tagAuthor).toBeUndefined();
    expect(result!.tagNarrator).toBeUndefined();
    expect(result!.tagSeries).toBeUndefined();
  });

  describe('single-file path handling', () => {
    it('returns valid AudioScanResult when path is a single audio file', async () => {
      mockReaddir.mockRejectedValue(Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }));
      mockStat
        .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 10_000_000 } as never)
        .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata() as never);

      const result = await scanAudioDirectory('/complete/BookTitle.m4b');

      expect(result).not.toBeNull();
      expect(result!.fileCount).toBe(1);
    });

    it('returns null when path is a single non-audio file', async () => {
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 0 } as never);

      const result = await scanAudioDirectory('/complete/BookTitle.pdf');

      expect(result).toBeNull();
      expect(mockReaddir).not.toHaveBeenCalled();
    });

    it('returns valid AudioScanResult for single audio file with uppercase extension', async () => {
      mockReaddir.mockRejectedValue(Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }));
      mockStat
        .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 10_000_000 } as never)
        .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata() as never);

      const result = await scanAudioDirectory('/complete/BookTitle.M4B');

      expect(result).not.toBeNull();
      expect(result!.fileCount).toBe(1);
    });

    it('returns null gracefully when stat() throws ENOENT on the path', async () => {
      mockReaddir.mockResolvedValue([makeDirent('track.m4b', true)] as never);
      mockStat
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }))
        .mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 10_000_000 } as never);
      mockParseFile.mockResolvedValue(makeMetadata() as never);

      const result = await scanAudioDirectory('/complete/BookTitle.m4b');

      expect(result).toBeNull();
      expect(mockReaddir).not.toHaveBeenCalled();
    });
  });

  describe('ffprobe duration', () => {
    function mockExecFileSuccess(stdout: string) {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (...args: unknown[]) => void;
        callback(null, stdout, '');
        return {} as never;
      });
    }

    function mockExecFileError(error: Error) {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (...args: unknown[]) => void;
        callback(error, '', '');
        return {} as never;
      });
    }

    describe('getFFprobeDuration helper', () => {
      it('returns parsed duration when ffprobe returns valid JSON with duration string', async () => {
        mockExecFileSuccess(JSON.stringify({ format: { duration: '50177.273333' } }));
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeCloseTo(50177.273333);
      });

      it('returns null when ffprobe returns empty/malformed JSON', async () => {
        mockExecFileSuccess('not json at all');
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('returns null when ffprobe returns duration of "0"', async () => {
        mockExecFileSuccess(JSON.stringify({ format: { duration: '0' } }));
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('returns null when ffprobe returns negative duration string', async () => {
        mockExecFileSuccess(JSON.stringify({ format: { duration: '-123.456' } }));
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('returns null when ffprobe returns NaN or non-numeric string', async () => {
        mockExecFileSuccess(JSON.stringify({ format: { duration: 'N/A' } }));
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('returns null without throwing when ffprobe spawn fails (ENOENT)', async () => {
        mockExecFileError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        const result = await getFFprobeDuration('/nonexistent/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('returns null when ffprobe spawn exceeds 10 000 ms timeout', async () => {
        mockExecFileError(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
        const result = await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(result).toBeNull();
      });

      it('passes correct arguments to ffprobe', async () => {
        mockExecFileSuccess(JSON.stringify({ format: { duration: '100.0' } }));
        await getFFprobeDuration('/usr/bin/ffprobe', '/audio/book.m4b');
        expect(mockExecFile).toHaveBeenCalledWith(
          '/usr/bin/ffprobe',
          ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'json', '/audio/book.m4b'],
          expect.objectContaining({ timeout: 10_000 }),
          expect.any(Function),
        );
      });
    });

    describe('scanAudioDirectory with ffprobePath', () => {
      const FFPROBE_PATH = '/usr/bin/ffprobe';

      function setupSingleFile() {
        mockReaddir.mockResolvedValue([makeDirent('book.m4b', true)] as never);
        mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 50_000_000 } as never);
      }

      const onWarn = vi.fn();
      const onDebug = vi.fn();

      beforeEach(() => {
        onWarn.mockReset();
        onDebug.mockReset();
      });

      it('uses ffprobe duration instead of music-metadata when ffprobePath is provided', async () => {
        setupSingleFile();
        // music-metadata says 1800s (half), ffprobe says 3600s (correct)
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1800 } }) as never);
        mockExecFileSuccess(JSON.stringify({ format: { duration: '3600.0' } }));

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        expect(result!.totalDuration).toBe(3600);
      });

      it('falls back to music-metadata duration for a file when ffprobe fails', async () => {
        setupSingleFile();
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1800 } }) as never);
        mockExecFileError(new Error('ffprobe failed'));

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH, onWarn, onDebug });

        expect(result!.totalDuration).toBe(1800);
        expect(onDebug).toHaveBeenCalledWith(
          expect.stringContaining('ffprobe failed'),
          expect.objectContaining({ filePath: expect.any(String) }),
        );
      });

      it('falls back to music-metadata for ALL files when ffprobe fails on every file', async () => {
        mockReaddir.mockResolvedValue([
          makeDirent('ch1.mp3', true),
          makeDirent('ch2.mp3', true),
        ] as never);
        mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'MPEG 1 Layer 3', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 900 } }) as never);
        mockExecFileError(new Error('ffprobe failed'));

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        expect(result!.totalDuration).toBe(1800); // 2 x 900 from music-metadata
      });

      it('uses music-metadata duration when ffprobePath is not provided (backward compat)', async () => {
        setupSingleFile();
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 3600 } }) as never);

        const result = await scanAudioDirectory('/audiobooks/test');

        expect(result!.totalDuration).toBe(3600);
        expect(mockExecFile).not.toHaveBeenCalled();
      });

      it('sums ffprobe durations correctly across multiple files', async () => {
        mockReaddir.mockResolvedValue([
          makeDirent('ch1.mp3', true),
          makeDirent('ch2.mp3', true),
          makeDirent('ch3.mp3', true),
        ] as never);
        mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 10_000_000 } as never);
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'MPEG 1 Layer 3', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 500 } }) as never);

        let callCount = 0;
        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
          callCount++;
          const duration = callCount * 1000; // 1000, 2000, 3000
          (callback as (...args: unknown[]) => void)(null, JSON.stringify({ format: { duration: String(duration) } }), '');
          return {} as never;
        });

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        expect(result!.totalDuration).toBe(6000); // 1000 + 2000 + 3000
      });

      it('invokes onWarn when ffprobe and music-metadata differ by >10%', async () => {
        setupSingleFile();
        // music-metadata: 1000, ffprobe: 2000 → 100% diff, well above 10%
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1000 } }) as never);
        mockExecFileSuccess(JSON.stringify({ format: { duration: '2000.0' } }));

        await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH, onWarn, onDebug });

        expect(onWarn).toHaveBeenCalledWith(
          expect.stringContaining('duration mismatch'),
          expect.objectContaining({
            filePath: expect.any(String),
            ffprobeDuration: 2000,
            metadataDuration: 1000,
          }),
        );
      });

      it('does not invoke onWarn when ffprobe and music-metadata differ by ≤10%', async () => {
        setupSingleFile();
        // music-metadata: 1000, ffprobe: 1050 → 5% diff
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1000 } }) as never);
        mockExecFileSuccess(JSON.stringify({ format: { duration: '1050.0' } }));

        await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH, onWarn, onDebug });

        expect(onWarn).not.toHaveBeenCalled();
      });

      it('contributes 0 to totalDuration when music-metadata duration is undefined AND ffprobe fails', async () => {
        setupSingleFile();
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: undefined } }) as never);
        mockExecFileError(new Error('ffprobe failed'));

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        expect(result!.totalDuration).toBe(0);
      });

      it('does not crash when onWarn/onDebug callbacks are not provided', async () => {
        setupSingleFile();
        mockParseFile.mockResolvedValue(makeMetadata({ format: { codec: 'AAC', bitrate: 128000, sampleRate: 44100, numberOfChannels: 2, duration: 1000 } }) as never);
        mockExecFileError(new Error('ffprobe failed'));

        // Should not throw — no callbacks provided, optional-chaining preserved
        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        expect(result!.totalDuration).toBe(1000);
      });

      it('still sources all other metadata from music-metadata regardless of ffprobePath', async () => {
        setupSingleFile();
        mockParseFile.mockResolvedValue(makeMetadata() as never);
        mockExecFileSuccess(JSON.stringify({ format: { duration: '9999.0' } }));

        const result = await scanAudioDirectory('/audiobooks/test', { ffprobePath: FFPROBE_PATH });

        // Duration comes from ffprobe
        expect(result!.totalDuration).toBe(9999);
        // Everything else comes from music-metadata
        expect(result!.codec).toBe('MPEG 1 Layer 3');
        expect(result!.tagTitle).toBe('Test Book');
        expect(result!.tagNarrator).toBe('Test Narrator');
      });
    });
  });
});
