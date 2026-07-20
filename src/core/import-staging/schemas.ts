import { z } from 'zod';
import { importConfirmItemSchema, importModeSchema, importSkipReasonSchema } from '../../shared/schemas/library-scan.js';
import type { ImportMode } from '../../shared/schemas/library-scan.js';
import { AuthorRefSchema, SeriesRefSchema, BookMetadataSchema } from '../metadata/schemas.js';

// ============================================================================
// Staged import submission — inert chunked upload / finalize / server-owned
// async processing (#1893).
//
// Layer placement (F44): `src/core` may import `src/shared` but not vice-versa,
// and both client + server may import `src/core`. Every staged wire schema that
// references the staged item therefore lives HERE (core), importing the retained
// shared base `importConfirmItemSchema`. No `src/shared` file imports this module.
//
// This repo's Zod default STRIPS unknown keys (compat-surface-zod-strip-not-strict);
// narratorr owns this contract, so every wire schema is `.strict()`.
// ============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Upper bound on `expectedCount` — bounds create payloads and the finalize gaps report. */
export const EXPECTED_COUNT_MAX = 10_000;

/**
 * Hard cumulative cap on staged JSON bytes a single submission may persist (F58).
 * `expectedCount ≤ 10_000` × up to ~900 KiB/item would allow ~8.58 GiB of staged
 * JSON without this backstop. 64 MiB comfortably clears a realistic 10k-item
 * metadata payload while bounding the pathological disk-exhaustion case.
 */
export const MAX_SUBMISSION_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Max entries in a finalize gaps report before it is truncated (F47). */
export const FINALIZE_GAPS_REPORT_MAX = 100;

// ---------------------------------------------------------------------------
// Enums (DB text-enum columns + Zod; guarded by `.options ↔ enumValues` tests)
// ---------------------------------------------------------------------------

export const SUBMISSION_STATUSES = ['receiving', 'processing', 'complete'] as const;
export const submissionStatusSchema = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const ITEM_DISPOSITIONS = ['pending', 'accepted', 'held', 'skipped', 'failed'] as const;
export const itemDispositionSchema = z.enum(ITEM_DISPOSITIONS);
export type ItemDisposition = z.infer<typeof itemDispositionSchema>;

export const SUBMISSION_SOURCES = ['library', 'manual'] as const;
export const submissionSourceSchema = z.enum(SUBMISSION_SOURCES);
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;

// ---------------------------------------------------------------------------
// Typed error codes (named so contracts are unique + testable)
// ---------------------------------------------------------------------------

export const SUBMISSION_ERROR_CODES = {
  /** create: same clientSubmissionId, different digest → 409 */
  digestConflict: 'submission-digest-conflict',
  /** PUT: ordinal < 0 or ≥ expectedCount → 400 (single status, F43) */
  ordinalOutOfRange: 'ordinal-out-of-range',
  /** PUT: duplicate ordinals within one request → 409, no partial write */
  ordinalConflict: 'ordinal-conflict',
  /** PUT: conflicting content for an already-stored ordinal → 409 */
  ordinalContentConflict: 'ordinal-content-conflict',
  /** PUT: metadata/item over `stagedBookMetadataSchema` bounds → 400 */
  itemInvalid: 'item-invalid',
  /** PUT: submission not in 'receiving' → 409 */
  submissionNotReceiving: 'submission-not-receiving',
  /** PUT: would push receivedBytes over MAX_SUBMISSION_BYTES → 413 (F58) */
  byteBudgetExceeded: 'submission-byte-budget-exceeded',
  /** finalize: missing ordinals → 409 with bounded gaps report (F47) */
  finalizeGaps: 'finalize-gaps',
  /** finalize: recomputed digest mismatch → 409, no state change */
  digestMismatch: 'submission-digest-mismatch',
} as const;
export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[keyof typeof SUBMISSION_ERROR_CODES];

// ---------------------------------------------------------------------------
// Bounded staged metadata (F27 / F34) — strict, bounded derivative that COMPOSES
// the canonical BookMetadataSchema / AuthorRefSchema / SeriesRefSchema via
// `.extend()` rather than re-declaring their fields (ZOD-2 / F6). Because it is
// built on the canonical `.shape`, a future canonical field can never be silently
// omitted from hashing/persistence — the key-set test asserts the shapes stay
// aligned, and `.extend()` only overrides the per-field validators to add bounds.
// ---------------------------------------------------------------------------

const ID_MAX = 64;       // asin/isbn/goodreadsId/providerId + array-element identifiers
const SHORT_TEXT_MAX = 512; // title/subtitle/publisher/publishedDate/language/formatType/contentDeliveryType/author name/series name/narrator
const DESCRIPTION_MAX = 8_000;
const COVER_URL_MAX = 2_048;
const GENRE_ELEMENT_MAX = 128;

const stagedAuthorRefSchema = AuthorRefSchema.extend({
  name: z.string().trim().min(1).max(SHORT_TEXT_MAX),
  asin: z.string().max(ID_MAX).optional(),
}).strict();

