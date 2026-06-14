import { z } from 'zod';
import { v1ListResponseSchema } from './common.js';

// ============================================================================
// Public API v1 — Action endpoints: search + grab (S6 — #1452)
// ============================================================================
//
// The two action endpoints a request-app needs to queue a book: search a book's
// indexers for candidate releases, then grab one of them. Both sit behind the v1
// serializer boundary, so the wire contract hides every internal release field
// (`downloadUrl`, `infoHash`, raw `guid`, internal `indexerId`) behind an opaque,
// STABLE `releaseId` token: search encodes the grab-relevant + identity fields
// into it, grab decodes them back to reconstruct the `GrabParams` and the dedup
// identity. The token is opacity, not security — the single-user trusted-key
// model means signing is unnecessary; opacity keeps raw internals out of the
// visible contract and removes any need for a server-side release cache.
//
// These are schemas narratorr OWNS, so they are `.strict()` — the OPPOSITE of
// the prowlarr-compat surface (learning `compat-surface-zod-strip-not-strict`,
// #1198). `.strict()` is what makes the response boundary FAIL CLOSED: a leaked
// internal field is rejected at serialization, not silently stripped and shipped.

// ----------------------------------------------------------------------------
// Opaque release token — encode (search) / decode (grab)
// ----------------------------------------------------------------------------

/**
 * The fields packed into the opaque `releaseId`. These are everything grab needs
 * to (a) reconstruct `GrabParams` and (b) derive the dedup identity / mutex key.
 * `downloadUrl`/`title`/`protocol` are required (a grabbable release always has
 * them); the identity fields (`guid`, `infoHash`, `indexerId`) and the display
 * extras (`size`, `seeders`, `isFreeleech`) are optional because not every
 * indexer result carries them.
 */
export const releaseTokenPayloadSchema = z
  .object({
    downloadUrl: z.string(),
    title: z.string(),
    protocol: z.enum(['torrent', 'usenet']),
    guid: z.string().optional(),
    infoHash: z.string().optional(),
    indexerId: z.number().int().optional(),
    size: z.number().optional(),
    seeders: z.number().optional(),
    isFreeleech: z.boolean().optional(),
  })
  .strict();

export type ReleaseTokenPayload = z.infer<typeof releaseTokenPayloadSchema>;

/**
 * Encode a release token payload into a stable, opaque base64url string. The key
 * order is fixed (the object literal below), so the SAME release encodes to the
 * SAME token across repeated searches — which is what lets grab's dedup keys line
 * up between a search and a later retried grab. Undefined fields are omitted
 * (never serialized as `null`), so a release that lacks an `infoHash` produces a
 * shorter token without an `infoHash` key, not a `"infoHash":null` entry.
 */
