import { describe, it, expect } from 'vitest';
import { folderFormatSchema, fileFormatSchema, updateSettingsSchema } from './settings.js';

describe('folderFormatSchema', () => {
  it('accepts format with {title}', () => {
    const result = folderFormatSchema.safeParse('{author}/{title}');
    expect(result.success).toBe(true);
  });

  it('accepts format with {titleSort}', () => {
    const result = folderFormatSchema.safeParse('{author}/{titleSort}');
    expect(result.success).toBe(true);
  });

  it('accepts format with truncation modifier', () => {
    const result = folderFormatSchema.safeParse('{author}/{title:50}');
    expect(result.success).toBe(true);
  });

  it('accepts format with conditional modifier', () => {
    const result = folderFormatSchema.safeParse('{author}/{title}/{series?}');
    expect(result.success).toBe(true);
  });

  it('rejects format without {title} or {titleSort}', () => {
    const result = folderFormatSchema.safeParse('{author}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must include {title}');
    }
  });

  it('rejects unknown token', () => {
    const result = folderFormatSchema.safeParse('{author}/{title}/{unknown}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Unknown token');
    }
  });

  it('accepts all valid folder tokens', () => {
    const result = folderFormatSchema.safeParse('{author}/{title}/{series}/{seriesPosition}/{year}/{narrator}');
    expect(result.success).toBe(true);
  });

  it('uses default value when empty input is provided via schema chain', () => {
    // Direct default behavior: when used in a z.object and not provided
    const result = folderFormatSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('{author}/{title}');
  });
});

describe('fileFormatSchema', () => {
  it('accepts format with {title}', () => {
    const result = fileFormatSchema.safeParse('{author} - {title}');
    expect(result.success).toBe(true);
  });

  it('accepts file-specific tokens like {trackNumber}', () => {
    const result = fileFormatSchema.safeParse('{trackNumber} - {title}');
    expect(result.success).toBe(true);
  });

  it('accepts {partName} token', () => {
    const result = fileFormatSchema.safeParse('{title} - {partName}');
    expect(result.success).toBe(true);
  });

  it('rejects format without {title}', () => {
    const result = fileFormatSchema.safeParse('{author} - {trackNumber}');
    expect(result.success).toBe(false);
  });

  it('rejects unknown token', () => {
    const result = fileFormatSchema.safeParse('{title} - {bogus}');
    expect(result.success).toBe(false);
  });
});

describe('updateSettingsSchema', () => {
  describe('superRefine — ffmpeg validation', () => {
    it('rejects processing enabled with empty ffmpegPath', () => {
      const result = updateSettingsSchema.safeParse({
        processing: { enabled: true, ffmpegPath: '' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['processing', 'ffmpegPath'],
            message: 'ffmpeg path is required when processing is enabled',
          }),
        );
      }
    });

    it('rejects processing enabled with whitespace-only ffmpegPath', () => {
      const result = updateSettingsSchema.safeParse({
        processing: { enabled: true, ffmpegPath: '   ' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts processing enabled with valid ffmpegPath', () => {
      const result = updateSettingsSchema.safeParse({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts processing disabled with empty ffmpegPath', () => {
      const result = updateSettingsSchema.safeParse({
        processing: { enabled: false, ffmpegPath: '' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty update (no processing section)', () => {
      const result = updateSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
