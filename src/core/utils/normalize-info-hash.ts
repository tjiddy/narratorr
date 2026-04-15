import { base32ToHex } from './download-url.js';

export function normalizeInfoHash(infoHash: string): string {
  return infoHash.length === 32
    ? base32ToHex(infoHash).toLowerCase()
    : infoHash.toLowerCase();
}
