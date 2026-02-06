const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
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
  const match = magnetUri.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

export function extractDisplayName(magnetUri: string): string | null {
  const match = magnetUri.match(/dn=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  }
  return null;
}
