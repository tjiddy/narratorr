import type { SearchResult } from '@core/indexers/types.js';
import type { GrabParams } from './download-orchestrator.js';

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

  // Copied here rather than at each call site: `rss.ts` overrides nothing, and for an adapter whose
  // search results carry no infoHash (ABB, #2420) guid is the release's only persisted identity —
  // dropping it leaves a blacklist entry with nothing to match and the release re-grabbed next pass.
  if (result.guid !== undefined) payload.guid = result.guid;
  if (result.indexerId !== undefined) payload.indexerId = result.indexerId;
  if (result.size !== undefined) payload.size = result.size;
  if (result.seeders !== undefined) payload.seeders = result.seeders;
  if (result.isFreeleech !== undefined) payload.isFreeleech = result.isFreeleech;

  if (overrides) {
    Object.assign(payload, overrides);
  }

  return payload;
}
