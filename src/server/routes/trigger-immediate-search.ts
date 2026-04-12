import type { FastifyBaseLogger } from 'fastify';
import { searchAndGrabForBook, buildNarratorPriority } from '../services/search-pipeline.js';
import type { IndexerService, SettingsService } from '../services/index.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';

export interface ImmediateSearchDeps {
  indexerService?: IndexerService;
  downloadOrchestrator: DownloadOrchestrator;
  settingsService: SettingsService;
  blacklistService?: BlacklistService;
  eventBroadcaster?: EventBroadcasterService;
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
      await searchAndGrabForBook(book, deps.indexerService!, deps.downloadOrchestrator, { ...qualitySettings, languages: metadataSettings.languages, narratorPriority }, log, deps.blacklistService!, deps.eventBroadcaster);
    })
    .catch((err: unknown) => {
      log.warn({ error: err, bookId: book.id }, 'Search-immediately trigger failed');
    });
}
