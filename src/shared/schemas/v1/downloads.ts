import { z } from 'zod';
import { clientStatusSchema, pipelineStageSchema, downloadStatusSchema, type ClientStatus, type PipelineStage } from '../activity.js';
import { deriveDisplayStatus } from '../../download-status-registry.js';
import { v1PaginationParamsSchema } from './common.js';

// ============================================================================
// Public API v1 — Downloads / activity (read) (S5 — #1451)
// ============================================================================
//
// The public contract for the download (activity) resource: the wire DTO that
// hides every internal column (numeric rowid, FK columns, grab/info-hash/url
// internals, output path, cleanup/grab snapshots, timestamps-as-Date) plus the
// `bk_` book cross-reference, the pagination-only (strict) list-query validator,
// and the `toDownloadV1` projector. Like the Books surface (#1449) these are
// schemas narratorr OWNS, so they are `.strict()` — the OPPOSITE of the
// prowlarr-compat surface (learning `compat-surface-zod-strip-not-strict`,
// #1198). `.strict()` is what makes the response boundary FAIL CLOSED: a
// projector regression that leaks an internal field is rejected at
// serialization, not silently stripped and shipped.
//
// Status: the DTO exposes BOTH canonical axes (`clientStatus`, `pipelineStage`)
// AND the derived single `status` (via `deriveDisplayStatus`) — the epic's
// locked decision is "Status = real DB re-model", and the derived single status
// keeps simple consumers from re-implementing the projection.

// ----------------------------------------------------------------------------
// Item schema (response DTO) — strict, fail-closed
// ----------------------------------------------------------------------------

/** The book cross-reference on a download: opaque `bk_` publicId only, or `null`
 *  when the download has no linked book. `.strict()` so a leaked numeric rowid or
 *  any other internal `BookRow` column fails serialization. */
export const downloadV1BookSchema = z
  .object({ id: z.string() })
  .strict()
  .nullable();

/**
 * The public Download DTO. Exposes ONLY the documented public fields. `.strict()`
 * is load-bearing: it is what makes Fastify response-schema enforcement fail
 * closed on any internal field a projector regression might leak (nested
 * `.strict()` on the book cross-ref catches nested leaks too). Dates are ISO 8601
 * strings per the v1 wire convention (`common.ts`).
 */
export const downloadV1Schema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: downloadStatusSchema,
    clientStatus: clientStatusSchema,
    pipelineStage: pipelineStageSchema,
    book: downloadV1BookSchema,
    protocol: z.enum(['torrent', 'usenet']),
    progress: z.number(),
    addedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();

export type DownloadV1 = z.infer<typeof downloadV1Schema>;

// ----------------------------------------------------------------------------
// List query validator — pagination-only strict
// ----------------------------------------------------------------------------

/**
 * Validator for `GET /api/v1/downloads` query params: the v1 pagination building
 * block (limit/offset) made `.strict()` so unknown params (a misspelled
 * `cursor`, a snake_case `sort_by`) are REJECTED with a 400, not silently
 * stripped. No status/section filter or sort params — those are deferred to a
 * follow-up (see the story's Out of scope).
 */
export const downloadV1ListQuerySchema = v1PaginationParamsSchema.strict();

export type DownloadV1ListQuery = z.infer<typeof downloadV1ListQuerySchema>;

// ----------------------------------------------------------------------------
// Projector — hydrated row -> public DTO
// ----------------------------------------------------------------------------

/**
 * Minimal structural shape `toDownloadV1` reads. The server's hydrated
 * `DownloadWithBook` row (from `DownloadService.getAll()` / `getById()`) is
 * structurally assignable to this — declaring it here keeps the shared schema
 * layer free of server imports while the projector still accepts the real row.
 * `book` is the left-joined `BookRow` (or absent when `bookId` is null /
 * the book was deleted via `onDelete: 'set null'`).
 */
export interface DownloadV1Source {
  publicId: string;
  title: string;
  clientStatus: ClientStatus;
  pipelineStage: PipelineStage;
  protocol: 'torrent' | 'usenet';
  progress: number;
  addedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  book?: { publicId: string };
}

/**
 * Project a hydrated download row to the public `DownloadV1` DTO. Strips every
 * internal column (numeric rowid, `bookId`/`indexerId`/`downloadClientId` FKs,
 * `infoHash`/`downloadUrl`/`guid`/`externalId`/`outputPath`, `bookStatusAtGrab`,
 * `pendingCleanup`/`progressUpdatedAt`, `indexerName`) by emitting ONLY the
 * public fields. `id` and the `book` cross-ref are opaque `publicId`s, never a
 * numeric rowid. `status` is derived from the canonical `(clientStatus,
 * pipelineStage)` tuple; both axes are also exposed. Dates are converted to ISO
 * 8601 strings here (`completedAt` is `null` when the source is null).
 */
export function toDownloadV1(row: DownloadV1Source): DownloadV1 {
  return {
    id: row.publicId,
    title: row.title,
    status: deriveDisplayStatus(row.clientStatus, row.pipelineStage),
    clientStatus: row.clientStatus,
    pipelineStage: row.pipelineStage,
    book: row.book ? { id: row.book.publicId } : null,
    protocol: row.protocol,
    progress: row.progress,
    addedAt: row.addedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    errorMessage: row.errorMessage,
  };
}
