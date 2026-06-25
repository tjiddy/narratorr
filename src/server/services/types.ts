import type {
  blacklist,
  bookEvents,
  books,
  downloadClients,
  downloads,
  connectors,
  importJobs,
  importLists,
  indexers,
  notifiers,
  series,
  seriesMembers,
  suggestions,
} from '../../db/schema.js';
import type { BookStatus, EnrichmentStatus } from '../../shared/schemas/book.js';
import type { ClientStatus, PipelineStage } from '../../shared/schemas/activity.js';
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
import type { ConnectorType } from '../../shared/connector-registry.js';
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

// Two-axis download state (#1445): narrow both axis columns to their Zod-derived
// unions (Drizzle's $inferSelect widens text-enum columns to `string`). There is
// no `status` column anymore — the display status is derived from the tuple.
export type DownloadRow = Omit<typeof downloads.$inferSelect, 'clientStatus' | 'pipelineStage' | 'protocol' | 'bookStatusAtGrab'> & {
  clientStatus: ClientStatus;
  pipelineStage: PipelineStage;
  protocol: DownloadProtocol;
  bookStatusAtGrab: BookStatus | null;
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

export type ConnectorRow = Omit<typeof connectors.$inferSelect, 'type'> & {
  type: ConnectorType;
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

export type SuggestionRowWithLibraryBookId = SuggestionRow & { libraryBookId: number | null };

export type ImportJobRow = Omit<typeof importJobs.$inferSelect, 'type' | 'status' | 'phase'> & {
  type: ImportJobType;
  status: ImportJobStatus;
  phase: ImportJobPhase | null;
};

export type SeriesRow = typeof series.$inferSelect;

export type SeriesMemberRow = Omit<typeof seriesMembers.$inferSelect, 'source'> & {
  source: 'hardcover' | 'local';
};