const stagedSeriesRefSchema = SeriesRefSchema.extend({
  name: z.string().max(SHORT_TEXT_MAX),
  position: z.number().finite().optional(),
  asin: z.string().max(ID_MAX).optional(),
}).strict();

export const stagedBookMetadataSchema = BookMetadataSchema.extend({
  asin: z.string().max(ID_MAX).optional(),
  alternateAsins: z.array(z.string().max(ID_MAX)).max(32).optional(),
  isbn: z.string().max(ID_MAX).optional(),
  goodreadsId: z.string().max(ID_MAX).optional(),
  providerId: z.string().max(ID_MAX).optional(),
  title: z.string().trim().min(1).max(SHORT_TEXT_MAX),
  subtitle: z.string().max(SHORT_TEXT_MAX).optional(),
  authors: z.array(stagedAuthorRefSchema).min(1).max(64),
  narrators: z.array(z.string().max(SHORT_TEXT_MAX)).max(64).optional(),
  series: z.array(stagedSeriesRefSchema).max(32).optional(),
  seriesPrimary: stagedSeriesRefSchema.optional(),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  publisher: z.string().max(SHORT_TEXT_MAX).optional(),
  publishedDate: z.string().max(SHORT_TEXT_MAX).optional(),
  language: z.string().max(SHORT_TEXT_MAX).optional(),
  coverUrl: z.string().url().max(COVER_URL_MAX).optional(),
  duration: z.number().finite().optional(),
  genres: z.array(z.string().max(GENRE_ELEMENT_MAX)).max(64).optional(),
  relevance: z.number().finite().optional(),
  formatType: z.string().max(SHORT_TEXT_MAX).optional(),
  contentDeliveryType: z.string().max(SHORT_TEXT_MAX).optional(),
}).strict();
export type StagedBookMetadata = z.infer<typeof stagedBookMetadataSchema>;

/** The canonical metadata key-set the staged schema must stay aligned with (F6). */
export const CANONICAL_METADATA_KEYS = Object.keys(BookMetadataSchema.shape).sort();

/**
 * The canonical staged item — SINGLE source for client hashing, PUT validation,
 * server hashing, ordinal content-equality, DB persistence (`itemPayload`), and
 * runner input reconstruction. Derives from the retained shared base's
 * non-metadata field shape and refines `metadata` to the bounded schema.
 */
export const stagedImportItemSchema = importConfirmItemSchema
  .omit({ metadata: true })
  .extend({ metadata: stagedBookMetadataSchema.optional() })
  .strict();
export type StagedImportItem = z.infer<typeof stagedImportItemSchema>;

// ---------------------------------------------------------------------------
// Shared identifier validators (F56/F57) — the SAME validators govern create
// bodies AND the `:clientSubmissionId` path param so the contracts cannot drift.
// ---------------------------------------------------------------------------

/** A real UUID (rejects 36-hyphen / misplaced-hyphen / bad version-variant values, F57). */
export const clientSubmissionIdSchema = z.string().uuid();
/** Exactly 64 lowercase hex chars (SHA-256). */
export const payloadDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'payloadDigest must be 64 lowercase hex characters');
export const expectedCountSchema = z.number().int().min(1).max(EXPECTED_COUNT_MAX);

// ---------------------------------------------------------------------------
// Request wire schemas
// ---------------------------------------------------------------------------

const createSubmissionCommon = {
  clientSubmissionId: clientSubmissionIdSchema,
  payloadDigest: payloadDigestSchema,
  expectedCount: expectedCountSchema,
};

/** create body — source/mode discriminated union (library ⇒ no mode; manual ⇒ mode). */
export const createSubmissionBodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('library'), ...createSubmissionCommon }).strict(),
  z.object({ source: z.literal('manual'), mode: importModeSchema, ...createSubmissionCommon }).strict(),
]);
export type CreateSubmissionBody = z.infer<typeof createSubmissionBodySchema>;

/** PUT row — `{ ordinal, item }` where `item` is the WHOLE staged item (no top-level path/title). */
export const putItemRowSchema = z
  .object({
    ordinal: z.number().int(),
    item: stagedImportItemSchema,
  })
  .strict();
export type PutItemRow = z.infer<typeof putItemRowSchema>;

export const putItemsBodySchema = z
  .object({
    items: z.array(putItemRowSchema).min(1),
  })
  .strict();
export type PutItemsBody = z.infer<typeof putItemsBodySchema>;

/**
 * GET query — `includeItems` arrives as the STRING `"true"`/`"false"` from Fastify
 * (F71). Enum-to-boolean transform, omitted default = `false` (summary is the safe
 * cheap default; the client explicitly passes `true` for the one-time detail fetch).
 */
