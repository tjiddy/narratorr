import { createHash } from 'node:crypto';

/**
 * Build a minimal valid bencoded single-file torrent. The fake MAM server returns
 * these bytes; Narratorr's `extractInfoHashFromTorrent` parses them to compute the
 * info_hash; the fake qBit server re-parses the uploaded multipart bytes to key
 * torrents by the same info_hash. No real peer-to-peer semantics — just enough
 * bencode structure for `4:info` extraction and sha1 hashing to round-trip.
 */
export interface BuildTorrentArgs {
  /** Filename that lives inside the torrent (also used for the top-level name). */
  fileName: string;
  /** File length in bytes. Narratorr does not verify this matches the fixture, but keep it honest. */
  fileLength: number;
}

export function buildTorrentBytes({ fileName, fileLength }: BuildTorrentArgs): Buffer {
  // 20-byte piece hash — placeholder, not verified by either side.
  const pieceHash = Buffer.alloc(20, 0);

  // Info dict (bencoded): order keys alphabetically per BEP-3.
  const info = Buffer.concat([
    Buffer.from('d'),
    Buffer.from(`6:length`),
    Buffer.from(`i${fileLength}e`),
    Buffer.from(`4:name${fileName.length}:${fileName}`),
    Buffer.from(`12:piece lengthi16384e`),
    Buffer.from(`6:pieces20:`),
    pieceHash,
    Buffer.from('e'),
  ]);

  // Outer dict wraps the info dict under the `info` key.
  return Buffer.concat([
    Buffer.from('d4:info'),
    info,
    Buffer.from('e'),
  ]);
}

/**
 * Compute info_hash the same way Narratorr's `extractInfoHashFromTorrent` does:
 * sha1 of the bencoded `info` dict bytes. The fake qBit uses this to match
 * uploaded torrents against the id Narratorr tracks.
 */
export function computeInfoHash(torrentBytes: Buffer): string | null {
  const marker = Buffer.from('4:info');
  const idx = torrentBytes.indexOf(marker);
  if (idx === -1) return null;

  const infoStart = idx + marker.length;
  if (torrentBytes[infoStart] !== 0x64) return null; // must start with 'd'

  // Walk the bencode dict to find its end.
  let depth = 0;
  let pos = infoStart;
  while (pos < torrentBytes.length) {
    const byte = torrentBytes[pos];
    if (byte === 0x64 || byte === 0x6C) {
      depth++;
      pos++;
    } else if (byte === 0x65) {
      depth--;
      pos++;
      if (depth === 0) {
        const infoBytes = torrentBytes.subarray(infoStart, pos);
        return createHash('sha1').update(infoBytes).digest('hex');
      }
    } else if (byte === 0x69) {
      const endIdx = torrentBytes.indexOf(0x65, pos + 1);
      if (endIdx === -1) return null;
      pos = endIdx + 1;
    } else if (byte >= 0x30 && byte <= 0x39) {
      const colonIdx = torrentBytes.indexOf(0x3A, pos);
      if (colonIdx === -1) return null;
      const len = parseInt(torrentBytes.subarray(pos, colonIdx).toString(), 10);
      pos = colonIdx + 1 + len;
    } else {
      return null;
    }
  }
  return null;
}
