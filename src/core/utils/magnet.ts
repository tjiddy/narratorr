/**
 * Announce URLs appended to every magnet we build, since ABB's detail page gives us an info hash
 * and nothing else. Sourced by hand from ngosang/trackerslist `trackers_best` — deliberately NOT
 * fetched at runtime: a self-hosted app must not phone a third party on every grab, and a list
 * that changes under us makes a failed download unreproducible. Refresh it by hand when entries
 * rot; `public.popcorn-tracker.org` (dead) and `tracker.dler.org` (flaky) were dropped in #2420.
 */
export const TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
];

export function buildMagnetUri(infoHash: string, name?: string): string {
  const params = new URLSearchParams();
  params.set('xt', `urn:btih:${infoHash}`);
  if (name) {
    params.set('dn', name);
  }
  TRACKERS.forEach((tracker) => {
    params.append('tr', tracker);
  });
  return `magnet:?${params.toString()}`;
}

export function parseInfoHash(magnetUri: string): string | null {
  const match = magnetUri.match(/xt=urn(?::|%3A)btih(?::|%3A)([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1]!.toLowerCase() : null;
}
