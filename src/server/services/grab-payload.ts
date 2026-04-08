import type { SearchResult } from '../../core/indexers/types.js';
import type { GrabParams } from './download-orchestrator.js';

/**
 * Build a grab payload from a SearchResult and bookId.
 * Maps the 7 common base fields; caller-specific extras go in `overrides`.
 * Undefined optional fields are omitted from the output.
 */
export function buildGrabPayload(
  result: SearchResult,
  bookId: number,
  overrides?: Partial<GrabParams>,
): GrabParams {
  const payload: GrabParams = {
    downloadUrl: result.downloadUrl!,
    title: result.title,
    protocol: result.protocol,
    bookId,
  };

  if (result.indexerId !== undefined) payload.indexerId = result.indexerId;
  if (result.size !== undefined) payload.size = result.size;
  if (result.seeders !== undefined) payload.seeders = result.seeders;

  if (overrides) {
    Object.assign(payload, overrides);
  }

  return payload;
}
