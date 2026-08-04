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
  'import_phase_change',
  'import_progress',
  'import_failed',
  'grab_started',
  'review_needed',
  'merge_complete',
  'merge_started',
  'merge_progress',
  'merge_failed',
  'merge_queued',
  'merge_queue_updated',
  'merge_state',
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
  download_id: z.number().nullable(),
  book_id: z.number().nullable(),
  book_title: z.string(),
  job_id: z.number().optional(),
  elapsed_ms: z.number().optional(),
});

export const importPhaseChangePayload = z.object({
  job_id: z.number(),
  book_id: z.number().nullable(),
  book_title: z.string(),
  from: z.string(),
  to: z.string(),
});

export const importProgressPayload = z.object({
  job_id: z.number(),
  book_id: z.number().nullable(),
  book_title: z.string(),
  phase: z.string(),
  progress: z.number(),
  byte_counter: z.object({
    current: z.number(),
    total: z.number(),
  }).optional(),
});

/**
 * Structured refusal discriminator for a forced import the copy-time collision
 * fence refused (#1736). Carried on the existing `import_failed` channel (event +
 * SSE) so a forced import that fails closed is self-describing rather than an
 * opaque generic failure. `existingBookId` is nullable: the ownerless fence throw
 * sites (audio on disk, no row claims it) carry no real incumbent id, so the `-1`
 * sentinel maps to `null` (the user-facing reason never reports "book #-1").
 */
export const forcedImportRefusedReasonSchema = z.object({
  kind: z.literal('forced-import-refused'),
  recordingReason: z.string(),
  existingBookId: z.number().nullable(),
});

export type ForcedImportRefusedReason = z.infer<typeof forcedImportRefusedReasonSchema>;

export const importFailedPayload = z.object({
  job_id: z.number(),
  book_id: z.number().nullable(),
  book_title: z.string(),
  phase: z.string(),
  error_message: z.string(),
  // Optional (#1736): present only for a forced-import refusal; ordinary failures omit it.
  refusal_reason: forcedImportRefusedReasonSchema.optional(),
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

export const mergeDisplayPhaseSchema = z.enum([
  'queued', 'starting', 'staging', 'processing', 'verifying', 'committing', 'complete', 'cancelled', 'failed',
]);

export type MergeDisplayPhase = z.infer<typeof mergeDisplayPhaseSchema>;

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

/**
 * The in-flight display phases — the only ones a `merge_state` snapshot entry may carry
 * (#2129). Derived from `mergeDisplayPhaseSchema` with `.extract()` rather than redeclared,
 * so a phase renamed there cannot silently drift out of the snapshot contract. `queued` is
 * excluded because queued books live in the snapshot's own `queued` list, and the terminal
 * phases are excluded because a terminal merge has already left the snapshot entirely — a
 * snapshot that still carried it would overwrite the terminal card the client just installed.
 */
export const mergeActivePhaseSchema = mergeDisplayPhaseSchema.extract([
  'starting', 'staging', 'processing', 'verifying', 'committing',
]);

export type MergeActivePhase = z.infer<typeof mergeActivePhaseSchema>;

/**
 * Full-state snapshot of the live merge domain (#2129). Unlike every other type on this
 * stream this is state, not an event: it is re-broadcast on every merge state change AND
 * written once to each newly connected client, which is what makes a late joiner (page
 * reload mid-queue) correct by construction. `active` is a list because the merge semaphore
 * is sized from `processing.maxConcurrentProcessing` (1..8), so N merges can genuinely run
 * at once. `queued` is FIFO — position is `index + 1`, not a field. `percentage` keeps the
 * 0..1 fraction `merge_progress` already carries.
 */
export const mergeStatePayload = z.object({
  active: z.array(z.object({
    book_id: z.number(),
    book_title: z.string(),
    phase: mergeActivePhaseSchema,
    percentage: z.number().optional(),
  })),
  queued: z.array(z.object({
    book_id: z.number(),
    book_title: z.string(),
  })),
});

export type MergeStateSnapshot = z.infer<typeof mergeStatePayload>;

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
  book_title: z.string().optional(),
  error_message: z.string().optional(),
  release_title: z.string().optional(),
});

// ============================================================================
// Typed event map — used by EventBroadcaster and frontend handler
// ============================================================================

export type SSEEventPayloads = {
  download_progress: z.infer<typeof downloadProgressPayload>;
  download_status_change: z.infer<typeof downloadStatusChangePayload>;
  book_status_change: z.infer<typeof bookStatusChangePayload>;
  import_complete: z.infer<typeof importCompletePayload>;
  import_phase_change: z.infer<typeof importPhaseChangePayload>;
  import_progress: z.infer<typeof importProgressPayload>;
  import_failed: z.infer<typeof importFailedPayload>;
  grab_started: z.infer<typeof grabStartedPayload>;
  review_needed: z.infer<typeof reviewNeededPayload>;
  merge_complete: z.infer<typeof mergeCompletePayload>;
  merge_started: z.infer<typeof mergeStartedPayload>;
  merge_progress: z.infer<typeof mergeProgressPayload>;
  merge_failed: z.infer<typeof mergeFailedPayload>;
  merge_queued: z.infer<typeof mergeQueuedPayload>;
  merge_queue_updated: z.infer<typeof mergeQueueUpdatedPayload>;
  merge_state: z.infer<typeof mergeStatePayload>;
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
  importJobs?: CacheAction;
}

export const CACHE_INVALIDATION_MATRIX: Record<SSEEventType, CacheInvalidationRule> = {
  download_progress: { activity: 'patch' },
  download_status_change: { activity: 'invalidate', activityCounts: 'invalidate' },
  book_status_change: { books: 'invalidate' },
  grab_started: { activity: 'invalidate', activityCounts: 'invalidate', eventHistory: 'invalidate' },
  import_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate', importJobs: 'invalidate' },
  import_phase_change: { importJobs: 'invalidate' },
  import_progress: { importJobs: 'patch' },
  import_failed: { importJobs: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
  review_needed: { activity: 'invalidate', activityCounts: 'invalidate' },
  merge_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
  merge_started: { eventHistory: 'invalidate' },
  merge_progress: {},
  merge_failed: { eventHistory: 'invalidate', books: 'invalidate' },
  merge_queued: {},
  merge_queue_updated: {},
  // Deliberately empty (#2129): this frame fires on every progress tick and carries no data
  // any query owns — invalidating from it would refetch the whole activity surface per tick.
  merge_state: {},
  search_started: {},
  search_indexer_complete: {},
  search_indexer_error: {},
  search_grabbed: {},
  search_complete: { eventHistory: 'invalidate' },
};

// Event types that should trigger toast notifications
export const TOAST_EVENT_CONFIG: Partial<Record<SSEEventType, { level: 'success' | 'info' | 'warning' | 'error'; titleKey: string }>> = {
  import_complete: { level: 'success', titleKey: 'book_title' },
  import_failed: { level: 'error', titleKey: 'book_title' },
  review_needed: { level: 'warning', titleKey: 'book_title' },
  merge_started: { level: 'info', titleKey: 'book_title' },
  merge_failed: { level: 'error', titleKey: 'book_title' },
  merge_complete: { level: 'success', titleKey: 'message' },
};
