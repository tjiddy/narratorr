import type { FastifyBaseLogger } from 'fastify';
import { searchAndGrabForBook, buildNarratorPriority } from './search-pipeline.js';
import type { IndexerSearchService, SettingsService, IndexerService } from './index.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { serializeError } from '../utils/serialize-error.js';


export interface ImmediateSearchDeps {
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  downloadOrchestrator: DownloadOrchestrator;
  settingsService: SettingsService;
  blacklistService: BlacklistService;
  eventHistory: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService | undefined;
}

/** Fire-and-forget: search indexers and grab the best result for a newly added book. */
export function triggerImmediateSearch(
  book: { id: number; title: string; duration?: number | null; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  deps: ImmediateSearchDeps,
  log: FastifyBaseLogger,
) {
  Promise.all([deps.settingsService.get('quality'), deps.settingsService.get('metadata'), deps.settingsService.get('search')])
    .then(async ([qualitySettings, metadataSettings, searchSettings]) => {
      const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
      await searchAndGrabForBook(book, {
        indexerSearchService: deps.indexerSearchService,
        downloadOrchestrator: deps.downloadOrchestrator,
        qualitySettings: { ...qualitySettings, languages: metadataSettings.languages, narratorPriority },
        log,
        blacklistService: deps.blacklistService,
        indexerService: deps.indexerService,
        eventHistory: deps.eventHistory,
        broadcaster: deps.eventBroadcaster,
      });
    })
    .catch((err: unknown) => {
      log.warn({ error: serializeError(err), bookId: book.id }, 'Search-immediately trigger failed');
    });
}
