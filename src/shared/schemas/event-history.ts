import { z } from 'zod';

export const eventTypeSchema = z.enum([
  'grabbed', 'download_completed', 'download_failed',
  'imported', 'import_failed',
  'deleted', 'renamed', 'merged',
  'file_tagged', 'held_for_review',
  'merge_started', 'merge_failed',
  'wrong_release',
  'book_added',
  'metadata_fixed',
  'grab_failed',
  'recording_review_skipped',
  // A relaxed search found candidates but no corroborating title segments; persist
  // the hold because scheduled searches cannot rely on a transient SSE toast.
  'search_relaxed_held',
  // An import replaced a narratorr-marked metadata.opf whose content differed from what it
  // regenerated; the replaced bytes are beside the book as metadata.opf.bak.
  'sidecar_diverged',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSourceSchema = z.enum(['manual', 'rss', 'scheduled', 'auto', 'import_list']);

export type EventSource = z.infer<typeof eventSourceSchema>;

// Only events with download linkage can be marked failed.
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
