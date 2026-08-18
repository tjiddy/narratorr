import type { Mock } from 'vitest';
import { readdir, mkdir, cp, unlink, stat, rm, rename } from 'node:fs/promises';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudioWithinAdmissionLock } from '../enrichment-utils.js';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';

// Importing tests must declare their own `vi.mock` blocks; Vitest hoists mocks per file.

export const BOOK_PATH = '/library/Author/Title';
// Hidden staging prevents library scans from observing an incomplete merge.
export const STAGING_DIR = dotPrefixBasename(BOOK_PATH + '.merge-tmp');

export const mockAuthor = createMockDbAuthor();
export const mockBook = {
  ...createMockDbBook({
    id: 42,
    title: 'The Way of Kings',
    path: BOOK_PATH,
    status: 'imported',
  }),
  authors: [mockAuthor],
  narrators: [],
};

export const processingOverrides = {
  processing: {
    ffmpegPath: '/usr/bin/ffmpeg',
    outputFormat: 'm4b' as const,
    bitrate: 128,
    keepOriginalBitrate: false,
    maxConcurrentProcessing: 1,
    postProcessingScript: '',
    postProcessingScriptTimeout: 300,
  },
};

export const SCAN_RESULT = {
  codec: 'aac',
  bitrate: 128000,
  sampleRate: 44100,
  channels: 2,
  bitrateMode: 'cbr' as const,
  fileFormat: 'm4b',
  fileCount: 1,
  totalSize: 500_000_000,
  totalDuration: 36000,
  hasCoverArt: false,
};

export const settle = () => new Promise((r) => setTimeout(r, 50));

export function setupHappyPath() {
  (readdir as Mock).mockImplementation(async (dir: string) => {
    if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
    return ['01.mp3', '02.mp3', 'cover.jpg'];
  });
  (mkdir as Mock).mockResolvedValue(undefined);
  (cp as Mock).mockResolvedValue(undefined);
  (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
  (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
  (rename as Mock).mockResolvedValue(undefined);
  (unlink as Mock).mockResolvedValue(undefined);
  (rm as Mock).mockResolvedValue(undefined);
  (stat as Mock).mockResolvedValue({ size: 500_000_000 });
  (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
}

export function setupBlockingMerge() {
  (readdir as Mock).mockImplementation(async (dir: string) => (dir.endsWith('.merge-tmp') ? ['out.m4b'] : ['01.mp3', '02.mp3']));
  (mkdir as Mock).mockResolvedValue(undefined);
  (cp as Mock).mockResolvedValue(undefined);
  (rm as Mock).mockResolvedValue(undefined);
  (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
  (rename as Mock).mockResolvedValue(undefined);
  (unlink as Mock).mockResolvedValue(undefined);
  (stat as Mock).mockResolvedValue({ size: 100 });
  (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  (processAudioFiles as Mock).mockImplementation(async () => {
    await blocked;
    return { success: true, outputFiles: ['/staging/out.m4b'] };
  });
  return { release };
}
