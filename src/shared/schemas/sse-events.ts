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
});

export const mergeStartedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
});

export const mergeProgressPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  phase: z.enum(['staging', 'processing', 'verifying', 'finalizing']),
  percentage: z.number().optional(),
});

export const mergeFailedPayload = z.object({
  book_id: z.number(),
  book_title: z.string(),
  error: z.string(),
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
};

// Event types that should trigger toast notifications
export const TOAST_EVENT_CONFIG: Partial<Record<SSEEventType, { level: 'success' | 'info' | 'warning' | 'error'; titleKey: string }>> = {
  import_complete: { level: 'success', titleKey: 'book_title' },
  review_needed: { level: 'warning', titleKey: 'book_title' },
  merge_started: { level: 'info', titleKey: 'book_title' },
  merge_failed: { level: 'error', titleKey: 'book_title' },
  merge_complete: { level: 'success', titleKey: 'message' },
};
