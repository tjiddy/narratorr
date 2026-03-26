import { z } from 'zod';

// ============================================================================
// Event History schemas
// ============================================================================

export const eventTypeSchema = z.enum([
  'grabbed', 'download_completed', 'download_failed',
  'imported', 'import_failed', 'upgraded',
  'deleted', 'renamed', 'merged',
  'file_tagged', 'held_for_review',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSourceSchema = z.enum(['manual', 'rss', 'scheduled', 'auto']);

export type EventSource = z.infer<typeof eventSourceSchema>;

/** Event types that support the "mark as failed" action (have download linkage) */
export const actionableEventTypes: EventType[] = [
  'grabbed', 'download_completed', 'download_failed', 'imported', 'import_failed',
];

export const eventHistoryQuerySchema = z.object({
  eventType: eventTypeSchema.optional(),
  search: z.string().optional(),
});

export type EventHistoryQuery = z.infer<typeof eventHistoryQuerySchema>;
