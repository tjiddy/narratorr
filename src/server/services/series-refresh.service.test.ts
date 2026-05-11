import { describe, it, expect } from 'vitest';
import { computeQueueIdentity, normalizeSeriesName } from './series-refresh.service.js';

describe('computeQueueIdentity', () => {
  it('uses series.id when present', () => {
    expect(computeQueueIdentity({ seriesId: 42 })).toBe('series:42');
  });

  it('falls through to provider+providerSeriesId when series.id is absent', () => {
    expect(computeQueueIdentity({ provider: 'audible', providerSeriesId: 'B07DHQY7DX' }))
      .toBe('audible:B07DHQY7DX');
  });

  it('defaults provider to "audible" when omitted', () => {
    expect(computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX' }))
      .toBe('audible:B07DHQY7DX');
  });

  it('falls through to provider:normalizedName:seedAsin when no providerSeriesId', () => {
    expect(computeQueueIdentity({
      provider: 'audible',
      normalizedName: 'the band',
      seedAsin: 'B01NA0JA51',
    })).toBe('audible:the band:B01NA0JA51');
  });

  it('returns null when no identity can be computed', () => {
    expect(computeQueueIdentity({})).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible' })).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible', normalizedName: 'foo' })).toBeNull();
    expect(computeQueueIdentity({ provider: 'audible', seedAsin: 'X' })).toBeNull();
  });

  it('collapses two triggers for the same (provider, providerSeriesId)', () => {
    const a = computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX' });
    const b = computeQueueIdentity({ providerSeriesId: 'B07DHQY7DX', normalizedName: 'whatever' });
    expect(a).toBe(b);
  });

  it('does NOT collapse two null-providerSeriesId series with different seed ASINs', () => {
    const a = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    const b = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A2' });
    expect(a).not.toBe(b);
  });

  it('collapses two triggers for the same null-providerSeriesId series with the same seed ASIN', () => {
    const a = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    const b = computeQueueIdentity({ normalizedName: 'foo', seedAsin: 'A1' });
    expect(a).toBe(b);
  });
});

describe('normalizeSeriesName', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeSeriesName('The Band')).toBe('the band');
    expect(normalizeSeriesName('Wax & Wayne')).toBe('wax wayne');
    expect(normalizeSeriesName('Mistborn: Era 2')).toBe('mistborn era 2');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(normalizeSeriesName('A — B   C')).toBe('a b c');
  });
});
