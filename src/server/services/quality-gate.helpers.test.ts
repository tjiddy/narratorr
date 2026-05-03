import { describe, it, expect, vi } from 'vitest';
import { buildQualityAssessment } from './quality-gate.helpers.js';
import * as qualityModule from '../../core/utils/quality.js';

const baseBook = {
  id: 1, title: 'Test Book', status: 'imported' as const,
  narrators: [{ name: 'John Smith' }], size: 400_000_000, duration: 600,
  audioTotalSize: null, audioDuration: 36000, path: '/library/test',
  asin: null, isbn: null, coverUrl: null, description: null,
  publishedDate: null, publisher: null, language: null,
  seriesName: null, seriesPosition: null, genres: null, tags: null,
  rating: null, ratingCount: null, pageCount: null,
  audioBitrate: null, audioCodec: 'AAC', audioSampleRate: null,
  audioChannels: 2, updatedAt: new Date(), addedAt: new Date(),
  monitorForUpgrades: false, createdAt: new Date(), enrichmentStatus: 'pending' as const,
  audioBitrateMode: null, audioFileFormat: null, audioFileCount: null, topLevelAudioFileCount: null,
  audibleId: null, goodreadsId: null, seriesId: null, importListId: null,
  lastGrabGuid: null, lastGrabInfoHash: null,
};

const baseScan = {
  totalSize: 600_000_000,
  totalDuration: 36000,
  codec: 'MP3',
  channels: 2,
};

describe('buildQualityAssessment — existing audio metadata fields', () => {
  it('includes existing codec from book.audioCodec when book has audio metadata', () => {
    const result = buildQualityAssessment(baseScan, baseBook);
    expect(result.existingCodec).toBe('AAC');
  });

  it('includes existing channels from book.audioChannels when book has audio metadata', () => {
    const result = buildQualityAssessment(baseScan, baseBook);
    expect(result.existingChannels).toBe(2);
  });

  it('includes existing duration via resolveBookQualityInputs() when book has audioDuration', () => {
    const result = buildQualityAssessment(baseScan, baseBook);
    expect(result.existingDuration).toBe(36000);
  });

  it('includes downloadedDuration from scanResult.totalDuration', () => {
    const result = buildQualityAssessment(baseScan, baseBook);
    expect(result.downloadedDuration).toBe(36000);
  });

  it('returns null existingCodec when book.audioCodec is null', () => {
    const book = { ...baseBook, audioCodec: null };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingCodec).toBeNull();
  });

  it('returns null existingChannels when book.audioChannels is null', () => {
    const book = { ...baseBook, audioChannels: null };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingChannels).toBeNull();
  });

  it('returns null existing values when book has no audio metadata', () => {
    const book = { ...baseBook, audioCodec: null, audioChannels: null, audioDuration: null, duration: null };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingCodec).toBeNull();
    expect(result.existingChannels).toBeNull();
    expect(result.existingDuration).toBeNull();
  });

  it('returns null existing values for first import (book.path === null)', () => {
    const book = { ...baseBook, path: null };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingCodec).toBeNull();
    expect(result.existingChannels).toBeNull();
    expect(result.existingDuration).toBeNull();
  });

  it('returns null existing values when book is null', () => {
    const result = buildQualityAssessment(baseScan, null);
    expect(result.existingCodec).toBeNull();
    expect(result.existingChannels).toBeNull();
    expect(result.existingDuration).toBeNull();
  });

  it('uses resolveBookQualityInputs fallback: audioDuration if present, else duration * 60', () => {
    const book = { ...baseBook, audioDuration: null, duration: 120 };
    const result = buildQualityAssessment(baseScan, book);
    // duration * 60 = 120 * 60 = 7200
    expect(result.existingDuration).toBe(7200);
  });

  it('returns null existingDuration for pathless books', () => {
    const book = { ...baseBook, path: null, audioDuration: 36000 };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingDuration).toBeNull();
  });

  it('returns null downloadedDuration when scanResult.totalDuration is 0', () => {
    const scan = { ...baseScan, totalDuration: 0 };
    const result = buildQualityAssessment(scan, baseBook);
    expect(result.downloadedDuration).toBeNull();
  });

  it('resolves existingChannels 0 to null (invalid channel count)', () => {
    const book = { ...baseBook, audioChannels: 0 };
    const result = buildQualityAssessment(baseScan, book);
    expect(result.existingChannels).toBeNull();
  });
});

describe('buildQualityAssessment — resolveBookQualityInputs caching', () => {
  it('calls resolveBookQualityInputs exactly once when book has path (upgrade scenario)', () => {
    const spy = vi.spyOn(qualityModule, 'resolveBookQualityInputs');
    try {
      buildQualityAssessment(baseScan, baseBook);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(baseBook);
    } finally {
      spy.mockRestore();
    }
  });

  it('still produces correct results when book.path is null (no existing file)', () => {
    const book = { ...baseBook, path: null };
    const spy = vi.spyOn(qualityModule, 'resolveBookQualityInputs');
    try {
      const result = buildQualityAssessment(baseScan, book);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.existingCodec).toBeNull();
      expect(result.existingChannels).toBeNull();
      expect(result.durationDelta).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
