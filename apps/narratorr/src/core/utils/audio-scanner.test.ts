import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanAudioDirectory } from './audio-scanner.js';

// Mock music-metadata
vi.mock('music-metadata', () => ({
  parseFile: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { parseFile } from 'music-metadata';
import { readdir, stat } from 'node:fs/promises';

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockParseFile = vi.mocked(parseFile);

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
    mockStat.mockResolvedValue({ size: 50_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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

    mockStat.mockResolvedValue({ size: 100_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 500_000_000 } as never);

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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 1000 } as never);
    mockParseFile.mockRejectedValue(new Error('Cannot parse'));

    const result = await scanAudioDirectory('/audiobooks/test');
    expect(result).toBeNull();
  });

  it('extracts narrator from native narrator tag (Audible M4B)', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('book.m4b', true),
    ] as never);
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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

  it('handles missing optional tags', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('track.mp3', true),
    ] as never);
    mockStat.mockResolvedValue({ size: 10_000_000 } as never);
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
});
