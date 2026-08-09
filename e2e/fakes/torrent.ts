import { createHash } from 'node:crypto';

/** Minimal torrent shared by fake MAM and qBit so `info_hash` survives the download/upload round trip. */
export interface BuildTorrentArgs {
  fileName: string;
  /** Bytes. */
  fileLength: number;
}

export function buildTorrentBytes({ fileName, fileLength }: BuildTorrentArgs): Buffer {
  // Neither fake verifies piece content; a 20-byte placeholder satisfies the wire format.
  const pieceHash = Buffer.alloc(20, 0);

  // BEP-3 requires dictionary keys in lexical order.
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

  return Buffer.concat([
    Buffer.from('d4:info'),
    info,
    Buffer.from('e'),
  ]);
}

/** Computes SHA-1 over the bencoded `info` dictionary, matching Narratorr's extractor. */
export function computeInfoHash(torrentBytes: Buffer): string | null {
  const marker = Buffer.from('4:info');
  const idx = torrentBytes.indexOf(marker);
  if (idx === -1) return null;

  const infoStart = idx + marker.length;
  if (torrentBytes[infoStart] !== 0x64) return null; // must start with 'd'

  // Walk the nested bencode value to isolate the exact info-dictionary bytes.
  let depth = 0;
  let pos = infoStart;
  while (pos < torrentBytes.length) {
    const byte = torrentBytes[pos]!;
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
