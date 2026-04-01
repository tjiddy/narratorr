import { describe, it, expect } from 'vitest';
import { eventTypeSchema, eventHistoryQuerySchema } from './event-history.js';

describe('eventHistoryQuerySchema — comma-separated eventType', () => {
  it('accepts single valid event type and returns one-element array', () => {
    const result = eventHistoryQuerySchema.parse({ eventType: 'grabbed' });
    expect(result.eventType).toEqual(['grabbed']);
  });

  it('accepts comma-separated valid event types and returns array', () => {
    const result = eventHistoryQuerySchema.parse({ eventType: 'download_failed,import_failed' });
    expect(result.eventType).toEqual(['download_failed', 'import_failed']);
  });

  it('rejects invalid event type in comma-separated list', () => {
    expect(() => eventHistoryQuerySchema.parse({ eventType: 'grabbed,invalid_type' })).toThrow();
  });

  it('rejects empty segment (grabbed,,imported)', () => {
    expect(() => eventHistoryQuerySchema.parse({ eventType: 'grabbed,,imported' })).toThrow();
  });

  it('rejects trailing comma (grabbed,)', () => {
    expect(() => eventHistoryQuerySchema.parse({ eventType: 'grabbed,' })).toThrow();
  });

  it('returns undefined when eventType omitted', () => {
    const result = eventHistoryQuerySchema.parse({});
    expect(result.eventType).toBeUndefined();
  });

  it('deduplicates repeated types (grabbed,grabbed) to single-element array', () => {
    const result = eventHistoryQuerySchema.parse({ eventType: 'grabbed,grabbed' });
    expect(result.eventType).toEqual(['grabbed']);
  });

  it('accepts all 13 event types in a single comma list', () => {
    const all = 'grabbed,download_completed,download_failed,imported,import_failed,upgraded,deleted,renamed,merged,file_tagged,held_for_review,merge_started,merge_failed';
    const result = eventHistoryQuerySchema.parse({ eventType: all });
    expect(result.eventType).toHaveLength(13);
  });
});

describe('eventTypeSchema', () => {
  it('includes merge_started and merge_failed', () => {
    expect(eventTypeSchema.parse('merge_started')).toBe('merge_started');
    expect(eventTypeSchema.parse('merge_failed')).toBe('merge_failed');
  });

  it('still includes all original 11 event types', () => {
    const originalTypes = [
      'grabbed', 'download_completed', 'download_failed',
      'imported', 'import_failed', 'upgraded',
      'deleted', 'renamed', 'merged',
      'file_tagged', 'held_for_review',
    ];
    for (const type of originalTypes) {
      expect(eventTypeSchema.parse(type)).toBe(type);
    }
  });

  it('rejects unknown event type strings', () => {
    expect(() => eventTypeSchema.parse('nonexistent_type')).toThrow();
  });
});
