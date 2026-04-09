import { describe, it, expect } from 'vitest';
import { hasReasonContent, getEventSummary } from './eventReasonFormatters';

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
