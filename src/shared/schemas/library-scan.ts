import { z } from 'zod';
import { recordingVerdictSchema } from './recording-verdict.js';

// ============================================================================
// Library scan / import schemas
// ============================================================================

export const importModeSchema = z.enum(['copy', 'move']);
export type ImportMode = z.infer<typeof importModeSchema>;

export const scanDirectoryBodySchema = z.object({
  path: z.string().trim().min(1, 'path is required'),
});

export const duplicateReasonSchema = z.enum(['path', 'slug', 'within-scan']);
export type DuplicateReason = z.infer<typeof duplicateReasonSchema>;

export const discoveredBookSchema = z.object({
  path: z.string(),
  parsedTitle: z.string(),
  parsedAuthor: z.string().nullable(),
  parsedSeries: z.string().nullable(),
  parsedSeriesPosition: z.number().optional(),
  fileCount: z.number(),
  totalSize: z.number(),
  isDuplicate: z.boolean(),
  existingBookId: z.number().optional(),
  duplicateReason: duplicateReasonSchema.optional(),
  duplicateFirstPath: z.string().optional(),
  previewUrl: z.string().optional(),
  /**
   * Surfaces a discovery-time heuristic warning to the import UI when content
   * was absorbed but might warrant a second look (e.g. bonus subdirectory
   * swept into a chapter book). Display-only — does not block import.
   */
  reviewReason: z.string().optional(),
  /**
   * Recording-identity verdict for a library hit (#1712), threaded from the match
   * job onto the row via `mergeMatchIntoRow`. Drives the three-way import-review
   * badge in `ImportCard` (Already owned / New version of an owned title / Possible
   * duplicate). Absent for a genuinely new book and for scan-time DB duplicates.
   */
  recordingVerdict: recordingVerdictSchema.optional(),
});

export type DiscoveredBook = z.infer<typeof discoveredBookSchema>;

export const scanResultSchema = z.object({
  discoveries: z.array(discoveredBookSchema),
  totalFolders: z.number(),
});

export const importConfirmItemSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1),
  authorName: z.string().optional(),
  seriesName: z.string().optional(),
  narrators: z.array(z.string().trim().min(1)).optional(),
  seriesPosition: z.number().optional(),
  coverUrl: z.string().optional(),
  asin: z.string().optional(),
  // BookMetadata pass-through — validated upstream by the metadata provider, not here
  metadata: z.unknown().optional(),
  // When true, bypasses the title+author safety-net duplicate check in confirmImport()
  forceImport: z.boolean().optional(),
});

/**
 * A confirm/import item held back for recording review (#1711). The recording
 * resolver returned `review`/no-signal (or an ambiguous path-owner cardinality),
 * so the item is NOT copied/overwritten and NOT enqueued — it is reported to the
 * UI so the user can re-confirm it with `forceImport=true`. `path` is the item
 * identity (equals `importConfirmItemSchema.path`).
 */
export const heldReviewItemSchema = z.object({
  path: z.string(),
  title: z.string(),
  reason: z.enum(['recording-review-required']),
  existingBookId: z.number().optional(),
});
export type HeldReviewItem = z.infer<typeof heldReviewItemSchema>;

/**
 * A confirm/import item that was NOT accepted because it is already accounted for
 * (#1822). `already-in-library` = the recording is already owned (same-recording
 * dedup or an ASIN-race create collision); `already-importing` = an active import
 * job already exists for the incumbent. Reported to the UI so a no-op import is
 * surfaced as an amber "already in your library" outcome, not a green success.
 * `path` is the item identity (equals `importConfirmItemSchema.path`).
 */
export const importSkipReasonSchema = z.enum(['already-in-library', 'already-importing']);
export type ImportSkipReason = z.infer<typeof importSkipReasonSchema>;

export const importSkippedItemSchema = z.object({
  path: z.string(),
  title: z.string(),
  reason: importSkipReasonSchema,
  existingBookId: z.number().optional(),
  existingTitle: z.string().optional(),
});
export type ImportSkippedItem = z.infer<typeof importSkippedItemSchema>;

/**
 * A confirm/import item that hard-failed at confirm time (#1822) — e.g. a DB error
 * creating the placeholder. `message` is user-facing text (never a raw error/DB
 * constraint dump); the precise error is in the server logs. Surfaced to the UI as
 * a red failure so the user is not told a failed import succeeded.
 */
export const importFailedItemSchema = z.object({
  path: z.string(),
  title: z.string(),
  message: z.string(),
});
export type ImportFailedItem = z.infer<typeof importFailedItemSchema>;

/**
 * The confirm/import result (#1711, #1822). `accepted` counts enqueued imports;
 * `heldReview` carries the review-verdict items; `skipped` carries the
 * already-owned/already-importing no-ops; `failed` carries confirm-time hard
 * failures (all empty arrays when nothing of that kind occurred). The invariant
 * `accepted + heldReview + skipped + failed === items.length` holds — every
 * confirmed item lands in exactly one bucket. Route status stays 200: a partial
 * (or entirely non-accepted) outcome is a reported disposition, not an HTTP error.
 */
export const importResultSchema = z.object({
  accepted: z.number(),
  heldReview: z.array(heldReviewItemSchema),
  skipped: z.array(importSkippedItemSchema),
  failed: z.array(importFailedItemSchema),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const importConfirmBodySchema = z.object({
  books: z.array(importConfirmItemSchema).min(1, 'books array is required'),
  mode: importModeSchema.optional(),
});

export const matchCandidateSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1),
  author: z.string().optional(),
});

export const matchStartBodySchema = z.object({
  books: z.array(matchCandidateSchema).min(1, 'books array is required'),
});

export const jobIdParamSchema = z.object({
  jobId: z.string().trim().min(1),
});

// ============================================================================
// Scan debug schemas
// ============================================================================

export const scanDebugBodySchema = z.object({
  folderName: z
    .string()
    .trim()
    .min(1, 'folderName is required and must be a non-empty string')
    .max(1024, 'folderName must be at most 1024 characters'),
});
export type ScanDebugBody = z.infer<typeof scanDebugBodySchema>;

const cleanNameStepSchema = z.object({
  name: z.string(),
  output: z.string(),
});

const cleanNameTraceSchema = z.object({
  input: z.string(),
  steps: z.array(cleanNameStepSchema),
  result: z.string(),
});

const searchResultItemSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  asin: z.string().nullable(),
  providerId: z.string().nullable(),
});

export const scanDebugTraceSchema = z.object({
  input: z.string(),
  parts: z.array(z.string()),
  parsing: z.object({
    pattern: z.string(),
    raw: z.object({
      author: z.string().nullable(),
      title: z.string(),
      series: z.string().nullable(),
      seriesPosition: z.number().nullable(),
      asin: z.string().nullable(),
    }),
  }),
  cleaning: z.record(z.string(), cleanNameTraceSchema),
  search: z.object({
    directLookup: z.object({
      asin: z.string(),
      hit: z.boolean(),
    }).nullable(),
    initialQuery: z.string(),
    initialResultCount: z.number(),
    swapRetry: z.boolean(),
    swapQuery: z.string().nullable(),
    results: z.array(searchResultItemSchema),
  }).nullable(),
  match: z.object({
    status: z.enum(['matched', 'no match']),
    selected: searchResultItemSchema.nullable(),
  }).nullable(),
  duplicate: z.object({
    isDuplicate: z.boolean(),
    existingBookId: z.number().nullable(),
    reason: z.string().nullable(),
  }).nullable(),
});
export type ScanDebugTrace = z.infer<typeof scanDebugTraceSchema>;
