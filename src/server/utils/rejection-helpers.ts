import type { FastifyBaseLogger } from 'fastify';
import type { BlacklistService } from '../services/blacklist.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { retrySearch, type RetrySearchDeps } from '../services/retry-search.js';
import type { BlacklistReason } from '../../shared/schemas/blacklist.js';

export interface BlacklistIdentifiers {
  infoHash?: string;
  guid?: string;
  title: string;
  bookId?: number;
}

export interface BlacklistAndRetryRequest {
  identifiers: BlacklistIdentifiers;
  reason: BlacklistReason;
  book: { id: number } | null;
  blacklistService?: BlacklistService;
  retrySearchDeps?: RetrySearchDeps;
  settingsService?: SettingsService;
  log: FastifyBaseLogger;
  /** When true, bypass the redownloadFailed setting and always trigger retry search. */
  overrideRetry?: boolean;
}

/**
 * Shared blacklist + fire-and-forget re-search logic.
 * Used by QualityGateOrchestrator (reject) and BookRejectionService (wrong-release).
 *
 * File deletion is NOT included — callers handle their own deletion strategy
 * (QGO deletes download artifacts, wrong-release deletes library files).
 */
export async function blacklistAndRetrySearch(request: BlacklistAndRetryRequest): Promise<void> {
  const { identifiers, reason, book, blacklistService, retrySearchDeps, settingsService, log, overrideRetry } = request;

  // Blacklist the release
  if ((identifiers.infoHash || identifiers.guid) && blacklistService) {
    try {
      await blacklistService.create({
        infoHash: identifiers.infoHash,
        guid: identifiers.guid,
        title: identifiers.title,
        bookId: identifiers.bookId,
        reason,
      });
      log.info({ infoHash: identifiers.infoHash, guid: identifiers.guid }, 'Blacklisted rejected release');
    } catch (error: unknown) {
      log.warn({ error }, 'Failed to blacklist release');
    }
  } else if (!identifiers.infoHash && !identifiers.guid) {
    log.info('Blacklist skipped — no infoHash or guid');
  }

  // Fire-and-forget re-search gated by redownloadFailed setting
  if (!book || !retrySearchDeps || !settingsService) {
    return;
  }

  const deps = retrySearchDeps;
  const bookId = book.id;
  settingsService.get('import').then((importSettings) => {
    if (overrideRetry || importSettings.redownloadFailed) {
      log.info({ bookId }, 'Triggering re-search after reject');
      retrySearch(bookId, deps).catch((error: unknown) => {
        log.warn({ bookId, error }, 'Re-search after reject failed');
      });
    }
  }).catch((error: unknown) => {
    log.warn({ error }, 'Failed to check redownloadFailed setting');
  });
}
