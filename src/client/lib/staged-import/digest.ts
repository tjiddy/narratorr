import { serializeSubmissionForDigest, type SubmissionDigestInput } from '@core/import-staging/schemas.js';
import { sha256Hex } from './sha256.js';

// Hash server-shared canonical bytes; plain HTTP and Web Crypto failures use the JS fallback.

const encoder = new TextEncoder();

export async function computeSubmissionDigest(
  input: SubmissionDigestInput,
  subtle: SubtleCrypto | undefined = typeof crypto !== 'undefined' ? crypto.subtle : undefined,
): Promise<string> {
  const bytes = encoder.encode(serializeSubmissionForDigest(input));
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return toHex(new Uint8Array(buf));
    } catch {
      // Fall through to the deterministic JS fallback.
    }
  }
  return sha256Hex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
