import { z } from 'zod';
import { bookStatusSchema } from './book.js';

export const libraryBookListItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  coverUrl: z.string().nullable(),
  status: bookStatusSchema,

  seriesName: z.string().nullable(),
  seriesPosition: z.number().nullable(),

  authors: z.array(z.object({ name: z.string() })),
  narrators: z.array(z.object({ name: z.string() })),

  audioTotalSize: z.number().nullable(),
  size: z.number().nullable(),
  audioFileFormat: z.string().nullable(),

  audioDuration: z.number().nullable(),
  duration: z.number().nullable(),

  path: z.string().nullable(),
  audioFileCount: z.number().nullable(),

  lastGrabGuid: z.string().nullable(),
  lastGrabInfoHash: z.string().nullable(),

  collapsedCount: z.number().optional(),

  editionLabel: z.string().nullable().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LibraryBookListItem = z.infer<typeof libraryBookListItemSchema>;

export interface LibraryBookListResponse {
  data: LibraryBookListItem[];
  total: number;
}
