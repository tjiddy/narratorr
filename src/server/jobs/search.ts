import type { FastifyBaseLogger } from 'fastify';
import type { SettingsService } from '../services/settings.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { RetryBudget } from '../services/retry-budget.js';
import type { SearchLadderCooldown } from '../services/search-ladder-cooldown.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { buildNarratorPriority, buildSearchFilterOptions, searchAndGrabForBook } from '../services/search-pipeline.js';
import { serializeError } from '../utils/serialize-error.js';


export interface SearchJobResult {
  searched: number;
  grabbed: number;
}

export interface SearchAllWantedResult {
  searched: number;
  grabbed: number;
  skipped: number;
  errors: number;
}

export async function runSearchJob(
  settingsService: SettingsService,
  bookListService: BookListService,
  indexerSearchService: IndexerSearchService,
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  indexerService: IndexerService,
  eventHistory: EventHistoryService,
  retryBudget?: RetryBudget,
  broadcaster?: EventBroadcasterService,
  searchLadderCooldown?: SearchLadderCooldown,
): Promise<SearchJobResult> {
  retryBudget?.resetAll();

  const searchSettings = await settingsService.get('search');
  if (!searchSettings.enabled) {
    log.debug('Scheduled search is disabled, skipping');
    return { searched: 0, grabbed: 0 };
  }

  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const { data: wantedBooks } = await bookListService.getAll('wanted');
  if (wantedBooks.length === 0) {
    log.debug('No wanted books to search for');
    return { searched: 0, grabbed: 0 };
  }

  log.info({ count: wantedBooks.length }, 'Starting scheduled search for wanted books');

  let searched = 0;
  let grabbed = 0;

  for (const book of wantedBooks) {
    try {
      const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
      const result = await searchAndGrabForBook(book, {
        indexerSearchService, downloadOrchestrator,
        qualitySettings: buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
        log, blacklistService, indexerService, eventHistory, broadcaster,
        // Only unattended searches use cooldown; manual searches must remain unaffected.
        searchLadderCooldown, ladderMode: 'scheduled',
      });
      searched++;
      if (result.result === 'grabbed') grabbed++;
      if (result.result === 'grab_error') {
        log.warn({ error: serializeError(result.error), bookId: book.id, title: book.title }, 'Search failed for book');
      }
    } catch (error: unknown) {
      log.warn({ error: serializeError(error), bookId: book.id, title: book.title }, 'Search failed for book');
    }
  }

  log.info({ searched, grabbed }, 'Scheduled search completed');
  return { searched, grabbed };
}

// Manual trigger: ignores searchSettings.enabled and never participates in ladder cooldown.
export async function searchAllWanted(
  settingsService: SettingsService,
  bookListService: BookListService,
  indexerSearchService: IndexerSearchService,
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  indexerService: IndexerService,
  eventHistory: EventHistoryService,
  broadcaster?: EventBroadcasterService,
): Promise<SearchAllWantedResult> {
  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const searchSettings = await settingsService.get('search');
  const { data: wantedBooks } = await bookListService.getAll('wanted');

  if (wantedBooks.length === 0) {
    log.debug('No wanted books to search for');
    return { searched: 0, grabbed: 0, skipped: 0, errors: 0 };
  }

  log.info({ count: wantedBooks.length }, 'Starting search-all-wanted');

  let searched = 0;
  let grabbed = 0;
  let skipped = 0;
  let errors = 0;

  for (const book of wantedBooks) {
    try {
      const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
      const result = await searchAndGrabForBook(book, {
        indexerSearchService, downloadOrchestrator,
        qualitySettings: buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
        log, blacklistService, indexerService, eventHistory, broadcaster,
      });
      searched++;
      if (result.result === 'grabbed') grabbed++;
      else if (result.result === 'skipped') skipped++;
      else if (result.result === 'grab_error') {
        errors++;
        log.warn({ error: serializeError(result.error), bookId: book.id, title: book.title }, 'Grab failed for book');
      }
    } catch (error: unknown) {
      errors++;
      log.warn({ error: serializeError(error), bookId: book.id, title: book.title }, 'Search failed for book');
    }
  }

  log.info({ searched, grabbed, skipped, errors }, 'Search-all-wanted completed');
  return { searched, grabbed, skipped, errors };
}
