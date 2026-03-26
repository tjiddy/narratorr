import { describe, it, expect } from 'vitest';
import { bookStatusSchema } from './book.js';
import {
  sseEventTypeSchema,
  downloadProgressPayload,
  downloadStatusChangePayload,
  bookStatusChangePayload,
  grabStartedPayload,
  importCompletePayload,
  reviewNeededPayload,
  mergeCompletePayload,
  CACHE_INVALIDATION_MATRIX,
  TOAST_EVENT_CONFIG,
} from './sse-events.js';

describe('bookStatusSchema widening', () => {
  it('includes importing and failed statuses', () => {
    expect(bookStatusSchema.parse('importing')).toBe('importing');
    expect(bookStatusSchema.parse('failed')).toBe('failed');
  });

  it('existing statuses still valid', () => {
    for (const status of ['wanted', 'searching', 'downloading', 'imported', 'missing']) {
      expect(bookStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects invalid statuses', () => {
    expect(() => bookStatusSchema.parse('invalid')).toThrow();
  });
});

describe('SSE event schemas', () => {
  it('defines all 7 event types', () => {
    const types = sseEventTypeSchema.options;
    expect(types).toEqual([
      'download_progress', 'download_status_change', 'book_status_change',
      'import_complete', 'grab_started', 'review_needed', 'merge_complete',
    ]);
  });

  it('validates download_progress payload', () => {
    const valid = { download_id: 1, book_id: 2, percentage: 0.5, speed: 1024, eta: 300 };
    expect(downloadProgressPayload.parse(valid)).toEqual(valid);

    const withNulls = { download_id: 1, book_id: 2, percentage: 0, speed: null, eta: null };
    expect(downloadProgressPayload.parse(withNulls)).toEqual(withNulls);
  });

  it('validates download_status_change payload', () => {
    const valid = { download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed' };
    expect(downloadStatusChangePayload.parse(valid)).toEqual(valid);
  });

  it('validates book_status_change payload with widened statuses', () => {
    const valid = { book_id: 1, old_status: 'importing', new_status: 'imported' };
    expect(bookStatusChangePayload.parse(valid)).toEqual(valid);

    const failed = { book_id: 1, old_status: 'importing', new_status: 'failed' };
    expect(bookStatusChangePayload.parse(failed)).toEqual(failed);
  });

  it('validates grab_started payload', () => {
    const valid = { download_id: 1, book_id: 2, book_title: 'My Book', release_title: 'release.torrent' };
    expect(grabStartedPayload.parse(valid)).toEqual(valid);
  });

  it('validates import_complete payload', () => {
    const valid = { download_id: 1, book_id: 2, book_title: 'My Book' };
    expect(importCompletePayload.parse(valid)).toEqual(valid);
  });

  it('validates review_needed payload', () => {
    const valid = { download_id: 1, book_id: 2, book_title: 'My Book' };
    expect(reviewNeededPayload.parse(valid)).toEqual(valid);
  });

  it('validates merge_complete payload', () => {
    const valid = { book_id: 42, book_title: 'My Book', success: true };
    expect(mergeCompletePayload.parse(valid)).toEqual(valid);

    const failed = { book_id: 42, book_title: 'My Book', success: false };
    expect(mergeCompletePayload.parse(failed)).toEqual(failed);
  });
});

describe('CACHE_INVALIDATION_MATRIX', () => {
  it('covers all event types', () => {
    const eventTypes = sseEventTypeSchema.options;
    for (const type of eventTypes) {
      expect(CACHE_INVALIDATION_MATRIX[type]).toBeDefined();
    }
  });

  it('download_progress patches activity only', () => {
    expect(CACHE_INVALIDATION_MATRIX.download_progress).toEqual({ activity: 'patch' });
  });

  it('import_complete invalidates all caches', () => {
    const rule = CACHE_INVALIDATION_MATRIX.import_complete;
    expect(rule.activity).toBe('invalidate');
    expect(rule.activityCounts).toBe('invalidate');
    expect(rule.books).toBe('invalidate');
    expect(rule.eventHistory).toBe('invalidate');
  });

  it('merge_complete invalidates books, activity, activityCounts, and eventHistory', () => {
    const rule = CACHE_INVALIDATION_MATRIX.merge_complete;
    expect(rule.books).toBe('invalidate');
    expect(rule.activity).toBe('invalidate');
    expect(rule.activityCounts).toBe('invalidate');
    expect(rule.eventHistory).toBe('invalidate');
  });
});

describe('TOAST_EVENT_CONFIG', () => {
  it('only includes grab_started, import_complete, review_needed (not merge_complete)', () => {
    expect(Object.keys(TOAST_EVENT_CONFIG)).toEqual(['import_complete', 'grab_started', 'review_needed']);
    expect(TOAST_EVENT_CONFIG.merge_complete).toBeUndefined();
  });

  it('does not include high-frequency events', () => {
    expect(TOAST_EVENT_CONFIG.download_progress).toBeUndefined();
    expect(TOAST_EVENT_CONFIG.download_status_change).toBeUndefined();
    expect(TOAST_EVENT_CONFIG.book_status_change).toBeUndefined();
  });
});
