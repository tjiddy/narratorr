import { describe, it } from 'vitest';

describe('buildQualityAssessment — existing audio metadata fields', () => {
  it.todo('includes existing codec from book.audioCodec when book has audio metadata');
  it.todo('includes existing channels from book.audioChannels when book has audio metadata');
  it.todo('includes existing duration via resolveBookQualityInputs() when book has audioDuration');
  it.todo('includes downloadedDuration from scanResult.totalDuration');
  it.todo('returns null existingCodec when book.audioCodec is null');
  it.todo('returns null existingChannels when book.audioChannels is null');
  it.todo('returns null existing values when book has no audio metadata');
  it.todo('returns null existing values for first import (book.path === null)');
  it.todo('returns null existing values when book is null');
  it.todo('uses resolveBookQualityInputs fallback: audioDuration if present, else duration * 60');
  it.todo('returns null existingDuration for pathless books');
  it.todo('returns null downloadedDuration when scanResult.totalDuration is 0');
  it.todo('resolves existingChannels 0 to null (invalid channel count)');
});
