import { z } from 'zod';
import { v1ListResponseSchema } from './common.js';
import { protocolSchema, type DownloadProtocol } from '../download-protocol.js';

export const releaseTokenPayloadSchema = z
  .object({
    downloadUrl: z.string(),
    title: z.string(),
    protocol: protocolSchema,
    guid: z.string().optional(),
    infoHash: z.string().optional(),
    indexerId: z.number().int().optional(),
    size: z.number().optional(),
    seeders: z.number().optional(),
    isFreeleech: z.boolean().optional(),
  })
  .strict();

export type ReleaseTokenPayload = z.infer<typeof releaseTokenPayloadSchema>;

/** Encode the secret-free canonical body; fixed order and omitted optionals keep signatures stable. */
export function encodeReleaseId(payload: ReleaseTokenPayload): string {
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

/** Decode an HMAC-verified body; this does not verify signatures and returns null on invalid input. */
export function decodeReleaseId(body: string): ReleaseTokenPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = releaseTokenPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// Raw grab identifiers remain inside the opaque releaseId instead of becoming response fields.
export const releaseV1Schema = z
  .object({
    releaseId: z.string(),
    title: z.string(),
    author: z.string().nullable(),
    narrator: z.string().nullable(),
    protocol: protocolSchema,
    size: z.number().nullable(),
    seeders: z.number().nullable(),
    indexer: z.string(),
    isFreeleech: z.boolean(),
    matchScore: z.number().nullable(),
  })
  .strict();

export type ReleaseV1 = z.infer<typeof releaseV1Schema>;

// data and total are post-filter values, not raw indexer results.
export const releaseV1ListResponseSchema = v1ListResponseSchema(releaseV1Schema);

export const grabV1RequestSchema = z
  .object({
    releaseId: z.string().min(1),
  })
  .strict();

export type GrabV1Request = z.infer<typeof grabV1RequestSchema>;

export interface ReleaseV1Source {
  title: string;
  author?: string | undefined;
  narrator?: string | undefined;
  protocol: DownloadProtocol;
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
 * The server injects the signer so this client-importable module stays secret-free.
 * Missing download URLs encode as empty; normal parsing removes those ungrabbable results.
 */
export function toReleaseV1(
  r: ReleaseV1Source,
  signReleaseId: (payload: ReleaseTokenPayload) => string,
): ReleaseV1 {
  return {
    releaseId: signReleaseId({
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
