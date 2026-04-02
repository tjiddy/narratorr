import { z } from 'zod';

// ============================================================================
// Search stream SSE event schemas (per-request, not broadcast)
// ============================================================================

export const searchStreamIndexerSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const searchStartEventSchema = z.object({
  sessionId: z.string(),
  indexers: z.array(searchStreamIndexerSchema),
});

export const indexerCompleteEventSchema = z.object({
  indexerId: z.number(),
  name: z.string(),
  resultCount: z.number(),
  elapsedMs: z.number(),
});

export const indexerErrorEventSchema = z.object({
  indexerId: z.number(),
  name: z.string(),
  error: z.string(),
  elapsedMs: z.number(),
});

export const indexerCancelledEventSchema = z.object({
  indexerId: z.number(),
  name: z.string(),
});

export type SearchStartEvent = z.infer<typeof searchStartEventSchema>;
export type IndexerCompleteEvent = z.infer<typeof indexerCompleteEventSchema>;
export type IndexerErrorEvent = z.infer<typeof indexerErrorEventSchema>;
export type IndexerCancelledEvent = z.infer<typeof indexerCancelledEventSchema>;

/** SSE event type string literals for search streaming */
export type SearchStreamEventType =
  | 'search-start'
  | 'indexer-complete'
  | 'indexer-error'
  | 'indexer-cancelled'
  | 'search-complete';
