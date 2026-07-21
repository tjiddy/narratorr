import { serializeSubmissionForDigest, type SubmissionDigestInput } from '../../../core/import-staging/schemas.js';
import { sha256Hex } from './sha256.js';

/**
 * Compute the client submission digest (#1902, F20).
 *
 * The canonicalization contract (`serializeSubmissionForDigest`, SHA-256, lowercase
 * hex) is fixed by #1893 and shared with the server. `SubtleCrypto.digest` is a
 * secure-context API, so on plain-HTTP LAN origins `crypto.subtle` is `undefined`;
 * we then hash the SAME canonical UTF-8 bytes with a pure-JS SHA-256 fallback. A
 * `crypto.subtle.digest` **rejection** (some engines throw on insecure contexts)
 * falls through to the same fallback. Either path yields a byte-for-byte identical
 * digest, so imports never silently fail before create.
 */

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
      // Insecure-context rejection (or any Web Crypto failure) → deterministic fallback.
    }
  }
  return sha256Hex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
