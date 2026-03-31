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
  mergeStartedPayload,
  mergeProgressPayload,
  mergeFailedPayload,
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
  it('defines all 10 event types', () => {
    const types = sseEventTypeSchema.options;
    expect(types).toEqual([
      'download_progress', 'download_status_change', 'book_status_change',
      'import_complete', 'grab_started', 'review_needed', 'merge_complete',
      'merge_started', 'merge_progress', 'merge_failed',
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

  it('validates merge_complete payload with message field', () => {
    const valid = { book_id: 42, book_title: 'My Book', success: true, message: 'Merged 5 files to My Book.m4b' };
    expect(mergeCompletePayload.parse(valid)).toEqual(valid);

    const failed = { book_id: 42, book_title: 'My Book', success: false, message: 'Merge failed' };
    expect(mergeCompletePayload.parse(failed)).toEqual(failed);
  });

  it('rejects merge_complete payload without message field', () => {
    expect(() => mergeCompletePayload.parse({ book_id: 42, book_title: 'My Book', success: true })).toThrow();
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

  it('merge_started invalidates eventHistory only', () => {
    const rule = CACHE_INVALIDATION_MATRIX.merge_started;
    expect(rule.eventHistory).toBe('invalidate');
    expect(rule.activity).toBeUndefined();
    expect(rule.activityCounts).toBeUndefined();
    expect(rule.books).toBeUndefined();
  });

  it('merge_failed invalidates eventHistory and books', () => {
    const rule = CACHE_INVALIDATION_MATRIX.merge_failed;
    expect(rule.eventHistory).toBe('invalidate');
    expect(rule.books).toBe('invalidate');
    expect(rule.activity).toBeUndefined();
    expect(rule.activityCounts).toBeUndefined();
  });

  it('merge_progress has empty invalidation (no cache impact)', () => {
    const rule = CACHE_INVALIDATION_MATRIX.merge_progress;
    expect(rule).toEqual({});
  });
});

describe('TOAST_EVENT_CONFIG', () => {
  it('includes grab_started, import_complete, review_needed, and merge lifecycle events', () => {
    expect(TOAST_EVENT_CONFIG.import_complete).toBeDefined();
    expect(TOAST_EVENT_CONFIG.grab_started).toBeDefined();
    expect(TOAST_EVENT_CONFIG.review_needed).toBeDefined();
    expect(TOAST_EVENT_CONFIG.merge_started).toBeDefined();
    expect(TOAST_EVENT_CONFIG.merge_failed).toBeDefined();
    expect(TOAST_EVENT_CONFIG.merge_complete).toBeDefined();
  });

  it('does not include high-frequency events', () => {
    expect(TOAST_EVENT_CONFIG.download_progress).toBeUndefined();
    expect(TOAST_EVENT_CONFIG.download_status_change).toBeUndefined();
    expect(TOAST_EVENT_CONFIG.book_status_change).toBeUndefined();
    expect(TOAST_EVENT_CONFIG.merge_progress).toBeUndefined();
  });

  it('merge_started is info level with book_title key', () => {
    expect(TOAST_EVENT_CONFIG.merge_started).toEqual({ level: 'info', titleKey: 'book_title' });
  });

  it('merge_failed is error level with book_title key', () => {
    expect(TOAST_EVENT_CONFIG.merge_failed).toEqual({ level: 'error', titleKey: 'book_title' });
  });

  it('merge_complete is success level with message key', () => {
    expect(TOAST_EVENT_CONFIG.merge_complete).toEqual({ level: 'success', titleKey: 'message' });
  });
});

// ============================================================================
// #257 — Merge observability: new SSE payload schemas
// ============================================================================

describe('#257 merge observability — SSE payload schemas', () => {
  describe('merge_started payload', () => {
    it('accepts valid { book_id, book_title } payload', () => {
      const valid = { book_id: 42, book_title: 'My Book' };
      expect(mergeStartedPayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing book_id', () => {
      expect(() => mergeStartedPayload.parse({ book_title: 'My Book' })).toThrow();
    });

    it('rejects payload with missing book_title', () => {
      expect(() => mergeStartedPayload.parse({ book_id: 42 })).toThrow();
    });
  });

  describe('merge_progress payload', () => {
    it('accepts valid payload with all phases: staging, processing, verifying, finalizing', () => {
      for (const phase of ['staging', 'processing', 'verifying', 'finalizing']) {
        const valid = { book_id: 42, book_title: 'My Book', phase };
        expect(mergeProgressPayload.parse(valid)).toEqual(valid);
      }
    });

    it('rejects invalid phase string', () => {
      expect(() => mergeProgressPayload.parse({ book_id: 42, book_title: 'My Book', phase: 'unknown' })).toThrow();
    });

    it('percentage is optional (absent during non-processing phases)', () => {
      const withoutPercentage = { book_id: 42, book_title: 'My Book', phase: 'staging' };
      expect(mergeProgressPayload.parse(withoutPercentage)).toEqual(withoutPercentage);
    });

    it('accepts percentage as 0..1 ratio', () => {
      const valid = { book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.34 };
      expect(mergeProgressPayload.parse(valid)).toEqual(valid);
    });
  });

  describe('merge_failed payload', () => {
    it('accepts valid { book_id, book_title, error } payload', () => {
      const valid = { book_id: 42, book_title: 'My Book', error: 'ffmpeg exited with code 1' };
      expect(mergeFailedPayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing error field', () => {
      expect(() => mergeFailedPayload.parse({ book_id: 42, book_title: 'My Book' })).toThrow();
    });
  });
});