export function encodeReleaseId(payload: ReleaseTokenPayload): string {
  // Rebuild with a FIXED key order so the JSON (and thus the token) is stable;
  // conditional spreads omit undefined optionals rather than emitting nulls.
  const canonical = {
    downloadUrl: payload.downloadUrl,
    title: payload.title,
    protocol: payload.protocol,
    ...(payload.guid !== undefined && { guid: payload.guid }),
    ...(payload.infoHash !== undefined && { infoHash: payload.infoHash }),
    ...(payload.indexerId !== undefined && { indexerId: payload.indexerId }),
    ...(payload.size !== undefined && { size: payload.size }),
    ...(payload.seeders !== undefined && { seeders: payload.seeders }),
    ...(payload.isFreeleech !== undefined && { isFreeleech: payload.isFreeleech }),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url');
}

/**
 * Decode an opaque `releaseId` back into its payload, or `null` when the token is
 * malformed (not base64url JSON) or fails the strict payload schema. The grab
 * route maps a `null` here to a 400 v1 envelope. Decoding never throws.
 */
export function decodeReleaseId(token: string): ReleaseTokenPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = releaseTokenPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ----------------------------------------------------------------------------
// Release DTO (search response item) — strict, opaque
// ----------------------------------------------------------------------------

/**
 * The public Release DTO returned by the search endpoint. Exposes ONLY
 * display/selection fields plus the opaque `releaseId` the client passes back to
 * grab. Raw internal identifiers (`downloadUrl`, `infoHash`, raw `guid`, internal
 * `indexerId`) are NOT top-level contract fields — they live encoded inside
 * `releaseId`. `.strict()` makes the response boundary fail closed.
 */
export const releaseV1Schema = z
  .object({
    releaseId: z.string(),
    title: z.string(),
    author: z.string().nullable(),
    narrator: z.string().nullable(),
    protocol: z.enum(['torrent', 'usenet']),
    size: z.number().nullable(),
    seeders: z.number().nullable(),
    indexer: z.string(),
    isFreeleech: z.boolean(),
    matchScore: z.number().nullable(),
  })
  .strict();

export type ReleaseV1 = z.infer<typeof releaseV1Schema>;

/** The v1 search list response: `{ data: ReleaseV1[], total }`, strict. */
export const releaseV1ListResponseSchema = v1ListResponseSchema(releaseV1Schema);

// ----------------------------------------------------------------------------
// Grab request body — strict
// ----------------------------------------------------------------------------

/**
 * Validator for `POST /api/v1/books/:publicId/grab`. Carries ONLY the opaque
 * `releaseId` from the search response. `.strict()` rejects unknown/extra keys
 * with a 400 v1 envelope — the public contract cannot carry attacker-influenced
 * extras forward.
 */
export const grabV1RequestSchema = z
  .object({
    releaseId: z.string().min(1),
  })
  .strict();

export type GrabV1Request = z.infer<typeof grabV1RequestSchema>;

// ----------------------------------------------------------------------------
// Projector — SearchResult-shaped source -> public Release DTO
// ----------------------------------------------------------------------------

/**
 * Minimal structural shape `toReleaseV1` reads. The core `SearchResult`
 * (`src/core/indexers/types.ts`) is structurally assignable to this — declaring
 * it here keeps the shared schema layer free of core imports while the projector
 * still accepts the real search result.
 */
export interface ReleaseV1Source {
  title: string;
  author?: string | undefined;
  narrator?: string | undefined;
  protocol: 'torrent' | 'usenet';
  downloadUrl?: string | undefined;
  infoHash?: string | undefined;
  guid?: string | undefined;
  indexerId?: number | undefined;
  indexer: string;
  size?: number | undefined;
  seeders?: number | undefined;
  isFreeleech?: boolean | undefined;
  matchScore?: number | undefined;
}

/**
 * Project a search result to the public `ReleaseV1` DTO. The identity + grab
 * fields are packed into the opaque `releaseId` (so they stay out of the visible
 * contract); the display fields are surfaced directly. A result with no
 * `downloadUrl` (parse normally drops these) encodes an empty string — such a
 * release is not grabbable, but real indexer results always carry a URL.
 */
export function toReleaseV1(r: ReleaseV1Source): ReleaseV1 {
  return {
    releaseId: encodeReleaseId({
      downloadUrl: r.downloadUrl ?? '',
      title: r.title,
      protocol: r.protocol,
      ...(r.guid !== undefined && { guid: r.guid }),
      ...(r.infoHash !== undefined && { infoHash: r.infoHash }),
      ...(r.indexerId !== undefined && { indexerId: r.indexerId }),
      ...(r.size !== undefined && { size: r.size }),
      ...(r.seeders !== undefined && { seeders: r.seeders }),
      ...(r.isFreeleech !== undefined && { isFreeleech: r.isFreeleech }),
    }),
    title: r.title,
    author: r.author ?? null,
    narrator: r.narrator ?? null,
    protocol: r.protocol,
    size: r.size ?? null,
    seeders: r.seeders ?? null,
    indexer: r.indexer,
    isFreeleech: r.isFreeleech ?? false,
    matchScore: r.matchScore ?? null,
  };
}
