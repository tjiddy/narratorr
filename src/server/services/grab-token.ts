import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getKey } from '../utils/secret-codec.js';
import {
  encodeReleaseId,
  decodeReleaseId,
  type ReleaseTokenPayload,
} from '@shared/schemas/v1/actions.js';

// HMAC binds releaseId to search-returned URLs so API-key holders cannot forge downloads.
// Signing stays server-side; shared code owns only the canonical body codec.

// Stable env key preserves releaseIds across credential changes; the label prevents cross-token reuse.
function getSigningKey(): Buffer {
  return createHmac('sha256', getKey()).update('grab-token').digest();
}

function sign(data: string): string {
  return createHmac('sha256', getSigningKey()).update(data).digest('base64url');
}

// Canonical encoding keeps identical releases byte-stable across searches.
export function signReleaseId(payload: ReleaseTokenPayload): string {
  const body = encodeReleaseId(payload);
  return `${body}.${sign(body)}`;
}

// Verify before strict decoding; every malformed case returns null.
export function verifyReleaseId(token: string): ReleaseTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!body || !sig) return null;

  // Fixed-length hashing avoids a signature-length timing branch.
  const expected = sign(body);
  const sigHash = createHash('sha256').update(sig).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(sigHash, expectedHash)) return null;

  return decodeReleaseId(body);
}
