import { z } from 'zod';

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
  fileCount: z.number(),
  totalSize: z.number(),
  isDuplicate: z.boolean(),
  existingBookId: z.number().optional(),
  duplicateReason: duplicateReasonSchema.optional(),
  duplicateFirstPath: z.string().optional(),
  previewUrl: z.string().optional(),
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
  coverUrl: z.string().optional(),
  asin: z.string().optional(),
  // BookMetadata pass-through — validated upstream by the metadata provider, not here
  metadata: z.unknown().optional(),
  // When true, bypasses the title+author safety-net duplicate check in confirmImport()
  forceImport: z.boolean().optional(),
});

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
  folderName: z.string().trim().min(1, 'folderName is required and must be a non-empty string'),
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
