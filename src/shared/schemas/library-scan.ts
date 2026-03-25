import { z } from 'zod';

// ============================================================================
// Library scan / import schemas
// ============================================================================

export const importModeSchema = z.enum(['copy', 'move']);
export type ImportMode = z.infer<typeof importModeSchema>;

export const scanSingleBodySchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const scanDirectoryBodySchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const importConfirmItemSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  authorName: z.string().optional(),
  seriesName: z.string().optional(),
  coverUrl: z.string().optional(),
  asin: z.string().optional(),
  // BookMetadata pass-through — validated upstream by the metadata provider, not here
  metadata: z.unknown().optional(),
  // When true, bypasses the title+author safety-net duplicate check in confirmImport()
  forceImport: z.boolean().optional(),
});

export const importSingleBodySchema = importConfirmItemSchema.extend({
  mode: importModeSchema.optional(),
});

export const importConfirmBodySchema = z.object({
  books: z.array(importConfirmItemSchema).min(1, 'books array is required'),
  mode: importModeSchema.optional(),
});

export const matchCandidateSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  author: z.string().optional(),
});

export const matchStartBodySchema = z.object({
  books: z.array(matchCandidateSchema).min(1, 'books array is required'),
});

export const jobIdParamSchema = z.object({
  jobId: z.string().min(1),
});
