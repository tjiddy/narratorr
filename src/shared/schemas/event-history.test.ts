import { describe, it, expect } from 'vitest';
import { eventTypeSchema } from './event-history.js';

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
