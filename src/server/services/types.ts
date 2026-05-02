import type { books, downloads } from '../../db/schema.js';
import type { BookStatus, EnrichmentStatus } from '../../shared/schemas/book.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';

// Drizzle's $inferSelect widens enum columns to bare `string` (CLAUDE.md gotcha).
// Re-narrow the status / enrichmentStatus columns so callers can consume
// `book.status` directly without re-asserting `as BookStatus`.
// Canonical home — do not redeclare per-file.
export type BookRow = Omit<typeof books.$inferSelect, 'status' | 'enrichmentStatus'> & {
  status: BookStatus;
  enrichmentStatus: EnrichmentStatus;
};

export type DownloadRow = Omit<typeof downloads.$inferSelect, 'status' | 'protocol'> & {
  status: DownloadStatus;
  protocol: 'torrent' | 'usenet';
};
