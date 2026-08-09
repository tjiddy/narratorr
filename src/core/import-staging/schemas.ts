import { z } from 'zod';
import { importConfirmItemSchema, importModeSchema, importSkipReasonSchema } from '@shared/schemas/library-scan.js';
import type { ImportMode } from '@shared/schemas/library-scan.js';
import { AuthorRefSchema, SeriesRefSchema, BookMetadataSchema } from '../metadata/schemas.js';

// Staged wire schemas live in core so client and server can compose the shared import base.
// Narratorr-owned schemas are strict because Zod otherwise strips unknown keys.

/** Upper bound on `expectedCount` — bounds create payloads and the finalize gaps report. */
export const EXPECTED_COUNT_MAX = 10_000;

/**
 * Caps cumulative staged JSON at 64 MiB; the per-item and count limits alone permit
 * roughly 8.58 GiB, while realistic 10k-item metadata remains below this backstop.
 */
export const MAX_SUBMISSION_BYTES = 64 * 1024 * 1024;

export const FINALIZE_GAPS_REPORT_MAX = 100;

export const SUBMISSION_STATUSES = ['receiving', 'processing', 'complete'] as const;
export const submissionStatusSchema = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const ITEM_DISPOSITIONS = ['pending', 'accepted', 'held', 'skipped', 'failed'] as const;
export const itemDispositionSchema = z.enum(ITEM_DISPOSITIONS);
export type ItemDisposition = z.infer<typeof itemDispositionSchema>;

export const SUBMISSION_SOURCES = ['library', 'manual'] as const;
export const submissionSourceSchema = z.enum(SUBMISSION_SOURCES);
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;

export const SUBMISSION_ERROR_CODES = {
  /** Create: same clientSubmissionId with a different digest. */
  digestConflict: 'submission-digest-conflict',
  /** PUT ordinal outside [0, expectedCount). */
  ordinalOutOfRange: 'ordinal-out-of-range',
  /** Duplicate PUT ordinals; the request writes nothing. */
  ordinalConflict: 'ordinal-conflict',
  /** PUT content conflicts with an already-stored ordinal. */
  ordinalContentConflict: 'ordinal-content-conflict',
  /** PUT item violates staged metadata bounds. */
  itemInvalid: 'item-invalid',
  /** PUT submission is no longer receiving. */
  submissionNotReceiving: 'submission-not-receiving',
  /** PUT would exceed MAX_SUBMISSION_BYTES. */
  byteBudgetExceeded: 'submission-byte-budget-exceeded',
  /** Finalize has missing ordinals and a bounded gaps report. */
  finalizeGaps: 'finalize-gaps',
  /** Finalize digest mismatch; state remains unchanged. */
  digestMismatch: 'submission-digest-mismatch',
} as const;
export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[keyof typeof SUBMISSION_ERROR_CODES];

// Extend canonical metadata shapes with bounds so future fields cannot disappear from
// hashing or persistence; the key-set test pins alignment.

const ID_MAX = 64; // Provider and array-element identifiers.
const SHORT_TEXT_MAX = 512;
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

/** Canonical key set used to guard staged-schema alignment. */
export const CANONICAL_METADATA_KEYS = Object.keys(BookMetadataSchema.shape).sort();

/**
 * Single staged-item contract for hashing, PUT validation, equality, persistence,
 * and runner reconstruction; only the shared base's metadata shape is replaced.
 */
export const stagedImportItemSchema = importConfirmItemSchema
  .omit({ metadata: true })
  .extend({ metadata: stagedBookMetadataSchema.optional() })
  .strict();
export type StagedImportItem = z.infer<typeof stagedImportItemSchema>;

// Reuse these validators in create bodies and path params to prevent contract drift.

export const clientSubmissionIdSchema = z.string().uuid();
export const payloadDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'payloadDigest must be 64 lowercase hex characters');
export const expectedCountSchema = z.number().int().min(1).max(EXPECTED_COUNT_MAX);

