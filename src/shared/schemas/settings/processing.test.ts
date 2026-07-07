import { describe, it, expect } from 'vitest';
import { processingSettingsSchema } from './processing.js';

describe('processingSettingsSchema — autoMergeDownloads (#1836)', () => {
  it('defaults autoMergeDownloads to false when absent from an older payload', () => {
    // Older stored settings predate the toggle — the field is missing entirely.
    const result = processingSettingsSchema.parse({
      ffmpegPath: '/usr/bin/ffmpeg',
      outputFormat: 'm4b',
      keepOriginalBitrate: true,
      bitrate: 128,
      mergeBehavior: 'multi-file-only',
      maxConcurrentProcessing: 1,
      postProcessingScript: '',
      postProcessingScriptTimeout: 300,
    });
    expect(result.autoMergeDownloads).toBe(false);
  });

  it('defaults autoMergeDownloads to false on a fully-empty payload', () => {
    expect(processingSettingsSchema.parse({}).autoMergeDownloads).toBe(false);
  });

  it('round-trips an explicit true', () => {
    const result = processingSettingsSchema.parse({ autoMergeDownloads: true });
    expect(result.autoMergeDownloads).toBe(true);
  });

  it('round-trips an explicit false', () => {
    const result = processingSettingsSchema.parse({ autoMergeDownloads: false });
    expect(result.autoMergeDownloads).toBe(false);
  });

  it('rejects a non-boolean autoMergeDownloads', () => {
    const result = processingSettingsSchema.safeParse({ autoMergeDownloads: 'yes' });
    expect(result.success).toBe(false);
  });
});
