import type {
  blacklist,
  bookEvents,
  books,
  companionEbooks,
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
} from '@db/schema.js';
import type { BookStatus, EnrichmentStatus, ProductionType } from '@shared/schemas/book.js';
import type { ClientStatus, PipelineStage } from '@shared/schemas/activity.js';
import type { BlacklistReason, BlacklistType } from '@shared/schemas/blacklist.js';
import type { DownloadProtocol } from '@core/indexers/types.js';
import type { DownloadClientType } from '@shared/download-client-registry.js';
import type { EventSource, EventType } from '@shared/schemas/event-history.js';
import type {
  ImportJobPhase,
  ImportJobStatus,
  ImportJobType,
} from '@shared/schemas/import-job.js';
import type { ImportListType } from '@shared/import-list-registry.js';
import type { ConnectorType } from '@shared/connector-registry.js';
import type { IndexerType } from '@shared/indexer-registry.js';
import type { NotifierType } from '@shared/notifier-registry.js';
import type { SuggestionReason } from '@shared/schemas/discovery.js';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';

// Drizzle widens text enums to string; re-narrow them once here instead of per caller.
export type BookRow = Omit<typeof books.$inferSelect, 'status' | 'enrichmentStatus' | 'productionType'> & {
  status: BookStatus;
  enrichmentStatus: EnrichmentStatus;
  productionType: ProductionType;
};

/**
 * Serializable row without raw userClearedFields. Internal scoring may use BookRow; behavior that
 * needs tombstones uses hydrated BookDetail. Strip with stripClearedFields.
 */
export type BookRowPublic = Omit<BookRow, 'userClearedFields'>;

// Re-narrow both stored state axes; display status is derived rather than stored.
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

/**
 * The book's CURRENT folder, projected onto every listed event. Renderers compose derived file
 * locations from it (`sidecar_diverged` points at `metadata.opf.bak`) instead of reading a path
 * stored on an append-only row, which would go stale the first time the book is renamed. `null`
 * once the book is deleted and `bookId` is nulled — there is then no folder, which is the truth.
 */
export type BookEventWithPath = BookEventRow & { bookPath: string | null };

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

// Keep validationCode broad until a canonical EpubValidationCode type exists.
export type CompanionEbookRow = Omit<typeof companionEbooks.$inferSelect, 'status'> & {
  status: CompanionEbookStatus;
};

export type SeriesRow = typeof series.$inferSelect;

export type SeriesMemberRow = Omit<typeof seriesMembers.$inferSelect, 'source'> & {
  source: 'hardcover' | 'local';
};
