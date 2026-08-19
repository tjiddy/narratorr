/**
 * Shared classifier for the `hashes` axis of a `/api/v2/torrents/info` test double (#2485).
 *
 * Real qBittorrent splits the `hashes` value on `|` with `Qt::SkipEmptyParts` and builds an ID
 * filter only when at least one part survives, so an ABSENT `hashes`, an empty `?hashes=`, and
 * `?hashes=||` all mean *no filter* and answer with the FULL list
 * (https://github.com/qbittorrent/qBittorrent/blob/master/src/webui/api/torrentscontroller.cpp#L608-L625).
 * A double that gates on `params.has('hashes')` instead models a blank hash as a filter that
 * matches nothing — the very masking that hid `getDownload('')` adopting an arbitrary torrent.
 */
export function servesFullList(params: URLSearchParams): boolean {
  const hashes = params.get('hashes');
  if (hashes === null) return true;
  // SkipEmptyParts drops only genuinely empty parts, so a whitespace-only part is a real filter.
  return hashes.split('|').every((part) => part.length === 0);
}
