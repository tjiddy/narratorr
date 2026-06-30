import { z } from 'zod';
import { bookStatusSchema } from './book.js';

// Slim shape for the library list view. Trimmed to what
// LibraryBookCard / LibraryTableView / LibraryGridView / useLibraryFilters /
// pages/library/helpers.ts / useLibraryPageState / LibraryModals /
// DeleteBookModal and the library-launched SearchReleasesModal actually read.
//
// authors/narrators carry only `name` — the first name renders, and the
// per-name client-side filter scans the full array.

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

  // Stored edition_label (#1712): distinguishes two recordings of the same title on
  // the library card. `.nullable().optional()` (like `collapsedCount`) so existing
  // list fixtures/factories that omit the key need no churn — absent and `null` are
  // treated identically (render nothing). The server hydration emits `null` when the
  // column is null.
  editionLabel: z.string().nullable().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LibraryBookListItem = z.infer<typeof libraryBookListItemSchema>;

export interface LibraryBookListResponse {
  data: LibraryBookListItem[];
  total: number;
}
