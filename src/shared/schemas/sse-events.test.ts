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
  searchStartedPayload,
  searchIndexerCompletePayload,
  searchIndexerErrorPayload,
  searchGrabbedPayload,
  searchCompletePayload,
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
  it('defines all 17 event types', () => {
    const types = sseEventTypeSchema.options;
    expect(types).toEqual([
      'download_progress', 'download_status_change', 'book_status_change',
      'import_complete', 'grab_started', 'review_needed', 'merge_complete',
      'merge_started', 'merge_progress', 'merge_failed',
      'merge_queued', 'merge_queue_updated',
      'search_started', 'search_indexer_complete', 'search_indexer_error',
      'search_grabbed', 'search_complete',
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
  it('includes import_complete, review_needed, and merge lifecycle events', () => {
    expect(TOAST_EVENT_CONFIG.import_complete).toBeDefined();
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
    it('accepts valid payload with all phases: staging, processing, verifying, committing', () => {
      for (const phase of ['staging', 'processing', 'verifying', 'committing']) {
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
    it('accepts valid { book_id, book_title, error } payload and defaults reason to error', () => {
      const input = { book_id: 42, book_title: 'My Book', error: 'ffmpeg exited with code 1' };
      expect(mergeFailedPayload.parse(input)).toEqual({ ...input, reason: 'error' });
    });

    it('accepts explicit reason cancelled', () => {
      const input = { book_id: 42, book_title: 'My Book', error: 'Cancelled by user', reason: 'cancelled' };
      expect(mergeFailedPayload.parse(input)).toEqual(input);
    });

    it('accepts explicit reason error', () => {
      const input = { book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed', reason: 'error' };
      expect(mergeFailedPayload.parse(input)).toEqual(input);
    });

    it('rejects invalid reason value', () => {
      expect(() => mergeFailedPayload.parse({ book_id: 42, book_title: 'My Book', error: 'x', reason: 'invalid' })).toThrow();
    });

    it('rejects payload with missing error field', () => {
      expect(() => mergeFailedPayload.parse({ book_id: 42, book_title: 'My Book' })).toThrow();
    });
  });

  describe('#324 — grab_started toast removal', () => {
    it('TOAST_EVENT_CONFIG does not contain grab_started key', () => {
      expect(TOAST_EVENT_CONFIG.grab_started).toBeUndefined();
    });
  });
});

// ============================================================================
// #392 — Search progress SSE event schemas
// ============================================================================

describe('#392 search progress — SSE event schemas', () => {
  it('defines all 17 event types (12 existing + 5 new search events)', () => {
    const types = sseEventTypeSchema.options;
    expect(types).toHaveLength(17);
    expect(types).toContain('search_started');
    expect(types).toContain('search_indexer_complete');
    expect(types).toContain('search_indexer_error');
    expect(types).toContain('search_grabbed');
    expect(types).toContain('search_complete');
  });

  describe('search_started payload', () => {
    it('accepts valid payload with indexers array', () => {
      const valid = { book_id: 1, book_title: 'Test Book', indexers: [{ id: 10, name: 'MAM' }] };
      expect(searchStartedPayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing indexers array', () => {
      expect(() => searchStartedPayload.parse({ book_id: 1, book_title: 'Test' })).toThrow();
    });

    it('accepts payload with empty indexers array', () => {
      const valid = { book_id: 1, book_title: 'Test', indexers: [] };
      expect(searchStartedPayload.parse(valid)).toEqual(valid);
    });
  });

  describe('search_indexer_complete payload', () => {
    it('accepts valid payload with results_found and elapsed_ms', () => {
      const valid = { book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 3, elapsed_ms: 1200 };
      expect(searchIndexerCompletePayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing indexer_id', () => {
      expect(() => searchIndexerCompletePayload.parse({
        book_id: 1, indexer_name: 'MAM', results_found: 3, elapsed_ms: 1200,
      })).toThrow();
    });

    it('accepts results_found: 0 (indexer returned no results)', () => {
      const valid = { book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 0, elapsed_ms: 500 };
      expect(searchIndexerCompletePayload.parse(valid)).toEqual(valid);
    });

    it('accepts elapsed_ms: 0 (instant response)', () => {
      const valid = { book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 5, elapsed_ms: 0 };
      expect(searchIndexerCompletePayload.parse(valid)).toEqual(valid);
    });
  });

  describe('search_indexer_error payload', () => {
    it('accepts valid payload with error string and elapsed_ms', () => {
      const valid = { book_id: 1, indexer_id: 10, indexer_name: 'ABB', error: 'timeout', elapsed_ms: 30000 };
      expect(searchIndexerErrorPayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing error field', () => {
      expect(() => searchIndexerErrorPayload.parse({
        book_id: 1, indexer_id: 10, indexer_name: 'ABB', elapsed_ms: 30000,
      })).toThrow();
    });
  });

  describe('search_grabbed payload', () => {
    it('accepts valid payload with release_title and indexer_name', () => {
      const valid = { book_id: 1, release_title: 'The Way of Kings [128kbps]', indexer_name: 'MAM' };
      expect(searchGrabbedPayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with missing release_title', () => {
      expect(() => searchGrabbedPayload.parse({ book_id: 1, indexer_name: 'MAM' })).toThrow();
    });
  });

  describe('search_complete payload', () => {
    it('accepts valid payload with outcome grabbed', () => {
      const valid = { book_id: 1, total_results: 5, outcome: 'grabbed' };
      expect(searchCompletePayload.parse(valid)).toEqual(valid);
    });

    it('accepts valid payload with outcome no_results', () => {
      const valid = { book_id: 1, total_results: 0, outcome: 'no_results' };
      expect(searchCompletePayload.parse(valid)).toEqual(valid);
    });

    it('accepts valid payload with outcome skipped', () => {
      const valid = { book_id: 1, total_results: 3, outcome: 'skipped' };
      expect(searchCompletePayload.parse(valid)).toEqual(valid);
    });

    it('accepts valid payload with outcome grab_error', () => {
      const valid = { book_id: 1, total_results: 3, outcome: 'grab_error' };
      expect(searchCompletePayload.parse(valid)).toEqual(valid);
    });

    it('rejects payload with invalid outcome string', () => {
      expect(() => searchCompletePayload.parse({ book_id: 1, total_results: 0, outcome: 'invalid' })).toThrow();
    });
  });

  describe('cache invalidation matrix for search events', () => {
    it('all 5 search event types have empty {} entries (ephemeral, no cache impact)', () => {
      const searchEvents = ['search_started', 'search_indexer_complete', 'search_indexer_error', 'search_grabbed', 'search_complete'] as const;
      for (const event of searchEvents) {
        expect(CACHE_INVALIDATION_MATRIX[event]).toEqual({});
      }
    });
  });
});
