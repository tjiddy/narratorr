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

export const searchResultSchema = z.object({
  title: z.string(),
  rawTitle: z.string().optional(),
  author: z.string().optional(),
  narrator: z.string().optional(),
  protocol: z.enum(['torrent', 'usenet']),
  downloadUrl: z.string().optional(),
  infoHash: z.string().optional(),
  size: z.number().optional(),
  seeders: z.number().optional(),
  leechers: z.number().optional(),
  grabs: z.number().optional(),
  language: z.string().optional(),
  newsgroup: z.string().optional(),
  nzbName: z.string().optional(),
  indexer: z.string(),
  indexerId: z.number().optional(),
  indexerPriority: z.number().optional(),
  detailsUrl: z.string().optional(),
  guid: z.string().optional(),
  coverUrl: z.string().optional(),
  matchScore: z.number().optional(),
  isFreeleech: z.boolean().optional(),
  isVipOnly: z.boolean().optional(),
});

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  durationUnknown: z.boolean(),
  unsupportedResults: z.object({
    count: z.number(),
    titles: z.array(z.string()),
  }),
});

export type SearchStartEvent = z.infer<typeof searchStartEventSchema>;
export type IndexerCompleteEvent = z.infer<typeof indexerCompleteEventSchema>;
export type IndexerErrorEvent = z.infer<typeof indexerErrorEventSchema>;
export type IndexerCancelledEvent = z.infer<typeof indexerCancelledEventSchema>;
export type SearchResultPayload = z.infer<typeof searchResultSchema>;
export type SearchResponsePayload = z.infer<typeof searchResponseSchema>;

/** SSE event type string literals for search streaming */
export type SearchStreamEventType =
  | 'search-start'
  | 'indexer-complete'
  | 'indexer-error'
  | 'indexer-cancelled'
  | 'search-complete';
