import { base32ToHex } from './base32.js';

export function normalizeInfoHash(infoHash: string): string {
  return infoHash.length === 32
    ? base32ToHex(infoHash).toLowerCase()
    : infoHash.toLowerCase();
}