const createSubmissionCommon = {
  clientSubmissionId: clientSubmissionIdSchema,
  payloadDigest: payloadDigestSchema,
  expectedCount: expectedCountSchema,
};

/** Library omits mode; manual requires it. */
export const createSubmissionBodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('library'), ...createSubmissionCommon }).strict(),
  z.object({ source: z.literal('manual'), mode: importModeSchema, ...createSubmissionCommon }).strict(),
]);
export type CreateSubmissionBody = z.infer<typeof createSubmissionBodySchema>;

/** PUT carries the whole staged item; path and title are not duplicated at top level. */
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
 * Fastify supplies includeItems as a string. Omission defaults to the cheap summary arm.
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

export const finalizeGapsSchema = z
  .object({
    missing: z.array(z.number().int()).max(FINALIZE_GAPS_REPORT_MAX),
    totalMissing: z.number().int(),
    truncated: z.boolean(),
  })
  .strict();
export type FinalizeGaps = z.infer<typeof finalizeGapsSchema>;

/**
 * A disposition union prevents impossible field combinations. Projected path and
 * title remain present after itemPayload is nulled.
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
 * Shared by live progress and terminal freezing so aggregates cannot drift;
 * pending contributes nothing.
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
 * itemsIncluded exactly controls items presence across summary, retained-detail,
 * and pruned-detail responses. Refinements also enforce source/mode pairing and
 * forbid included items after detail pruning.
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

/** Standalone summary arm so list responses can name it without the detail union. */
export const submissionSummarySchema = z
  .object({ ...submissionHeaderFields, itemsIncluded: z.literal(false) })
  .strict();
export type SubmissionSummary = z.infer<typeof submissionSummarySchema>;

export const submissionListResponseSchema = z
  .object({ data: z.array(submissionSummarySchema), total: z.number().int() })
  .strict();
export type SubmissionListResponse = z.infer<typeof submissionListResponseSchema>;

/**
 * Coerces query-string pagination to bounded integers; unknown or invalid values
 * feed the route's typed invalid-query response.
 */
export const submissionListQuerySchema = z
  .object({
    source: submissionSourceSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type SubmissionListQuery = z.infer<typeof submissionListQuerySchema>;

export const submissionAttentionQuerySchema = z
  .object({ source: submissionSourceSchema.optional() })
  .strict();
export type SubmissionAttentionQuery = z.infer<typeof submissionAttentionQuerySchema>;

export const submissionAttentionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('abandoned') }).strict(),
  z
    .object({ kind: z.literal('completed-attention'), held: z.number().int(), failed: z.number().int() })
    .strict(),
]);
export type SubmissionAttention = z.infer<typeof submissionAttentionSchema>;

export const attentionSubmissionSchema = z
  .object({ ...submissionHeaderFields, itemsIncluded: z.literal(false), attention: submissionAttentionSchema })
  .strict();
export type AttentionSubmission = z.infer<typeof attentionSubmissionSchema>;

/**
 * data is the newest attention-worthy submission; watch reports any non-terminal
 * submission so the client can poll. Both come from one JSON snapshot.
 */
export const attentionResponseSchema = z
  .object({ data: attentionSubmissionSchema.nullable(), watch: z.boolean() })
  .strict();
export type AttentionResponse = z.infer<typeof attentionResponseSchema>;

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
  /** Literal for manual; the library JSON key is absent, never null. */
  mode?: ImportMode;
  items: StagedImportItem[];
}

/**
 * Canonical JSON recursively sorts object keys, drops undefined, preserves item
 * order, and omits library mode. Client and server hash this identical string.
 */
export function serializeSubmissionForDigest(input: SubmissionDigestInput): string {
  const payload: Record<string, unknown> = { source: input.source, items: input.items };
  if (input.source === 'manual') payload.mode = input.mode;
  return JSON.stringify(canonicalize(payload));
}
