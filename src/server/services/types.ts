import type {
  blacklist,
  bookEvents,
  books,
  downloadClients,
  downloads,
  importJobs,
  importLists,
  indexers,
  notifiers,
  suggestions,
} from '../../db/schema.js';
import type { BookStatus, EnrichmentStatus } from '../../shared/schemas/book.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BlacklistReason, BlacklistType } from '../../shared/schemas/blacklist.js';
import type { DownloadProtocol } from '../../core/indexers/types.js';
import type { DownloadClientType } from '../../shared/download-client-registry.js';
import type { EventSource, EventType } from '../../shared/schemas/event-history.js';
import type {
  ImportJobPhase,
  ImportJobStatus,
  ImportJobType,
} from '../../shared/schemas/import-job.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import type { IndexerType } from '../../shared/indexer-registry.js';
import type { NotifierType } from '../../shared/notifier-registry.js';
import type { SuggestionReason } from '../../shared/schemas/discovery.js';

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
  protocol: DownloadProtocol;
};

export type IndexerRow = Omit<typeof indexers.$inferSelect, 'type'> & {
  type: IndexerType;
};

export type DownloadClientRow = Omit<typeof downloadClients.$inferSelect, 'type'> & {
  type: DownloadClientType;
};

export type NotifierRow = Omit<typeof notifiers.$inferSelect, 'type'> & {
  type: NotifierType;
};

export type ImportListRow = Omit<typeof importLists.$inferSelect, 'type'> & {
  type: ImportListType;
};

export type BookEventRow = Omit<typeof bookEvents.$inferSelect, 'eventType' | 'source'> & {
  eventType: EventType;
  source: EventSource;
};

export type BlacklistRow = Omit<typeof blacklist.$inferSelect, 'reason' | 'blacklistType'> & {
  reason: BlacklistReason;
  blacklistType: BlacklistType;
};

export type SuggestionStatus = 'pending' | 'added' | 'dismissed';

export type SuggestionRow = Omit<typeof suggestions.$inferSelect, 'reason' | 'status'> & {
  reason: SuggestionReason;
  status: SuggestionStatus;
};

export type ImportJobRow = Omit<typeof importJobs.$inferSelect, 'type' | 'status' | 'phase'> & {
  type: ImportJobType;
  status: ImportJobStatus;
  phase: ImportJobPhase | null;
};
