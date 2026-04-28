import type { z } from 'zod';
import {
  type SSEEventType,
  type SSEEventPayloads,
  downloadProgressPayload,
  downloadStatusChangePayload,
  bookStatusChangePayload,
  grabStartedPayload,
  importCompletePayload,
  importPhaseChangePayload,
  importProgressPayload,
  importFailedPayload,
  reviewNeededPayload,
  mergeCompletePayload,
  mergeStartedPayload,
  mergeProgressPayload,
  mergeFailedPayload,
  mergeQueuedPayload,
  mergeQueueUpdatedPayload,
  searchStartedPayload,
  searchIndexerCompletePayload,
  searchIndexerErrorPayload,
  searchGrabbedPayload,
  searchCompletePayload,
} from '../../../shared/schemas.js';

export function safeParseEvent<T extends z.ZodTypeAny>(
  type: string,
  event: MessageEvent,
  schema: T,
): z.infer<T> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data);
  } catch (err) {
    console.warn(`SSE ${type}: invalid JSON`, err);
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.warn(`SSE ${type}: schema validation failed`, result.error);
    return null;
  }
  return result.data;
}

type SSEParserMap = { [K in SSEEventType]: z.ZodType<SSEEventPayloads[K]> };

export const SSE_PARSERS: SSEParserMap = {
  download_progress: downloadProgressPayload,
  download_status_change: downloadStatusChangePayload,
  book_status_change: bookStatusChangePayload,
  grab_started: grabStartedPayload,
  import_complete: importCompletePayload,
  import_phase_change: importPhaseChangePayload,
  import_progress: importProgressPayload,
  import_failed: importFailedPayload,
  review_needed: reviewNeededPayload,
  merge_complete: mergeCompletePayload,
  merge_started: mergeStartedPayload,
  merge_progress: mergeProgressPayload,
  merge_failed: mergeFailedPayload,
  merge_queued: mergeQueuedPayload,
  merge_queue_updated: mergeQueueUpdatedPayload,
  search_started: searchStartedPayload,
  search_indexer_complete: searchIndexerCompletePayload,
  search_indexer_error: searchIndexerErrorPayload,
  search_grabbed: searchGrabbedPayload,
  search_complete: searchCompletePayload,
};

export function safeParseSseEvent<T extends SSEEventType>(
  type: T,
  event: MessageEvent,
): SSEEventPayloads[T] | null {
  return safeParseEvent(type, event, SSE_PARSERS[type]);
}
