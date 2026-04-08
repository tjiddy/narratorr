import { z } from 'zod';
import { downloadStatusSchema } from './activity';
import { bookStatusSchema } from './book';

// ============================================================================
// SSE Event Types — single source of truth for all real-time event contracts
// ============================================================================

export const sseEventTypeSchema = z.enum([
  'download_progress',
  'download_status_change',
  'book_status_change',
  'import_complete',
  'grab_started',
  'review_needed',
  'merge_complete',
  'merge_started',
  'merge_progress',
  'merge_failed',
  'merge_queued',
  'merge_queue_updated',
  'search_started',
  'search_indexer_complete',
  'search_indexer_error',
  'search_grabbed',
  'search_complete',
]);

export type SSEEventType = z.infer<typeof sseEventTypeSchema>;

// ============================================================================
// Event Payloads
// ============================================================================

export const downloadProgressPayload = z.object({
  download_id: z.number(),
  book_id: z.number(),
  percentage: z.number(),
  speed: z.number().nullable(),
  eta: z.number().nullable(),
});

export const downloadStatusChangePayload = z.object({
  download_id: z.number(),
  book_id: z.number(),
  old_status: downloadStatusSchema,
  new_status: downloadStatusSchema,
});

export const bookStatusChangePayload = z.object({
  book_id: z.number(),
  old_status: bookStatusSchema,
  new_status: bookStatusSchema,
});

export const grabStartedPayload = z.object({
  download_id: z.number(),
  book_id: z.number(),
  book_title: z.string(),
  release_title: z.string(),
});

export const importCompletePayload = z.object({
  download_id: z.number(),
  book_id: z.number(),
  book_title: z.string(),
});

export const reviewNeededPayload = z.object({
  download_id: z.number(),
  book_id: z.number(),
  book_title: z.string(),
});

export const mergeCompletePayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  success: z.boolean(),
  message: z.string(),
  enrichmentWarning: z.string().optional(),
});

export const mergeStartedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
});

export const mergePhaseSchema = z.enum(['staging', 'processing', 'verifying', 'committing']);

export type MergePhase = z.infer<typeof mergePhaseSchema>;

export const mergeProgressPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  phase: mergePhaseSchema,
  percentage: z.number().optional(),
});

export const mergeFailedReasonSchema = z.enum(['cancelled', 'error']);

export type MergeFailedReason = z.infer<typeof mergeFailedReasonSchema>;

export const mergeFailedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  error: z.string(),
  reason: mergeFailedReasonSchema.default('error'),
});

export const mergeQueuedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  position: z.number(),
});

export const mergeQueueUpdatedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  position: z.number(),
});

export const searchStartedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  indexers: z.array(z.object({ id: z.number(), name: z.string() })),
});

export const searchIndexerCompletePayload = z.object({
  book_id: z.number(),
  indexer_id: z.number(),
  indexer_name: z.string(),
  results_found: z.number(),
  elapsed_ms: z.number(),
});

export const searchIndexerErrorPayload = z.object({
  book_id: z.number(),
  indexer_id: z.number(),
  indexer_name: z.string(),
  error: z.string(),
  elapsed_ms: z.number(),
});

export const searchGrabbedPayload = z.object({
  book_id: z.number(),
  release_title: z.string(),
  indexer_name: z.string(),
});

export const searchCompletePayload = z.object({
  book_id: z.number(),
  total_results: z.number(),
  outcome: z.enum(['grabbed', 'no_results', 'skipped', 'grab_error']),
});

// ============================================================================
// Typed event map — used by EventBroadcaster and frontend handler
// ============================================================================

export type SSEEventPayloads = {
  download_progress: z.infer<typeof downloadProgressPayload>;
  download_status_change: z.infer<typeof downloadStatusChangePayload>;
  book_status_change: z.infer<typeof bookStatusChangePayload>;
  import_complete: z.infer<typeof importCompletePayload>;
  grab_started: z.infer<typeof grabStartedPayload>;
  review_needed: z.infer<typeof reviewNeededPayload>;
  merge_complete: z.infer<typeof mergeCompletePayload>;
  merge_started: z.infer<typeof mergeStartedPayload>;
  merge_progress: z.infer<typeof mergeProgressPayload>;
  merge_failed: z.infer<typeof mergeFailedPayload>;
  merge_queued: z.infer<typeof mergeQueuedPayload>;
  merge_queue_updated: z.infer<typeof mergeQueueUpdatedPayload>;
  search_started: z.infer<typeof searchStartedPayload>;
  search_indexer_complete: z.infer<typeof searchIndexerCompletePayload>;
  search_indexer_error: z.infer<typeof searchIndexerErrorPayload>;
  search_grabbed: z.infer<typeof searchGrabbedPayload>;
  search_complete: z.infer<typeof searchCompletePayload>;
};

// ============================================================================
// Cache invalidation matrix — data-driven, no switch statements
// ============================================================================

export type CacheAction = 'patch' | 'invalidate';

export interface CacheInvalidationRule {
  activity?: CacheAction;
  activityCounts?: CacheAction;
  books?: CacheAction;
  eventHistory?: CacheAction;
}

export const CACHE_INVALIDATION_MATRIX: Record<SSEEventType, CacheInvalidationRule> = {
  download_progress: { activity: 'patch' },
  download_status_change: { activity: 'invalidate', activityCounts: 'invalidate' },
  book_status_change: { books: 'invalidate' },
  grab_started: { activity: 'invalidate', activityCounts: 'invalidate', eventHistory: 'invalidate' },
  import_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
  review_needed: { activity: 'invalidate', activityCounts: 'invalidate' },
  merge_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
  merge_started: { eventHistory: 'invalidate' },
  merge_progress: {},
  merge_failed: { eventHistory: 'invalidate', books: 'invalidate' },
  merge_queued: {},
  merge_queue_updated: {},
  search_started: {},
  search_indexer_complete: {},
  search_indexer_error: {},
  search_grabbed: {},
  search_complete: {},
};

// Event types that should trigger toast notifications
export const TOAST_EVENT_CONFIG: Partial<Record<SSEEventType, { level: 'success' | 'info' | 'warning' | 'error'; titleKey: string }>> = {
  import_complete: { level: 'success', titleKey: 'book_title' },
  review_needed: { level: 'warning', titleKey: 'book_title' },
  merge_started: { level: 'info', titleKey: 'book_title' },
  merge_failed: { level: 'error', titleKey: 'book_title' },
  merge_complete: { level: 'success', titleKey: 'message' },
};
