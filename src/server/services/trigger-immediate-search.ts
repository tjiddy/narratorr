import type { FastifyBaseLogger } from 'fastify';
import { searchAndGrabForBook, buildNarratorPriority, buildSearchFilterOptions } from './search-pipeline.js';
import type { IndexerSearchService, SettingsService, IndexerService } from './index.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { serializeError } from '../utils/serialize-error.js';
import { SearchDeadlineError } from './search-deadline.js';


export interface ImmediateSearchDeps {
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  downloadOrchestrator: DownloadOrchestrator;
  settingsService: SettingsService;
  blacklistService: BlacklistService;
  eventHistory: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService | undefined;
}

export interface ImmediateSearchBook {
  id: number;
  title: string;
  duration?: number | null;
  audioDuration?: number | null;
  authors?: Array<{ name: string }> | null;
  narrators?: Array<{ name: string }> | null;
}

/**
 * Awaitable search; failures are contained the same way the detached wrapper contains them, so a
 * caller sequencing several books settles one before starting the next and one rejection cannot
 * break the chain.
 */
export async function runImmediateSearch(
  book: ImmediateSearchBook,
  deps: ImmediateSearchDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const [qualitySettings, metadataSettings, searchSettings] = await Promise.all([
      deps.settingsService.get('quality'),
      deps.settingsService.get('metadata'),
      deps.settingsService.get('search'),
    ]);
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
    await searchAndGrabForBook(book, {
      indexerSearchService: deps.indexerSearchService,
      downloadOrchestrator: deps.downloadOrchestrator,
      qualitySettings: buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
      log,
      blacklistService: deps.blacklistService,
      indexerService: deps.indexerService,
      eventHistory: deps.eventHistory,
      broadcaster: deps.eventBroadcaster,
    });
  } catch (error: unknown) {
    // budgetMs/bookId ride as siblings: serializeError emits a fixed key set and would drop them.
    if (error instanceof SearchDeadlineError) {
      log.warn({ error: serializeError(error), bookId: book.id, budgetMs: error.budgetMs }, 'Search-immediately trigger abandoned at its deadline');
      return;
    }
    log.warn({ error: serializeError(error), bookId: book.id }, 'Search-immediately trigger failed');
  }
}

/** Fire-and-forget search; failures are logged rather than propagated. */
export function triggerImmediateSearch(
  book: ImmediateSearchBook,
  deps: ImmediateSearchDeps,
  log: FastifyBaseLogger,
) {
  void runImmediateSearch(book, deps, log);
}
