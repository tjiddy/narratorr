import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getKey } from '../utils/secret-codec.js';
import {
  encodeReleaseId,
  decodeReleaseId,
  type ReleaseTokenPayload,
} from '../../shared/schemas/v1/actions.js';

// ============================================================================
// v1 grab-token signing/verification (#1488)
// ============================================================================
//
// The v1 `releaseId` is opaque AND HMAC-signed: search mints `signReleaseId`,
// grab checks `verifyReleaseId` before reconstructing `GrabParams`. Without the
// signature, a holder of a valid `/api/v*` API key could forge a `releaseId`
// carrying an arbitrary `downloadUrl` and make the download client fetch it; the
// MAC constrains the public key back to "grab only releases a search returned".
//
// This lives SERVER-SIDE (not in the client-importable `src/shared/` layer) so
// the HMAC secret never reaches the client bundle. The canonical body codec
// (`encodeReleaseId`/`decodeReleaseId`) stays in shared; only sign + verify —
// the secret-dependent half — live here. Mirrors `preview-token.ts` and the
// stream-token pattern in `auth.service.ts` (`base64url(body).base64url(sig)`,
// timing-safe fixed-length compare, domain-separated derived sub-key).

/**
 * Domain-separated signing key for v1 grab tokens. Derived from the env-stable
 * encryption key (`NARRATORR_SECRET_KEY` via `getKey`) with a distinct
 * `grab-token` label, so a grab token is non-interchangeable with the SSE
 * stream token (different secret AND different label — `auth.service.ts` keys its
 * stream token off the rotating session secret with a `stream-token` label) and
 * with the audio-preview token (`audio-preview-token-v1` label). Keying off the
 * env secret — not the session secret — keeps outstanding `releaseId`s valid
 * across a credential change and lets the stateless search projector sign without
 * a DB read (deliberate divergence from the stream token; see #1488 notes).
 */
function getSigningKey(): Buffer {
  return createHmac('sha256', getKey()).update('grab-token').digest();
}

function sign(data: string): string {
  return createHmac('sha256', getSigningKey()).update(data).digest('base64url');
}

/**
 * Sign a release payload into a stable, HMAC-protected `releaseId`:
 * `base64url(canonicalBody).base64url(HMAC)`. The body is the canonical
 * fixed-key-order encoding, so the same release yields a byte-identical token
 * across searches (idempotency/dedup invariant unchanged).
 */
export function signReleaseId(payload: ReleaseTokenPayload): string {
  const body = encodeReleaseId(payload);
  return `${body}.${sign(body)}`;
}

/**
 * Verify a signed `releaseId` and decode its payload, or `null` when the token is
 * malformed, carries no/invalid MAC, or fails the strict body schema. The MAC is
 * checked timing-safely (both sides hashed to a fixed 32 bytes first, so an early
 * length-mismatch return cannot leak signature length). Only after the signature
 * passes is the body decoded. Never throws — the grab route maps `null` to the
 * existing 400 `BAD_REQUEST` v1 envelope.
 */
export function verifyReleaseId(token: string): ReleaseTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!body || !sig) return null;

  // SHA-256 both signatures to a fixed length (32 bytes) BEFORE timingSafeEqual —
  // mirrors src/server/services/preview-token.ts:42 and auth.service.ts. An early
  // raw-length-mismatch return would leak signature length via timing.
  const expected = sign(body);
  const sigHash = createHash('sha256').update(sig).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(sigHash, expectedHash)) return null;

  return decodeReleaseId(body);
}
