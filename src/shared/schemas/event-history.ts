import { z } from 'zod';

// ============================================================================
// Event History schemas
// ============================================================================

export const eventTypeSchema = z.enum([
  'grabbed', 'download_completed', 'download_failed',
  'imported', 'import_failed',
  'deleted', 'renamed', 'merged',
  'file_tagged', 'held_for_review',
  'merge_started', 'merge_failed',
  'wrong_release',
  'book_added',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSourceSchema = z.enum(['manual', 'rss', 'scheduled', 'auto', 'import_list']);

export type EventSource = z.infer<typeof eventSourceSchema>;

/** Event types that support the "mark as failed" action (have download linkage) */
export const actionableEventTypes: EventType[] = [
  'grabbed', 'download_completed', 'download_failed', 'imported', 'import_failed',
];

export const eventHistoryQuerySchema = z.object({
  eventType: z.string().optional().transform((val, ctx) => {
    if (val === undefined) return undefined;
    const segments = val.split(',');
    const parsed: EventType[] = [];
    for (const segment of segments) {
      const result = eventTypeSchema.safeParse(segment);
      if (!result.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid event type: ${segment}` });
        return z.NEVER;
      }
      parsed.push(result.data);
    }
    return [...new Set(parsed)];
  }),
  search: z.string().optional(),
});

export type EventHistoryQuery = z.infer<typeof eventHistoryQuerySchema>;
