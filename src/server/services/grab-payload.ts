import type { SearchResult, DownloadProtocol } from '../../core/indexers/types.js';
import type { CreateEventInput } from './event-history.service.js';

export interface GrabPayload {
  downloadUrl: string;
  title: string;
  protocol?: DownloadProtocol;
  bookId?: number;
  indexerId?: number;
  size?: number;
  seeders?: number;
  guid?: string;
  skipDuplicateCheck?: boolean;
  replaceExisting?: boolean;
  source?: CreateEventInput['source'];
}

/**
 * Build a grab payload from a SearchResult and bookId.
 * Maps the 7 common base fields; caller-specific extras go in `overrides`.
 * Undefined optional fields are omitted from the output.
 */
export function buildGrabPayload(
  result: SearchResult,
  bookId: number,
  overrides?: Partial<GrabPayload>,
): GrabPayload {
  const payload: GrabPayload = {
    title: result.title,
    protocol: result.protocol,
    bookId,
  };

  if (result.downloadUrl !== undefined) payload.downloadUrl = result.downloadUrl;
  if (result.indexerId !== undefined) payload.indexerId = result.indexerId;
  if (result.size !== undefined) payload.size = result.size;
  if (result.seeders !== undefined) payload.seeders = result.seeders;

  if (overrides) {
    Object.assign(payload, overrides);
  }

  return payload;
}