export const submissionQuerySchema = z
  .object({
    includeItems: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .strict();
export type SubmissionQuery = z.infer<typeof submissionQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/** Bounded gaps report for a finalize with missing ordinals (F47). */
export const finalizeGapsSchema = z
  .object({
    missing: z.array(z.number().int()).max(FINALIZE_GAPS_REPORT_MAX),
    totalMissing: z.number().int(),
    truncated: z.boolean(),
  })
  .strict();
export type FinalizeGaps = z.infer<typeof finalizeGapsSchema>;

/**
 * A per-item result row — strict discriminated union keyed by `disposition` (a
 * plain `.strict()` object still admits impossible field combos, so a union is
 * required — F42). `path`/`title` are always present (projected columns survive
 * `itemPayload` nulling).
 */
export const stagedItemResultDtoSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('pending'), ordinal: z.number().int(), path: z.string(), title: z.string() }).strict(),
  z
    .object({
      disposition: z.literal('accepted'),
      ordinal: z.number().int(),
      path: z.string(),
      title: z.string(),
      bookId: z.number().int().nullable(),
      item: stagedImportItemSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal('held'),
      ordinal: z.number().int(),
      path: z.string(),
      title: z.string(),
      reason: z.literal('recording-review-required'),
      existingBookId: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal('skipped'),
      ordinal: z.number().int(),
      path: z.string(),
      title: z.string(),
      reason: importSkipReasonSchema,
      existingBookId: z.number().int().optional(),
      existingTitle: z.string().optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal('failed'),
      ordinal: z.number().int(),
      path: z.string(),
      title: z.string(),
      message: z.string(),
    })
    .strict(),
]);
export type StagedItemResultDto = z.infer<typeof stagedItemResultDtoSchema>;

const submissionAggregatesSchema = z
  .object({
    accepted: z.number().int(),
    held: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
  })
  .strict();
export type SubmissionAggregates = z.infer<typeof submissionAggregatesSchema>;

/**
 * The single disposition→aggregate mapping (F13). Both the runner's terminal
 * `maybeComplete` freeze and the service's live `computeProgress` counts call
 * THIS function, so pre-complete and post-complete progress can never disagree.
 * Only terminal dispositions contribute; `pending` is ignored.
 */
export function aggregateDispositions(dispositions: readonly ItemDisposition[]): SubmissionAggregates {
  const agg: SubmissionAggregates = { accepted: 0, held: 0, skipped: 0, failed: 0 };
  for (const d of dispositions) {
    if (d === 'accepted') agg.accepted++;
    else if (d === 'held') agg.held++;
    else if (d === 'skipped') agg.skipped++;
    else if (d === 'failed') agg.failed++;
  }
  return agg;
}

const submissionHeaderFields = {
  id: z.number().int().positive(),
  clientSubmissionId: z.string(),
  source: submissionSourceSchema,
  mode: importModeSchema.optional(),
  status: submissionStatusSchema,
  expectedCount: z.number().int(),
  receivedCount: z.number().int(),
  processedCount: z.number().int(),
  aggregates: submissionAggregatesSchema,
  detailsPruned: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
};

/**
 * The query-selected response — one strict schema, three cells (F64):
 *  - summary request → `itemsIncluded:false`, no `items` (even while `detailsPruned:false`)
 *  - detail + retained → `itemsIncluded:true`, `items` present
 *  - detail + pruned → `itemsIncluded:false`, no `items`
 * The `itemsIncluded` discriminant drives `items` presence EXACTLY. Two further
 * cross-field invariants are enforced by refinement so the schema admits ONLY the
 * legal protocol arms (F4): (a) source/mode discrimination — `library` carries no
 * `mode`, `manual` requires one; (b) the detail arm (`itemsIncluded:true`) forbids
 * `detailsPruned:true` (a pruned record has no items to include).
 */
export const submissionResponseSchema = z
  .discriminatedUnion('itemsIncluded', [
    z.object({ ...submissionHeaderFields, itemsIncluded: z.literal(false) }).strict(),
    z
      .object({
        ...submissionHeaderFields,
        itemsIncluded: z.literal(true),
        items: z.array(stagedItemResultDtoSchema),
      })
      .strict(),
  ])
  .superRefine((val, ctx) => {
    if (val.source === 'manual' && val.mode === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'manual submissions require a mode' });
    }
    if (val.source === 'library' && val.mode !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'library submissions must not carry a mode' });
    }
    if (val.itemsIncluded === true && val.detailsPruned === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['detailsPruned'], message: 'itemsIncluded:true requires detailsPruned:false' });
    }
  });
export type SubmissionResponse = z.infer<typeof submissionResponseSchema>;

// ---------------------------------------------------------------------------
// Canonical digest serialization (client at create ⇄ server at finalize)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export interface SubmissionDigestInput {
  source: SubmissionSource;
  /** literal string for `manual`; the JSON key is ABSENT (not null) for `library`. */
  mode?: ImportMode;
  items: StagedImportItem[];
}

/**
 * Canonical JSON over `{ source, mode?, items }`: every object's keys emitted in
 * sorted order (recursively), `undefined` dropped, the `items` array order
 * significant, and the `mode` key absent for `library`. Hashing (SHA-256, hex) is
 * done per-environment (Web Crypto on the client, node:crypto on the server) over
 * this identical string.
 */
export function serializeSubmissionForDigest(input: SubmissionDigestInput): string {
  const payload: Record<string, unknown> = { source: input.source, items: input.items };
  if (input.source === 'manual') payload.mode = input.mode;
  return JSON.stringify(canonicalize(payload));
}
