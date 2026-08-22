import { z } from 'zod';
import { recordingVerdictSchema } from './recording-verdict.js';

export const importModeSchema = z.enum(['copy', 'move']);
export type ImportMode = z.infer<typeof importModeSchema>;

export const scanDirectoryBodySchema = z.object({
  path: z.string().trim().min(1, 'path is required'),
});

export const duplicateReasonSchema = z.enum(['path', 'slug']);
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
  // #2091: the incumbent's own folder, carried only for `slug` duplicates so the review list can
  // name what this folder duplicates. A `path` duplicate IS the incumbent's folder, so it has none.
  existingPath: z.string().optional(),
  previewUrl: z.string().optional(),
  // Display-only discovery warning; it does not block import.
  reviewReason: z.string().optional(),
  // Absent for new books and scan-time DB duplicates; library matches use it for review.
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
  // BookMetadata is validated by the provider before this pass-through boundary.
  metadata: z.unknown().optional(),
  // Bypasses the title-and-author duplicate safety check.
  forceImport: z.boolean().optional(),
});

// Review-held items are neither copied nor enqueued; clients may resubmit with forceImport.
export const heldReviewItemSchema = z.object({
  path: z.string(),
  title: z.string(),
  reason: z.enum(['recording-review-required']),
  existingBookId: z.number().optional(),
});
export type HeldReviewItem = z.infer<typeof heldReviewItemSchema>;

// already-in-library includes recording dedup and ASIN-race collisions;
// already-importing means an active job owns the item. duplicate-copy-at-other-path (#2091)
// narrows the first: the same recording, but the incumbent's folder is not this one.
export const importSkipReasonSchema = z.enum([
  'already-in-library',
  'already-importing',
  'duplicate-copy-at-other-path',
]);
export type ImportSkipReason = z.infer<typeof importSkipReasonSchema>;

export const matchCandidateSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1),
  author: z.string().optional(),
  seriesPosition: z.number().optional(),
});

export const matchStartBodySchema = z.object({
  books: z.array(matchCandidateSchema).min(1, 'books array is required'),
});

export const jobIdParamSchema = z.object({
  jobId: z.string().trim().min(1),
});

export const scanDebugBodySchema = z.object({
  folderName: z
    .string()
    .trim()
    .min(1, 'folderName is required and must be a non-empty string')
    .max(1024, 'folderName must be at most 1024 characters'),
});
export type ScanDebugBody = z.infer<typeof scanDebugBodySchema>;

// scannedSeconds is the raw, unrounded scanner runtime.
export const durationCorroborationBodySchema = z.object({
  asin: z.string().trim().min(1, 'asin is required'),
  scannedSeconds: z.number().positive('scannedSeconds must be a positive number of seconds'),
});
export type DurationCorroborationBody = z.infer<typeof durationCorroborationBodySchema>;

// chapterSeconds is omitted without a usable full runtime. trimmedChapterSeconds
// appears only for a distinct promotional-tail-trimmed runtime; either may corroborate.
export interface DurationCorroborationResult {
  corroborated: boolean;
  chapterSeconds?: number;
  trimmedChapterSeconds?: number;
}

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
