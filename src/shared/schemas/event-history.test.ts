import { describe, it, expect } from 'vitest';
import { eventTypeSchema, eventHistoryQuerySchema, eventSourceSchema } from './event-history.js';

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

  it('accepts book_added in comma-separated list (#341)', () => {
    const result = eventHistoryQuerySchema.parse({ eventType: 'book_added,imported' });
    expect(result.eventType).toEqual(['book_added', 'imported']);
  });

  it('deduplicates repeated types (grabbed,grabbed) to single-element array', () => {
    const result = eventHistoryQuerySchema.parse({ eventType: 'grabbed,grabbed' });
    expect(result.eventType).toEqual(['grabbed']);
  });

  it('accepts all 12 event types in a single comma list', () => {
    const all = 'grabbed,download_completed,download_failed,imported,import_failed,deleted,renamed,merged,file_tagged,held_for_review,merge_started,merge_failed';
    const result = eventHistoryQuerySchema.parse({ eventType: all });
    expect(result.eventType).toHaveLength(12);
  });
});

describe('eventTypeSchema', () => {
  it('includes merge_started and merge_failed', () => {
    expect(eventTypeSchema.parse('merge_started')).toBe('merge_started');
    expect(eventTypeSchema.parse('merge_failed')).toBe('merge_failed');
  });

  it('still includes the surviving original event types', () => {
    const originalTypes = [
      'grabbed', 'download_completed', 'download_failed',
      'imported', 'import_failed',
      'deleted', 'renamed', 'merged',
      'file_tagged', 'held_for_review',
    ];
    for (const type of originalTypes) {
      expect(eventTypeSchema.parse(type)).toBe(type);
    }
  });

  it('rejects the removed upgraded event type', () => {
    expect(() => eventTypeSchema.parse('upgraded')).toThrow();
  });

  it('rejects unknown event type strings', () => {
    expect(() => eventTypeSchema.parse('nonexistent_type')).toThrow();
  });

  it('accepts book_added event type (#341)', () => {
    expect(eventTypeSchema.parse('book_added')).toBe('book_added');
  });

  it('rejects typo book_addedd', () => {
    expect(() => eventTypeSchema.parse('book_addedd')).toThrow();
  });

  it('accepts metadata_fixed event type (#1129)', () => {
    expect(eventTypeSchema.parse('metadata_fixed')).toBe('metadata_fixed');
  });
});

describe('eventTypeSchema ↔ DB enum alignment (#1129)', () => {
  it('every Zod enum member is also a DB schema enum member, and vice versa', async () => {
    const { bookEvents } = await import('../../db/schema.js');
    // Drizzle stores the enum on the column config as `enumValues`. This is
    // the same list passed to `text(name, { enum: [...] })` at definition.
    const dbEnum = (bookEvents.eventType as unknown as { enumValues: readonly string[] }).enumValues;
    expect(dbEnum).toBeDefined();
    expect(new Set(dbEnum)).toEqual(new Set(eventTypeSchema.options));
  });
});

describe('eventSourceSchema', () => {
  it('accepts every persisted source value', () => {
    for (const source of ['manual', 'rss', 'scheduled', 'auto', 'import_list']) {
      expect(eventSourceSchema.safeParse(source).success).toBe(true);
    }
  });

  it('rejects unknown source values', () => {
    expect(eventSourceSchema.safeParse('bogus').success).toBe(false);
  });
});
