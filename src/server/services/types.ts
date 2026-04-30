import type { books, downloads } from '../../db/schema.js';
import type { BookStatus, EnrichmentStatus } from '../../shared/schemas/book.js';

export type DownloadRow = typeof downloads.$inferSelect;

// Drizzle's $inferSelect widens enum columns to bare `string` (CLAUDE.md gotcha).
// Re-narrow the status / enrichmentStatus columns so callers can consume
// `book.status` directly without re-asserting `as BookStatus`.
// Canonical home — do not redeclare per-file.
export type BookRow = Omit<typeof books.$inferSelect, 'status' | 'enrichmentStatus'> & {
  status: BookStatus;
  enrichmentStatus: EnrichmentStatus;
};
