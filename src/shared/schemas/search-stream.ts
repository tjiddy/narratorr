import { z } from 'zod';
import { protocolSchema } from './download-protocol.js';

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
  protocol: protocolSchema,
  downloadUrl: z.string().optional(),
  infoHash: z.string().optional(),
  size: z.number().optional(),
  rawSize: z.string().optional(),
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
  format: z.string().optional(),
  // Kilobits per second. Unbounded above on purpose — a lossless listing legitimately reports
  // 1411 — so `bitrateField` (32-512, which bounds OUR encoder's output) must not be reused here.
  bitrateKbps: z.number().int().positive().optional(),
  // A contract we own, so .optional() is correct here; the tolerant .nullish() belongs to the
  // MAM response schema. Both halves are required together — a partial pair has no meaning.
  unsatisfied: z.object({ count: z.number(), limit: z.number() }).optional(),
});

/**
 * Closed vocabulary of the ways a result can vanish behind the operator's back. Tuple order is the
 * gate evaluation order and doubles as the tie-break for the drop summary. `multi-part-detected` is
 * deliberately absent: it has its own operator-facing surface and would be reported twice.
 */
export const searchDropReasonSchema = z.enum([
  'blacklist-match',
  'reject-word-match',
  'required-word-missing',
  'ebook-only-format',
  'below-min-seeders',
  'below-grab-floor',
  'below-min-size',
  'over-max-size',
  'language-mismatch',
]);

export const searchDropSummarySchema = z.object({
  total: z.number(),
  reasons: z.array(z.object({
    reason: searchDropReasonSchema,
    count: z.number(),
    // Absent whenever the setting behind the reason is disabled or the reason has no single scalar.
    threshold: z.string().optional(),
  })),
});

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  durationUnknown: z.boolean(),
  unsupportedResults: z.object({
    count: z.number(),
    titles: z.array(z.string()),
  }),
  // Present only when progressive relaxation succeeds after the original query fails.
  relaxedQuery: z.string().optional(),
  // Present only when the quality gates actually removed something; a contract we own, so .optional().
  filteredOut: searchDropSummarySchema.optional(),
});

export type SearchStartEvent = z.infer<typeof searchStartEventSchema>;
export type IndexerCompleteEvent = z.infer<typeof indexerCompleteEventSchema>;
export type IndexerErrorEvent = z.infer<typeof indexerErrorEventSchema>;
export type IndexerCancelledEvent = z.infer<typeof indexerCancelledEventSchema>;
export type SearchResultPayload = z.infer<typeof searchResultSchema>;
export type SearchResponsePayload = z.infer<typeof searchResponseSchema>;
export type SearchDropReason = z.infer<typeof searchDropReasonSchema>;
export type SearchDropSummary = z.infer<typeof searchDropSummarySchema>;

export type SearchStreamEventType =
  | 'search-start'
  | 'indexer-complete'
  | 'indexer-error'
  | 'indexer-cancelled'
  | 'search-complete';
