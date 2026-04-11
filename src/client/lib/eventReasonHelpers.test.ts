import { describe, it, expect } from 'vitest';
import { hasReasonContent, getEventSummary, capitalize } from './eventReasonHelpers';

describe('capitalize', () => {
  it('capitalizes the first character', () => {
    expect(capitalize('torrent')).toBe('Torrent');
  });

  it('preserves already-capitalized strings', () => {
    expect(capitalize('Usenet')).toBe('Usenet');
  });

  it('handles single character', () => {
    expect(capitalize('a')).toBe('A');
  });

  it('handles empty string without error', () => {
    expect(capitalize('')).toBe('');
  });
});

describe('hasReasonContent', () => {
  it('returns false for null reason', () => {
    expect(hasReasonContent(null)).toBe(false);
  });

  it('returns false for empty object {}', () => {
    expect(hasReasonContent({})).toBe(false);
  });

  it('returns true for object with fields', () => {
    expect(hasReasonContent({ error: 'something' })).toBe(true);
  });

  // #464 — false positive on null values
  it('returns false when all values are null', () => {
    expect(hasReasonContent({ error: null })).toBe(false);
  });

  it('returns false when values are mixed null/undefined', () => {
    expect(hasReasonContent({ error: null, code: undefined })).toBe(false);
  });

  it('returns true when at least one value is non-null among nulls', () => {
    expect(hasReasonContent({ error: null, code: 42 })).toBe(true);
  });

  it('returns true for non-null string value', () => {
    expect(hasReasonContent({ protocol: 'torrent' })).toBe(true);
  });
});

describe('getEventSummary', () => {
  const indexerMap = new Map<number, string>([[3, 'DrunkenSlug']]);

  it('grabbed — returns indexer name, protocol, and formatted size', () => {
    const result = getEventSummary('grabbed', { indexerId: 3, size: 500000000, protocol: 'torrent' }, indexerMap);
    expect(result).toContain('DrunkenSlug');
    expect(result).toContain('Torrent');
    expect(result).toContain('476.84 MB');
  });

  it('grabbed — falls back to raw indexer ID when name not in lookup map', () => {
    const result = getEventSummary('grabbed', { indexerId: 99, size: 1000, protocol: 'usenet' }, indexerMap);
    expect(result).toContain('99');
    expect(result).toContain('Usenet');
  });

  it('grabbed — formats size: 0 as "0 B"', () => {
    const result = getEventSummary('grabbed', { indexerId: 3, size: 0, protocol: 'torrent' }, indexerMap);
    expect(result).toContain('0 B');
  });

  it('grabbed — returns null when reason is null', () => {
    expect(getEventSummary('grabbed', null, indexerMap)).toBeNull();
  });

  it('returns null for event types without summary', () => {
    expect(getEventSummary('imported', { targetPath: '/foo' }, indexerMap)).toBeNull();
    expect(getEventSummary('held_for_review', { holdReasons: [] }, indexerMap)).toBeNull();
    expect(getEventSummary('download_completed', { progress: 1 }, indexerMap)).toBeNull();
  });
});
