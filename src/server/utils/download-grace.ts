/**
 * A download the client has not registered yet is not a dead download. #2423: a v1+v2 hybrid
 * torrent re-keys to its v2 hash while qBittorrent fetches metadata, and the monitor failed and
 * blacklisted it 28 seconds after the add. Four polls at the default 30-second monitor tick.
 */
export const MISSING_ITEM_GRACE_MS = 120_000;

/**
 * Whether a download row is young enough that the client not reporting it is a non-event.
 *
 * `downloads.addedAt` is notNull with a default, so the non-Date guard only covers legacy/partial
 * rows. A future-dated `addedAt` (clock skew) reads as within grace and self-clears once wall time
 * passes `addedAt + MISSING_ITEM_GRACE_MS`.
 */
export function isWithinMissingItemGrace(addedAt: Date | null | undefined, now: number): boolean {
  if (!(addedAt instanceof Date)) return false;
  // An Invalid Date needs no guard of its own: NaN loses every comparison, so it reads as expired.
  return now - addedAt.getTime() < MISSING_ITEM_GRACE_MS;
}
