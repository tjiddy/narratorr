import type { ResolveDownloadContext } from './types.js';

/** Sentinel prefix used as `SearchResult.downloadUrl` for MAM results — the real torrent is fetched at grab time. */
export const MAM_TORRENT_SENTINEL_PREFIX = 'mam-torrent://';
export const MAM_SENTINEL_PATTERN = /^mam-torrent:\/\/(\d+)$/;

/**
 * Derive the MAM torrent id from the resolve context. Prefers `guid` (when
 * the dispatch path supplied it), else parses the `mam-torrent://{tid}`
 * sentinel emitted by `search()`.
 */
export function parseTorrentIdFromContext(ctx: ResolveDownloadContext): number | undefined {
  if (ctx.guid !== undefined) {
    const n = Number(ctx.guid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const match = MAM_SENTINEL_PATTERN.exec(ctx.downloadUrl);
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}
