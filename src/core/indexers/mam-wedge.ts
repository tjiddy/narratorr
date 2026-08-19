import type { ResolveDownloadContext } from './types.js';

/** Sentinel prefix for MAM results; real torrent bytes are fetched at grab time. */
export const MAM_TORRENT_SENTINEL_PREFIX = 'mam-torrent://';
const MAM_SENTINEL_PATTERN = /^mam-torrent:\/\/(\d+)$/;

/** Prefer the dispatched guid, then fall back to the mam-torrent sentinel. */
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
